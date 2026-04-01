import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseCSharpTests } from './csharpParser';
import { readDiscoveryCache, writeDiscoveryCache } from './discoveryCache';
import {
	discoverProject,
	discoverWorkspaceTests,
	isIgnoredPath,
	runDotnetTarget as executeDotnetTarget,
	type DetailedTestResult,
	type DotnetCommandResult,
	type RunProgressStep,
	type RunDotnetTargetOptions,
} from './dotnet';
import { DotnetTestStore, formatRunnerMode, type DiscoveredProject, type DiscoveredSourceLocation, type DotnetTestNode, type DotnetTestsSnapshotNode, type MethodNode, type NodeStateUpdate, type ProjectNode, type RunSummary, type RunState } from './model';

export interface DotnetTestsApi {
	refresh(): Promise<void>;
	getSnapshot(): DotnetTestsSnapshotNode[];
	getSummary(): RunSummary | undefined;
	runNodeById(id: string): Promise<RunSummary | undefined>;
}

export function activate(context: vscode.ExtensionContext): DotnetTestsApi {
	const extension = new DotnetTestsExtension(context);
	context.subscriptions.push(extension);
	return extension;
}

export function deactivate() {}

const FILE_REFRESH_DELAY_MS = 750;
const DOCUMENT_REFRESH_DELAY_MS = 150;
const RECENT_SAVE_TTL_MS = 1000;
const SOURCE_TEST_MESSAGE_CONTEXT = 'dotnet-tests.source';

class DotnetTestsExtension implements vscode.Disposable, DotnetTestsApi {
	private readonly store = new DotnetTestStore();
	private readonly output = vscode.window.createOutputChannel('Dotnet Tests');
	private readonly controller = vscode.tests.createTestController('dotnet-tests.controller', 'Dotnet Tests');
	private readonly testItems = new Map<string, vscode.TestItem>();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly projectWatchers = new Map<string, vscode.Disposable>();
	private readonly projectDocumentRefreshHandles = new Map<string, NodeJS.Timeout>();
	private readonly projectRefreshHandles = new Map<string, NodeJS.Timeout>();
	private readonly queuedProjectRefreshes = new Set<string>();
	private readonly queuedLiveProjectRefreshes = new Set<string>();
	private readonly liveProjectOverrides = new Map<string, DiscoveredProject>();
	private readonly recentProjectSaveTimestamps = new Map<string, number>();
	private discoveredProjects: DiscoveredProject[] = [];
	private refreshPromise: Promise<void> | undefined;
	private refreshHandle: NodeJS.Timeout | undefined;
	private queuedFullRefresh = false;
	private queuedShowRefreshMessage = false;

	constructor(private readonly context: vscode.ExtensionContext) {
		const runProfile = this.controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, (request, token) => {
			void this.runRequest(request, token);
		}, true);

		this.controller.resolveHandler = async () => {
			if (!this.store.hasProjects()) {
				await this.refresh();
			}
		};

		this.disposables.push(
			runProfile,
			this.output,
			this.controller,
			vscode.commands.registerCommand('dotnet-tests.refresh', () => this.refresh(true)),
			vscode.commands.registerCommand('dotnet-tests.actions', () => this.showActions()),
			vscode.commands.registerCommand('dotnet-tests.openTestSource', (argument?: unknown) => this.openTestSource(argument)),
			vscode.commands.registerCommand('dotnet-tests.runAll', () => this.runAll()),
			vscode.commands.registerCommand('dotnet-tests.showOutput', () => this.output.show(true)),
			vscode.commands.registerCommand('dotnet-tests.runNode', (argument?: unknown) => this.runNode(argument)),
			vscode.commands.registerCommand('dotnet-tests.revealInTestExplorer', (argument?: unknown) => this.revealInTestExplorer(argument)),
			vscode.workspace.onDidChangeTextDocument(event => this.handleTextDocumentChange(event)),
			vscode.workspace.onDidSaveTextDocument(document => this.handleTextDocumentSave(document)),
			vscode.workspace.onDidCloseTextDocument(document => this.handleTextDocumentClose(document)),
			...this.createWatchers(),
		);

		this.context.subscriptions.push(...this.disposables);
		this.restoreDiscoveryCache();
		void this.refresh();
	}

	dispose(): void {
		if (this.refreshHandle) {
			clearTimeout(this.refreshHandle);
			this.refreshHandle = undefined;
		}

		this.clearProjectDocumentRefreshHandles();
		this.clearProjectRefreshHandles();
		this.disposeProjectWatchers();

		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	async refresh(showMessage = false): Promise<void> {
		this.queueFullRefresh(showMessage);
		return this.ensureRefreshLoop();
	}

	private ensureRefreshLoop(): Promise<void> {
		if (this.refreshPromise) {
			return this.refreshPromise;
		}

		this.refreshPromise = this.performQueuedRefreshes().finally(() => {
			this.refreshPromise = undefined;
		});

		return this.refreshPromise;
	}

	private async performQueuedRefreshes(): Promise<void> {
		while (this.queuedFullRefresh || this.queuedProjectRefreshes.size > 0 || this.queuedLiveProjectRefreshes.size > 0) {
			if (this.queuedFullRefresh) {
				const showMessage = this.queuedShowRefreshMessage;
				this.queuedFullRefresh = false;
				this.queuedShowRefreshMessage = false;
				this.queuedProjectRefreshes.clear();
				this.queuedLiveProjectRefreshes.clear();
				await this.performFullRefresh(showMessage);
				continue;
			}

			const projectPath = this.takeNextQueuedProjectRefresh();
			if (projectPath) {
				await this.performProjectRefresh(projectPath);
				continue;
			}

			const liveProjectPath = this.takeNextQueuedLiveProjectRefresh();
			if (liveProjectPath) {
				await this.performLiveProjectRefresh(liveProjectPath);
			}
		}
	}

	private async performFullRefresh(showMessage: boolean): Promise<void> {
		const projects = await discoverWorkspaceTests(this.output);
		this.applyDiscoveredProjects(projects);
		await this.persistDiscoveryCache(this.discoveredProjects);
		this.scheduleDirtyDocumentRefreshes();

		if (showMessage) {
			const message = projects.length === 0
				? 'No .NET test projects found in the workspace.'
				: `Discovered ${projects.length} .NET test project${projects.length === 1 ? '' : 's'}.`;
			void vscode.window.showInformationMessage(message);
		}
	}

	private async performProjectRefresh(projectPath: string): Promise<void> {
		if (!this.discoveredProjects.some(project => project.projectPath === projectPath)) {
			return;
		}

		try {
			const project = await discoverProject(projectPath, this.output);
			this.applyProjectRefresh(projectPath, project);
			await this.persistDiscoveryCache(this.discoveredProjects);
			this.scheduleDirtyDocumentRefreshes(projectPath);
		} catch (error) {
			this.output.appendLine(`Failed to refresh project ${projectPath}: ${getErrorMessage(error)}`);
		}
	}

	private async performLiveProjectRefresh(projectPath: string): Promise<void> {
		const project = this.discoveredProjects.find(entry => entry.projectPath === projectPath);
		if (!project) {
			return;
		}

		const fileContents = this.collectProjectDocumentOverrides(projectPath);
		if (fileContents.size === 0) {
			this.applyLiveProjectRefresh(projectPath, undefined);
			return;
		}

		try {
			const classes = await parseCSharpTests(projectPath, { fileContents });
			this.applyLiveProjectRefresh(projectPath, {
				...project,
				classes,
			});
		} catch (error) {
			this.output.appendLine(`Failed to refresh edited project ${projectPath}: ${getErrorMessage(error)}`);
		}
	}

	private restoreDiscoveryCache(): void {
		const projects = readDiscoveryCache(this.context.workspaceState);
		if (!projects || projects.length === 0) {
			return;
		}

		this.applyDiscoveredProjects(projects);
		this.output.appendLine(`Restored cached discovery for ${projects.length} .NET test project${projects.length === 1 ? '' : 's'}.`);
	}

	private async persistDiscoveryCache(projects: DiscoveredProject[]): Promise<void> {
		try {
			await writeDiscoveryCache(this.context.workspaceState, projects);
		} catch (error) {
			this.output.appendLine(`Failed to update discovery cache: ${getErrorMessage(error)}`);
		}
	}

	private syncTestItems(): void {
		this.testItems.clear();
		const roots = this.store.getRoots().map(node => this.createTestItem(node));
		this.controller.items.replace(roots);
	}

	private applyDiscoveredProjects(projects: DiscoveredProject[]): void {
		this.discoveredProjects = [...projects];
		this.liveProjectOverrides.clear();
		this.store.setSnapshot(projects);
		this.store.setSummary(undefined);
		this.syncProjectWatchers();
		this.syncTestItems();
	}

	private applyProjectRefresh(projectPath: string, project: DiscoveredProject | undefined): void {
		this.discoveredProjects = [
			...this.discoveredProjects.filter(entry => entry.projectPath !== projectPath),
			...(project ? [project] : []),
		];
		this.liveProjectOverrides.delete(projectPath);

		if (project) {
			this.store.setProjectSnapshot(project);
		} else {
			this.store.removeProject(projectPath);
		}

		this.store.setSummary(undefined);
		this.syncProjectWatchers();
		this.syncTestItems();
	}

	private applyLiveProjectRefresh(projectPath: string, project: DiscoveredProject | undefined): void {
		if (project) {
			this.liveProjectOverrides.set(projectPath, project);
		} else {
			this.liveProjectOverrides.delete(projectPath);
		}

		const displayedProject = this.liveProjectOverrides.get(projectPath)
			?? this.discoveredProjects.find(entry => entry.projectPath === projectPath);

		if (displayedProject) {
			this.store.setProjectSnapshot(displayedProject);
		} else {
			this.store.removeProject(projectPath);
		}

		this.store.setSummary(undefined);
		this.syncTestItems();
	}

	private handleTextDocumentChange(event: vscode.TextDocumentChangeEvent): void {
		if (event.contentChanges.length === 0) {
			return;
		}

		const projectPath = this.getTrackedProjectPathForDocument(event.document);
		if (!projectPath) {
			return;
		}

		this.scheduleDocumentRefresh(projectPath);
	}

	private handleTextDocumentSave(document: vscode.TextDocument): void {
		const projectPath = this.getTrackedProjectPathForDocument(document);
		if (!projectPath) {
			return;
		}

		this.recentProjectSaveTimestamps.set(projectPath, Date.now());
		this.clearProjectDocumentRefreshHandle(projectPath);
		this.queuedLiveProjectRefreshes.delete(projectPath);
		this.queueProjectRefresh(projectPath);
		void this.ensureRefreshLoop();
	}

	private handleTextDocumentClose(document: vscode.TextDocument): void {
		const projectPath = this.getTrackedProjectPathForDocument(document);
		if (
			!projectPath
			|| this.wasProjectSavedRecently(projectPath)
			|| (!this.liveProjectOverrides.has(projectPath) && !this.projectDocumentRefreshHandles.has(projectPath))
		) {
			return;
		}

		this.scheduleDocumentRefresh(projectPath);
	}

	private scheduleDirtyDocumentRefreshes(projectPath?: string): void {
		for (const dirtyProjectPath of this.collectDirtyProjectPaths(projectPath)) {
			this.queueLiveProjectRefresh(dirtyProjectPath);
		}
	}

	private collectDirtyProjectPaths(projectPath?: string): Set<string> {
		const dirtyProjectPaths = new Set<string>();
		for (const document of vscode.workspace.textDocuments) {
			if (!document.isDirty) {
				continue;
			}

			const dirtyProjectPath = this.getTrackedProjectPathForDocument(document);
			if (!dirtyProjectPath) {
				continue;
			}

			if (projectPath && dirtyProjectPath !== projectPath) {
				continue;
			}

			dirtyProjectPaths.add(dirtyProjectPath);
		}

		return dirtyProjectPaths;
	}

	private collectProjectDocumentOverrides(projectPath: string): Map<string, string> {
		const fileContents = new Map<string, string>();
		for (const document of vscode.workspace.textDocuments) {
			if (!document.isDirty) {
				continue;
			}

			if (this.getTrackedProjectPathForDocument(document) !== projectPath) {
				continue;
			}

			fileContents.set(document.uri.fsPath, document.getText());
		}

		return fileContents;
	}

	private createTestItem(node: DotnetTestNode): vscode.TestItem {
		const sourceTarget = createNavigationTargetFromNode(node);
		const uri = sourceTarget?.uri ?? (node.kind === 'project' ? node.projectUri : undefined);
		const item = this.controller.createTestItem(node.id, node.label, uri);
		item.range = sourceTarget?.range;
		item.description = createTestItemDescription(node);
		this.testItems.set(node.id, item);

		for (const child of this.store.getChildren(node)) {
			item.children.add(this.createTestItem(child));
		}

		return item;
	}

	private async runAll(): Promise<void> {
		const projects = this.store.getRoots();
		if (projects.length === 0) {
			await this.refresh(true);
			return;
		}

		await this.runNodes(projects, 'Run All Tests');
	}

	private async runNode(argument?: unknown): Promise<void> {
		const node = this.resolveNode(argument) ?? await this.pickNode('Select a .NET test target to run');
		if (!node) {
			return;
		}

		await this.runNodes([node], `Run ${node.label}`);
	}

	private async runNodes(nodes: readonly DotnetTestNode[], label: string): Promise<void> {
		const include = nodes
			.map(node => this.testItems.get(node.id))
			.filter((item): item is vscode.TestItem => item !== undefined);

		const request = include.length > 0 ? new vscode.TestRunRequest(include) : new vscode.TestRunRequest();
		const run = this.controller.createTestRun(request, label);

		try {
			await this.executeTargets(nodes.map(node => node.id), run);
		} finally {
			run.end();
		}
	}

	private async runRequest(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
		const run = this.controller.createTestRun(request);

		try {
			await this.executeTargets(this.getRequestTargetIds(request), run, token);
		} finally {
			run.end();
		}
	}

	private async executeTargets(
		targetIds: readonly string[],
		run: vscode.TestRun,
		token?: vscode.CancellationToken,
	): Promise<void> {
		const nodes = this.normalizeTargets(targetIds);
		if (nodes.length === 0) {
			return;
		}

		const aggregate = createAggregateSummary(nodes.length === 1 ? `Run ${nodes[0].label}` : 'Run .NET Tests', nodes);

		for (const node of nodes) {
			if (token?.isCancellationRequested) {
				break;
			}

			const item = this.testItems.get(node.id);
			if (item) {
				run.enqueued(item);
				run.started(item);
			}

			const methodTracker = createLiveMethodRunTracker(
				this.store.getDescendantMethods(node),
				node.kind === 'method' && item ? [node.id] : [],
			);
			this.startTargetRunState(node, methodTracker, run);
			run.appendOutput(`> ${node.label}\r\n`);

			try {
				const result = await this.runTrackedTarget(node, methodTracker, run, token);
				const message = formatNodeSummary(result.summary, result.status);
				const unreportedMethodCompletion = createUnreportedMethodCompletion(result.status);
				const detailedResultMethodIds = this.applyDetailedResults(node, result, run, message, methodTracker);
				this.completeUnreportedMethods(
					methodTracker,
					collectReportedMethodIds(methodTracker, detailedResultMethodIds),
					run,
					unreportedMethodCompletion.state,
					unreportedMethodCompletion.message,
				);

				const appliedDetailedResults = detailedResultMethodIds !== undefined;
				if (!appliedDetailedResults) {
					this.store.setNodeState(node.id, result.status, message);
					if (item) {
						updateTestRunItem(run, item, result.status, message, result.summary.durationMs);
					}
				}

				run.appendOutput(`${message}\r\n`);
				updateAggregateSummary(aggregate, result.summary, result.status);
			} catch (error) {
				if (token?.isCancellationRequested) {
					this.completeUnreportedMethods(
						methodTracker,
						collectReportedMethodIds(methodTracker),
						run,
						'skipped',
						'Cancelled',
					);
					if (item) {
						run.skipped(item);
					}
					this.store.setNodeState(node.id, 'skipped', 'Cancelled');
					break;
				}

				const message = error instanceof Error ? error.message : String(error);
				this.completeUnreportedMethods(
					methodTracker,
					collectReportedMethodIds(methodTracker),
					run,
					'errored',
					message,
				);
				this.store.setNodeState(node.id, 'errored', message);

				if (item) {
						run.errored(item, createTestRunMessage(message, item));
				}

				run.appendOutput(`${message}\r\n`);
				aggregate.failed += 1;
				aggregate.total += 1;
				aggregate.status = 'errored';
			}
		}

		aggregate.status = determineSummaryStatus(aggregate);
		this.store.setSummary(aggregate);
	}

	private runTrackedTarget(
		node: DotnetTestNode,
		tracker: LiveMethodRunTracker,
		run: vscode.TestRun,
		token?: vscode.CancellationToken,
	): Promise<DotnetCommandResult> {
		const progressReporter = this.createRunProgressReporter(run);
		progressReporter.reportStep('starting');
		const runOptions: RunDotnetTargetOptions = {
			token,
			onProgress: step => progressReporter.reportStep(step),
			onTestResult: testResult => {
				progressReporter.reportStep('results');
				this.applyLiveMethodResult(tracker, testResult, run);
			},
		};

		return executeDotnetTarget(
			node,
			this.output,
			runOptions as RunDotnetTargetOptions & vscode.CancellationToken,
		);
	}

	private createRunProgressReporter(run: vscode.TestRun): RunProgressReporter {
		let lastReportedStepOrder = -1;
		return {
			reportStep(step: RunProgressMessageStep): void {
				const stepOrder = getRunProgressStepOrder(step);
				if (stepOrder <= lastReportedStepOrder) {
					return;
				}

				lastReportedStepOrder = stepOrder;
				run.appendOutput(`${createRunProgressMessage(step)}\r\n`);
			},
		};
	}

	private startTargetRunState(
		node: DotnetTestNode,
		tracker: LiveMethodRunTracker,
		run: vscode.TestRun,
	): void {
		const methods = tracker.resolver.targetMethods;
		if (methods.length === 0) {
			this.store.setNodeState(node.id, 'running', undefined);
			return;
		}

		this.store.setSubtreeState(node.id, 'running', undefined);

		for (const method of methods) {
			const item = this.testItems.get(method.id);
			if (item) {
				this.ensureMethodItemStarted(tracker, method.id, run, item);
			}
		}
	}

	private applyLiveMethodResult(
		tracker: LiveMethodRunTracker,
		testResult: DetailedTestResult,
		run: vscode.TestRun,
	): void {
		const methodResult = trackLiveMethodResult(tracker, testResult);
		if (!methodResult) {
			return;
		}

		this.store.applyNodeUpdates([{
			id: methodResult.method.id,
			state: methodResult.state,
			message: methodResult.message,
		}]);

		const item = this.testItems.get(methodResult.method.id);
		if (!item) {
			return;
		}

		this.ensureMethodItemStarted(tracker, methodResult.method.id, run, item);
		updateTestRunItem(run, item, methodResult.state, methodResult.message, methodResult.durationMs);
	}

	private applyDetailedResults(
		node: DotnetTestNode,
		result: DotnetCommandResult,
		run: vscode.TestRun,
		summaryMessage: string,
		tracker: LiveMethodRunTracker,
	): ReadonlySet<string> | undefined {
		const methodResults = resolveMethodRunResults(tracker.resolver.targetMethods, result.testResults);
		if (!methodResults) {
			return undefined;
		}

		const updates: NodeStateUpdate[] = this.collectAncestorIds(methodResults.map(entry => entry.method))
			.map(id => ({ id, message: undefined }));

		for (const methodResult of methodResults) {
			updates.push({
				id: methodResult.method.id,
				state: methodResult.state,
				message: methodResult.message,
			});
		}

		if (node.kind !== 'method') {
			updates.push({ id: node.id, message: summaryMessage });
		}

		this.store.applyNodeUpdates(updates);

		for (const methodResult of methodResults) {
			const item = this.testItems.get(methodResult.method.id);
			if (item) {
				this.ensureMethodItemStarted(tracker, methodResult.method.id, run, item);
				updateTestRunItem(run, item, methodResult.state, methodResult.message, methodResult.durationMs);
			}
		}

		const scopeItem = this.testItems.get(node.id);
		if (scopeItem && node.kind !== 'method') {
			updateTestRunItem(run, scopeItem, result.status, summaryMessage, result.summary.durationMs);
		}

		return new Set(methodResults.map(methodResult => methodResult.method.id));
	}

	private completeUnreportedMethods(
		tracker: LiveMethodRunTracker,
		reportedMethodIds: ReadonlySet<string>,
		run: vscode.TestRun,
		state: Exclude<RunState, 'idle' | 'queued' | 'running'>,
		message: string,
	): void {
		const unresolvedMethods = tracker.resolver.targetMethods
			.filter(method => !reportedMethodIds.has(method.id));
		if (unresolvedMethods.length === 0) {
			return;
		}

		this.store.applyNodeUpdates(unresolvedMethods.map(method => ({
			id: method.id,
			state,
			message,
		})));

		for (const method of unresolvedMethods) {
			const item = this.testItems.get(method.id);
			if (!item) {
				continue;
			}

			this.ensureMethodItemStarted(tracker, method.id, run, item);
			updateTestRunItem(run, item, state, message);
		}
	}

	private ensureMethodItemStarted(
		tracker: LiveMethodRunTracker,
		methodId: string,
		run: vscode.TestRun,
		item: vscode.TestItem,
	): void {
		if (tracker.startedMethodIds.has(methodId)) {
			return;
		}

		tracker.startedMethodIds.add(methodId);
		run.enqueued(item);
		run.started(item);
	}

	private collectAncestorIds(methods: readonly MethodNode[]): string[] {
		const ancestorIds = new Set<string>();

		for (const method of methods) {
			let currentId = method.parentId;
			while (currentId) {
				ancestorIds.add(currentId);
				currentId = this.store.getNode(currentId)?.parentId;
			}
		}

		return [...ancestorIds];
	}

	private getRequestTargetIds(request: vscode.TestRunRequest): string[] {
		const includedIds = request.include?.map(item => item.id) ?? this.store.getRoots().map(node => node.id);
		const excludedIds = new Set(request.exclude?.map(item => item.id) ?? []);

		return includedIds.filter(id => !excludedIds.has(id));
	}

	private normalizeTargets(targetIds: readonly string[]): DotnetTestNode[] {
		const uniqueIds = [...new Set(targetIds)];
		const selectedIds = new Set(uniqueIds);
		const normalizedIds = uniqueIds.filter(id => {
			let parentId = this.store.getNode(id)?.parentId;
			while (parentId) {
				if (selectedIds.has(parentId)) {
					return false;
				}
				parentId = this.store.getNode(parentId)?.parentId;
			}

			return true;
		});

		return normalizedIds
			.map(id => this.store.getNode(id))
			.filter((node): node is DotnetTestNode => node !== undefined);
	}

	private resolveNode(argument?: unknown): DotnetTestNode | undefined {
		if (typeof argument === 'string') {
			return this.store.getNode(argument);
		}

		if (isNodeLike(argument)) {
			return this.store.getNode(argument.id) ?? argument;
		}

		return undefined;
	}

	private async pickNode(placeHolder: string): Promise<DotnetTestNode | undefined> {
		if (!(await this.ensureProjectsDiscovered())) {
			return undefined;
		}

		const pick = await vscode.window.showQuickPick(this.createNodePicks(), {
			placeHolder,
			matchOnDescription: true,
			matchOnDetail: true,
		});

		return pick?.node;
	}

	private async ensureProjectsDiscovered(): Promise<boolean> {
		if (this.store.hasProjects()) {
			return true;
		}

		await this.refresh(true);
		return this.store.hasProjects();
	}

	private createNodePicks(): NodePick[] {
		const picks: NodePick[] = [];
		for (const project of this.store.getRoots()) {
			this.appendNodePick(project, picks);
		}

		return picks;
	}

	private createSourceNodePicks(): NodePick[] {
		const picks: NodePick[] = [];
		for (const project of this.store.getRoots()) {
			this.appendSourceNodePick(project, picks);
		}

		return picks;
	}

	private appendNodePick(node: DotnetTestNode, picks: NodePick[]): void {
		picks.push({
			label: node.label,
			description: createNodePickDescription(node, this.store),
			detail: createNodePickDetail(node),
			node,
		});

		for (const child of this.store.getChildren(node)) {
			this.appendNodePick(child, picks);
		}
	}

	private appendSourceNodePick(node: DotnetTestNode, picks: NodePick[]): void {
		if (node.kind !== 'project' && node.sourceLocation) {
			picks.push({
				label: node.label,
				description: createNodePickDescription(node, this.store),
				detail: createNodePickDetail(node),
				node,
			});
		}

		for (const child of this.store.getChildren(node)) {
			this.appendSourceNodePick(child, picks);
		}
	}

	private async showActions(): Promise<void> {
		const picks: ActionPick[] = [
			{
				label: 'Refresh discovered tests',
				detail: 'Re-scan the workspace and rediscover test projects and methods.',
				run: () => this.refresh(true),
			},
			{
				label: 'Run all tests',
				detail: 'Run every discovered .NET test project in this workspace.',
				run: () => this.runAll(),
			},
			{
				label: 'Run a discovered test target',
				detail: 'Pick a discovered project, class, or method to run.',
				run: () => this.runNode(),
			},
			{
				label: 'Open a discovered test source',
				detail: 'Pick a discovered test class or method and open its source location.',
				run: () => this.openTestSource(),
			},
			{
				label: 'Reveal a discovered test target',
				detail: 'Pick a discovered project, class, or method and reveal it in the Testing view.',
				run: () => this.revealInTestExplorer(),
			},
			{
				label: 'Show output',
				detail: 'Open the Dotnet Tests output channel.',
				run: async () => this.output.show(true),
			},
		];

		const pick = await vscode.window.showQuickPick(picks, {
			placeHolder: 'Choose a Dotnet Tests action',
		});

		if (pick) {
			await pick.run();
		}
	}

	private async revealInTestExplorer(argument?: unknown): Promise<void> {
		const node = this.resolveNode(argument) ?? await this.pickNode('Select a .NET test target to reveal');
		if (!node) {
			return;
		}

		const item = this.testItems.get(node.id);
		if (!item) {
			return;
		}

		await vscode.commands.executeCommand('vscode.revealTestInExplorer', item);
	}

	private async openTestSource(argument?: unknown): Promise<void> {
		const target = this.resolveNavigationTarget(argument) ?? await this.pickSourceNavigationTarget();
		if (!target) {
			return;
		}

		await openNavigationTarget(target);
	}

	private resolveNavigationTarget(argument?: unknown): NavigationTarget | undefined {
		if (isTestMessageCommandArgument(argument)) {
			const messageTarget = createNavigationTargetFromLocation(argument.message?.location);
			if (messageTarget) {
				return messageTarget;
			}

			if (argument.test) {
				return this.resolveNodeNavigationTarget(argument.test);
			}
		}

		return this.resolveNodeNavigationTarget(argument);
	}

	private resolveNodeNavigationTarget(argument?: unknown): NavigationTarget | undefined {
		const node = this.resolveNode(argument);
		return node ? createNavigationTargetFromNode(node) : undefined;
	}

	private async pickSourceNavigationTarget(): Promise<NavigationTarget | undefined> {
		if (!(await this.ensureProjectsDiscovered())) {
			return undefined;
		}

		const picks = this.createSourceNodePicks();
		if (picks.length === 0) {
			void vscode.window.showInformationMessage('No discovered .NET test classes or methods with source locations are available.');
			return undefined;
		}

		const pick = await vscode.window.showQuickPick(picks, {
			placeHolder: 'Select a .NET test class or method to open',
			matchOnDescription: true,
			matchOnDetail: true,
		});

		return pick ? createNavigationTargetFromNode(pick.node) : undefined;
	}

	private syncProjectWatchers(): void {
		const activeProjectPaths = new Set(this.discoveredProjects.map(project => project.projectPath));
		for (const [projectPath, watcher] of this.projectWatchers) {
			if (activeProjectPaths.has(projectPath)) {
				continue;
			}

			watcher.dispose();
			this.projectWatchers.delete(projectPath);
			this.clearProjectDocumentRefreshHandle(projectPath);
			this.clearProjectRefreshHandle(projectPath);
			this.queuedLiveProjectRefreshes.delete(projectPath);
			this.liveProjectOverrides.delete(projectPath);
			this.queuedProjectRefreshes.delete(projectPath);
		}

		for (const project of this.discoveredProjects) {
			if (this.projectWatchers.has(project.projectPath)) {
				continue;
			}

			this.projectWatchers.set(project.projectPath, this.createProjectWatcher(project.projectPath));
		}
	}

	private createProjectWatcher(projectPath: string): vscode.Disposable {
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(projectPath), '**/*.cs'));
		const schedule = (uri: vscode.Uri) => {
			if (isIgnoredPath(uri.fsPath)) {
				return;
			}

			if (this.getOwningProjectPathForFile(uri.fsPath) !== projectPath) {
				return;
			}

			this.scheduleProjectRefresh(projectPath);
		};
		const scheduleChangedFile = (uri: vscode.Uri) => {
			if (this.hasOpenFileDocument(uri.fsPath)) {
				return;
			}

			schedule(uri);
		};

		watcher.onDidCreate(schedule);
		watcher.onDidChange(scheduleChangedFile);
		watcher.onDidDelete(schedule);
		return watcher;
	}

	private createWatchers(): vscode.Disposable[] {
		const patterns = ['**/*.csproj', '**/*.sln', '**/global.json', '**/Directory.Build.props', '**/*.runsettings'];
		return patterns.map(pattern => {
			const watcher = vscode.workspace.createFileSystemWatcher(pattern);
			const schedule = () => this.scheduleRefresh();
			watcher.onDidCreate(schedule, this, this.context.subscriptions);
			watcher.onDidChange(schedule, this, this.context.subscriptions);
			watcher.onDidDelete(schedule, this, this.context.subscriptions);
			return watcher;
		});
	}

	private scheduleRefresh(): void {
		if (this.refreshHandle) {
			clearTimeout(this.refreshHandle);
		}

		this.refreshHandle = setTimeout(() => {
			this.refreshHandle = undefined;
			this.queueFullRefresh();
			void this.ensureRefreshLoop();
		}, FILE_REFRESH_DELAY_MS);
	}

	private scheduleDocumentRefresh(projectPath: string): void {
		const existingHandle = this.projectDocumentRefreshHandles.get(projectPath);
		if (existingHandle) {
			clearTimeout(existingHandle);
		}

		const handle = setTimeout(() => {
			this.projectDocumentRefreshHandles.delete(projectPath);
			this.queueLiveProjectRefresh(projectPath);
			void this.ensureRefreshLoop();
		}, DOCUMENT_REFRESH_DELAY_MS);

		this.projectDocumentRefreshHandles.set(projectPath, handle);
	}

	private scheduleProjectRefresh(projectPath: string): void {
		const existingHandle = this.projectRefreshHandles.get(projectPath);
		if (existingHandle) {
			clearTimeout(existingHandle);
		}

		const handle = setTimeout(() => {
			this.projectRefreshHandles.delete(projectPath);
			this.queueProjectRefresh(projectPath);
			void this.ensureRefreshLoop();
		}, FILE_REFRESH_DELAY_MS);

		this.projectRefreshHandles.set(projectPath, handle);
	}

	private queueFullRefresh(showMessage = false): void {
		if (this.refreshHandle) {
			clearTimeout(this.refreshHandle);
			this.refreshHandle = undefined;
		}

		this.clearProjectDocumentRefreshHandles();
		this.clearProjectRefreshHandles();
		this.queuedLiveProjectRefreshes.clear();
		this.queuedProjectRefreshes.clear();
		this.queuedFullRefresh = true;
		this.queuedShowRefreshMessage = this.queuedShowRefreshMessage || showMessage;
	}

	private queueProjectRefresh(projectPath: string): void {
		if (this.queuedFullRefresh || !this.discoveredProjects.some(project => project.projectPath === projectPath)) {
			return;
		}

		this.queuedProjectRefreshes.add(projectPath);
	}

	private queueLiveProjectRefresh(projectPath: string): void {
		if (
			this.queuedFullRefresh
			|| this.queuedProjectRefreshes.has(projectPath)
			|| !this.discoveredProjects.some(project => project.projectPath === projectPath)
		) {
			return;
		}

		this.queuedLiveProjectRefreshes.add(projectPath);
	}

	private takeNextQueuedProjectRefresh(): string | undefined {
		const next = this.queuedProjectRefreshes.values().next();
		if (next.done) {
			return undefined;
		}

		this.queuedProjectRefreshes.delete(next.value);
		return next.value;
	}

	private takeNextQueuedLiveProjectRefresh(): string | undefined {
		const next = this.queuedLiveProjectRefreshes.values().next();
		if (next.done) {
			return undefined;
		}

		this.queuedLiveProjectRefreshes.delete(next.value);
		return next.value;
	}

	private clearProjectDocumentRefreshHandles(): void {
		for (const projectPath of [...this.projectDocumentRefreshHandles.keys()]) {
			this.clearProjectDocumentRefreshHandle(projectPath);
		}
	}

	private clearProjectDocumentRefreshHandle(projectPath: string): void {
		const handle = this.projectDocumentRefreshHandles.get(projectPath);
		if (!handle) {
			return;
		}

		clearTimeout(handle);
		this.projectDocumentRefreshHandles.delete(projectPath);
	}

	private clearProjectRefreshHandles(): void {
		for (const projectPath of [...this.projectRefreshHandles.keys()]) {
			this.clearProjectRefreshHandle(projectPath);
		}
	}

	private clearProjectRefreshHandle(projectPath: string): void {
		const handle = this.projectRefreshHandles.get(projectPath);
		if (!handle) {
			return;
		}

		clearTimeout(handle);
		this.projectRefreshHandles.delete(projectPath);
	}

	private disposeProjectWatchers(): void {
		for (const watcher of this.projectWatchers.values()) {
			watcher.dispose();
		}

		this.projectWatchers.clear();
	}

	private hasOpenFileDocument(filePath: string): boolean {
		return vscode.workspace.textDocuments.some(document => normalizeFsPath(document.uri.fsPath) === normalizeFsPath(filePath));
	}

	private getOwningProjectPathForFile(filePath: string): string | undefined {
		let matchedProjectPath: string | undefined;
		let matchedDirectoryLength = -1;

		for (const project of this.discoveredProjects) {
			const projectDirectory = path.dirname(project.projectPath);
			if (!isPathWithinDirectory(filePath, projectDirectory)) {
				continue;
			}

			const directoryLength = normalizeFsPath(projectDirectory).length;
			if (directoryLength > matchedDirectoryLength) {
				matchedProjectPath = project.projectPath;
				matchedDirectoryLength = directoryLength;
			}
		}

		return matchedProjectPath;
	}

	private getTrackedProjectPathForDocument(document: vscode.TextDocument): string | undefined {
		if (document.uri.scheme !== 'file' || !document.uri.fsPath.toLowerCase().endsWith('.cs')) {
			return undefined;
		}

		return this.getOwningProjectPathForFile(document.uri.fsPath);
	}

	private wasProjectSavedRecently(projectPath: string): boolean {
		const savedAt = this.recentProjectSaveTimestamps.get(projectPath);
		if (!savedAt) {
			return false;
		}

		if (Date.now() - savedAt <= RECENT_SAVE_TTL_MS) {
			return true;
		}

		this.recentProjectSaveTimestamps.delete(projectPath);
		return false;
	}

	getSnapshot(): DotnetTestsSnapshotNode[] {
		return this.store.getSnapshot();
	}

	getSummary(): RunSummary | undefined {
		return this.store.getSummary();
	}

	async runNodeById(id: string): Promise<RunSummary | undefined> {
		const node = this.store.getNode(id);
		if (!node) {
			return undefined;
		}

		await this.runNodes([node], `Run ${node.label}`);
		return this.store.getSummary();
	}
}

interface ActionPick extends vscode.QuickPickItem {
	run: () => Promise<void>;
}

interface NodePick extends vscode.QuickPickItem {
	node: DotnetTestNode;
}

interface NavigationTarget {
	uri: vscode.Uri;
	range?: vscode.Range;
}

interface TestMessageCommandArgument {
	test?: { id: string };
	message?: vscode.TestMessage;
}

interface MethodRunResult {
	method: MethodNode;
	state: RunState;
	message: string;
	durationMs?: number;
}

interface MethodResultResolver {
	targetMethods: readonly MethodNode[];
	exactMatches: ReadonlyMap<string, MethodNode>;
	labelMatches: ReadonlyMap<string, MethodNode[]>;
}

interface LiveMethodRunTracker {
	resolver: MethodResultResolver;
	resultsByMethodId: Map<string, DetailedTestResult[]>;
	startedMethodIds: Set<string>;
}

type RunProgressMessageStep = RunProgressStep | 'starting' | 'results';

interface RunProgressReporter {
	reportStep(step: RunProgressMessageStep): void;
}

function createAggregateSummary(label: string, nodes: readonly DotnetTestNode[]): RunSummary {
	return {
		label,
		total: 0,
		passed: 0,
		failed: 0,
		skipped: 0,
		projectCount: new Set(nodes.map(node => node.projectPath)).size,
		status: 'idle',
	};
}

function collectReportedMethodIds(
	tracker: LiveMethodRunTracker,
	detailedResultMethodIds?: ReadonlySet<string>,
): Set<string> {
	const reportedMethodIds = new Set<string>(tracker.resultsByMethodId.keys());
	for (const methodId of detailedResultMethodIds ?? []) {
		reportedMethodIds.add(methodId);
	}

	return reportedMethodIds;
}

export function createUnreportedMethodCompletion(
	state: Exclude<RunState, 'idle' | 'queued' | 'running'>,
): { state: Exclude<RunState, 'idle' | 'queued' | 'running'>; message: string } {
	const completionState = state === 'errored' ? 'errored' : 'skipped';

	return {
		state: completionState,
		message: formatRunState(completionState),
	};
}

function updateAggregateSummary(summary: RunSummary, resultSummary: RunSummary, status: RunState): void {
	if (resultSummary.total > 0) {
		summary.total += resultSummary.total;
		summary.passed += resultSummary.passed;
		summary.failed += resultSummary.failed;
		summary.skipped += resultSummary.skipped;
	} else {
		summary.total += 1;
		if (status === 'passed') {
			summary.passed += 1;
		} else if (status === 'failed' || status === 'errored') {
			summary.failed += 1;
		}
	}

	if (resultSummary.durationMs) {
		summary.durationMs = (summary.durationMs ?? 0) + resultSummary.durationMs;
	}
	if (status === 'errored') {
		summary.status = 'errored';
	}
}

function determineSummaryStatus(summary: RunSummary): RunSummary['status'] {
	if (summary.status === 'errored') {
		return 'errored';
	}

	if (summary.failed > 0) {
		return 'failed';
	}

	if (summary.passed > 0) {
		return 'passed';
	}

	if (summary.skipped > 0) {
		return 'skipped';
	}

	return 'idle';
}

function resolveMethodRunResults(
	targetMethods: readonly MethodNode[],
	testResults: readonly DetailedTestResult[],
): MethodRunResult[] | undefined {
	if (targetMethods.length === 0 || testResults.length === 0) {
		return undefined;
	}

	const resolver = createMethodResultResolver(targetMethods);
	const resultsByMethodId = new Map<string, DetailedTestResult[]>();
	for (const testResult of testResults) {
		const method = resolveMethodForTestResult(testResult, resolver);
		if (!method) {
			continue;
		}

		const matches = resultsByMethodId.get(method.id) ?? [];
		matches.push(testResult);
		resultsByMethodId.set(method.id, matches);
	}

	if (resultsByMethodId.size === 0) {
		return undefined;
	}

	const resolved = targetMethods
		.map(method => {
			const matches = resultsByMethodId.get(method.id);
			return matches ? aggregateMethodRunResult(method, matches) : undefined;
		})
		.filter((result): result is MethodRunResult => result !== undefined);

	return resolved.length > 0 ? resolved : undefined;
}

function createMethodResultResolver(targetMethods: readonly MethodNode[]): MethodResultResolver {
	const exactMatches = new Map<string, MethodNode>();
	const labelMatches = new Map<string, MethodNode[]>();

	for (const method of targetMethods) {
		exactMatches.set(normalizeTestIdentifier(method.fullyQualifiedName ?? method.label), method);
		const labelKey = normalizeTestIdentifier(method.label);
		const methods = labelMatches.get(labelKey) ?? [];
		methods.push(method);
		labelMatches.set(labelKey, methods);
	}

	return {
		targetMethods,
		exactMatches,
		labelMatches,
	};
}

function createLiveMethodRunTracker(
	targetMethods: readonly MethodNode[],
	startedMethodIds: readonly string[],
): LiveMethodRunTracker {
	return {
		resolver: createMethodResultResolver(targetMethods),
		resultsByMethodId: new Map<string, DetailedTestResult[]>(),
		startedMethodIds: new Set(startedMethodIds),
	};
}

function trackLiveMethodResult(
	tracker: LiveMethodRunTracker,
	testResult: DetailedTestResult,
): MethodRunResult | undefined {
	const method = resolveMethodForTestResult(testResult, tracker.resolver);
	if (!method) {
		return undefined;
	}

	const matches = tracker.resultsByMethodId.get(method.id) ?? [];
	matches.push(testResult);
	tracker.resultsByMethodId.set(method.id, matches);

	return aggregateMethodRunResult(method, matches);
}

function resolveMethodForTestResult(
	testResult: DetailedTestResult,
	resolver: MethodResultResolver,
): MethodNode | undefined {
	const { targetMethods, exactMatches, labelMatches } = resolver;
	const candidates = [testResult.fullyQualifiedName, testResult.name]
		.filter((value): value is string => Boolean(value))
		.map(normalizeTestIdentifier);

	for (const candidate of candidates) {
		const exactMatch = exactMatches.get(candidate);
		if (exactMatch) {
			return exactMatch;
		}

		const suffixMatches = targetMethods.filter(method => {
			const fullyQualifiedName = normalizeTestIdentifier(method.fullyQualifiedName ?? method.label);
			return fullyQualifiedName === candidate || fullyQualifiedName.endsWith(`.${candidate}`);
		});
		if (suffixMatches.length === 1) {
			return suffixMatches[0];
		}

		const labelKey = candidate.includes('.') ? candidate.slice(candidate.lastIndexOf('.') + 1) : candidate;
		const matchingLabels = labelMatches.get(labelKey);
		if (matchingLabels?.length === 1) {
			return matchingLabels[0];
		}
	}

	return undefined;
}

function aggregateMethodRunResult(method: MethodNode, testResults: readonly DetailedTestResult[]): MethodRunResult {
	const state = aggregateRunStates(testResults.map(testResult => testResult.state));
	const outcomeCounts = summarizeDetailedResults(testResults);
	const durationMs = testResults.some(testResult => testResult.durationMs !== undefined)
		? testResults.reduce((sum, testResult) => sum + (testResult.durationMs ?? 0), 0)
		: undefined;

	return {
		method,
		state,
		message: outcomeCounts.mixed
			? `${outcomeCounts.passed} passed, ${outcomeCounts.failed} failed, ${outcomeCounts.skipped} skipped`
			: formatRunState(state),
		durationMs,
	};
}

function summarizeDetailedResults(testResults: readonly DetailedTestResult[]): { passed: number; failed: number; skipped: number; mixed: boolean } {
	let passed = 0;
	let failed = 0;
	let skipped = 0;
	const seenStates = new Set<RunState>();

	for (const testResult of testResults) {
		seenStates.add(testResult.state);
		switch (testResult.state) {
			case 'passed':
				passed += 1;
				break;
			case 'failed':
			case 'errored':
				failed += 1;
				break;
			case 'skipped':
				skipped += 1;
				break;
		}
	}

	return {
		passed,
		failed,
		skipped,
		mixed: seenStates.size > 1,
	};
}

function aggregateRunStates(states: readonly RunState[]): RunState {
	if (states.some(state => state === 'errored')) {
		return 'errored';
	}

	if (states.some(state => state === 'failed')) {
		return 'failed';
	}

	if (states.some(state => state === 'passed')) {
		return 'passed';
	}

	if (states.some(state => state === 'skipped')) {
		return 'skipped';
	}

	return 'idle';
}

function normalizeTestIdentifier(value: string): string {
	return value
		.trim()
		.replace(/\s*\([^)]*\)\s*$/, '')
		.replace(/\s*\[[^\]]+\]\s*$/, '')
		.replace(/\s+/g, ' ');
}

function updateTestRunItem(
	run: vscode.TestRun,
	item: vscode.TestItem,
	state: RunState,
	message: string,
	durationMs?: number,
): void {
	switch (state) {
		case 'passed':
			run.passed(item, durationMs);
			break;
		case 'failed':
			run.failed(item, createTestRunMessage(message, item), durationMs);
			break;
		case 'skipped':
			run.skipped(item);
			break;
		default:
			run.errored(item, createTestRunMessage(message, item), durationMs);
			break;
	}
}

function createTestRunMessage(message: string, item: vscode.TestItem): vscode.TestMessage {
	const testMessage = new vscode.TestMessage(message);
	if (item.uri && item.range) {
		testMessage.location = new vscode.Location(item.uri, item.range);
		testMessage.contextValue = SOURCE_TEST_MESSAGE_CONTEXT;
	}

	return testMessage;
}

export function createRunStartupMessage(label: string): string {
	return 'Starting';
}

export function createRunProgressMessage(step: RunProgressMessageStep): string {
	switch (step) {
		case 'starting':
			return createRunStartupMessage('');
		case 'restore':
			return 'Restoring';
		case 'build':
			return 'Building';
		case 'run':
			return 'Running';
		case 'results':
			return 'Results';
	}
}

function getRunProgressStepOrder(step: RunProgressMessageStep): number {
	switch (step) {
		case 'starting':
			return 0;
		case 'restore':
			return 1;
		case 'build':
			return 2;
		case 'run':
			return 3;
		case 'results':
			return 4;
	}
}

function formatNodeSummary(summary: RunSummary, state: RunState): string {
	if (summary.total > 0) {
		return `${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`;
	}

	switch (state) {
		case 'passed':
			return 'Passed';
		case 'failed':
			return 'Failed';
		case 'errored':
			return 'Errored';
		case 'skipped':
			return 'Skipped';
		default:
			return 'Completed';
	}
}

function formatRunState(state: RunState): string {
	switch (state) {
		case 'passed':
			return 'Passed';
		case 'failed':
			return 'Failed';
		case 'errored':
			return 'Errored';
		case 'skipped':
			return 'Skipped';
		default:
			return 'Completed';
	}
}

function createNavigationTargetFromNode(node: DotnetTestNode): NavigationTarget | undefined {
	return createNavigationTargetFromSourceLocation(node.sourceLocation);
}

function createNavigationTargetFromSourceLocation(sourceLocation: DiscoveredSourceLocation | undefined): NavigationTarget | undefined {
	if (!sourceLocation) {
		return undefined;
	}

	return {
		uri: vscode.Uri.file(sourceLocation.filePath),
		range: new vscode.Range(
			sourceLocation.range.startLine,
			sourceLocation.range.startCharacter,
			sourceLocation.range.endLine,
			sourceLocation.range.endCharacter,
		),
	};
}

function createNavigationTargetFromLocation(location: vscode.Location | undefined): NavigationTarget | undefined {
	if (!location) {
		return undefined;
	}

	return {
		uri: location.uri,
		range: location.range,
	};
}

async function openNavigationTarget(target: NavigationTarget): Promise<void> {
	const document = await vscode.workspace.openTextDocument(target.uri);
	const editor = await vscode.window.showTextDocument(document, target.range ? { selection: target.range } : {});
	if (target.range) {
		editor.revealRange(target.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	}
}

function isNodeLike(value: unknown): value is DotnetTestNode {
	return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string';
}

function isTestMessageCommandArgument(value: unknown): value is TestMessageCommandArgument {
	return typeof value === 'object' && value !== null && ('test' in value || 'message' in value);
}

function createTestItemDescription(node: DotnetTestNode): string | undefined {
	if (node.kind !== 'project') {
		return undefined;
	}

	const parts = [formatRunnerMode(node.runnerMode)];
	if (node.discoveryMessage) {
		parts.push(node.discoveryMessage);
	}

	return parts.join(' · ');
}

function createNodePickDescription(node: DotnetTestNode, store: DotnetTestStore): string {
	switch (node.kind) {
		case 'project':
			return `project · ${formatRunnerMode(node.runnerMode)}`;
		case 'class': {
			const project = getProjectNode(store, node);
			return project ? `class · ${project.label}` : 'class';
		}
		default: {
			const classNode = node.parentId ? store.getNode(node.parentId) : undefined;
			const project = getProjectNode(store, node);
			const parts = ['method'];
			if (classNode?.kind === 'class') {
				parts.push(classNode.label);
			}
			if (project) {
				parts.push(project.label);
			}

			return parts.join(' · ');
		}
	}
}

function createNodePickDetail(node: DotnetTestNode): string {
	return node.kind === 'project'
		? node.projectPath
		: node.fullyQualifiedName ?? node.projectPath;
}

function getProjectNode(store: DotnetTestStore, node: DotnetTestNode): ProjectNode | undefined {
	let current: DotnetTestNode | undefined = node;
	while (current) {
		if (current.kind === 'project') {
			return current;
		}

		current = current.parentId ? store.getNode(current.parentId) : undefined;
	}

	return undefined;
}

function isPathWithinDirectory(filePath: string, directoryPath: string): boolean {
	const normalizedDirectoryPath = normalizeFsPath(directoryPath);
	const normalizedFilePath = normalizeFsPath(filePath);
	return normalizedFilePath === normalizedDirectoryPath || normalizedFilePath.startsWith(ensureTrailingSeparator(normalizedDirectoryPath));
}

function normalizeFsPath(filePath: string): string {
	return path.normalize(filePath).replace(/[\\/]+$/, '').toLowerCase();
}

function ensureTrailingSeparator(filePath: string): string {
	return filePath.endsWith(path.sep) ? filePath : `${filePath}${path.sep}`;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
