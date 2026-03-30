import * as vscode from 'vscode';
import { discoverWorkspaceTests, runDotnetTarget } from './dotnet';
import { DotnetTestStore, type DotnetTestNode, type DotnetTestsSnapshotNode, type RunSummary, type RunState } from './model';
import { DotnetTestsTreeProvider } from './tree';

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

class DotnetTestsExtension implements vscode.Disposable, DotnetTestsApi {
	private readonly store = new DotnetTestStore();
	private readonly treeProvider = new DotnetTestsTreeProvider(this.store);
	private readonly treeView = vscode.window.createTreeView('dotnetTestsView', {
		treeDataProvider: this.treeProvider,
		showCollapseAll: true,
	});
	private readonly output = vscode.window.createOutputChannel('Dotnet Tests');
	private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	private readonly controller = vscode.tests.createTestController('dotnet-tests.controller', 'Dotnet Tests');
	private readonly testItems = new Map<string, vscode.TestItem>();
	private readonly disposables: vscode.Disposable[] = [];
	private refreshPromise: Promise<void> | undefined;
	private refreshHandle: NodeJS.Timeout | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.statusBar.command = 'dotnet-tests.actions';
		this.statusBar.show();

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
			this.treeProvider,
			this.treeView,
			this.output,
			this.statusBar,
			this.controller,
			this.store.onDidChange(() => this.syncPresentation()),
			vscode.commands.registerCommand('dotnet-tests.refresh', () => this.refresh(true)),
			vscode.commands.registerCommand('dotnet-tests.actions', () => this.showActions()),
			vscode.commands.registerCommand('dotnet-tests.runAll', () => this.runAll()),
			vscode.commands.registerCommand('dotnet-tests.showOutput', () => this.output.show(true)),
			vscode.commands.registerCommand('dotnet-tests.runNode', (argument?: unknown) => this.runNode(argument)),
			vscode.commands.registerCommand('dotnet-tests.revealInTestExplorer', (argument?: unknown) => this.revealInTestExplorer(argument)),
			...this.createWatchers(),
		);

		this.context.subscriptions.push(...this.disposables);
		this.syncPresentation();
		void this.refresh();
	}

	dispose(): void {
		if (this.refreshHandle) {
			clearTimeout(this.refreshHandle);
		}

		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	async refresh(showMessage = false): Promise<void> {
		if (this.refreshPromise) {
			return this.refreshPromise;
		}

		this.statusBar.text = '$(sync~spin) Dotnet Tests';
		this.refreshPromise = this.performRefresh(showMessage).finally(() => {
			this.refreshPromise = undefined;
			this.syncPresentation();
		});

		return this.refreshPromise;
	}

	private async performRefresh(showMessage: boolean): Promise<void> {
		const projects = await discoverWorkspaceTests(this.output);
		this.store.setSnapshot(projects);
		this.store.setSummary(undefined);
		this.syncTestItems();

		if (showMessage) {
			const message = projects.length === 0
				? 'No .NET test projects found in the workspace.'
				: `Discovered ${projects.length} .NET test project${projects.length === 1 ? '' : 's'}.`;
			void vscode.window.showInformationMessage(message);
		}
	}

	private syncTestItems(): void {
		this.testItems.clear();
		const roots = this.store.getRoots().map(node => this.createTestItem(node));
		this.controller.items.replace(roots);
	}

	private createTestItem(node: DotnetTestNode): vscode.TestItem {
		const uri = node.kind === 'project' ? node.projectUri : undefined;
		const item = this.controller.createTestItem(node.id, node.label, uri);
		item.description = node.kind === 'project' ? node.runnerMode.toUpperCase() : undefined;
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
		const node = this.resolveNode(argument);
		if (!node) {
			void vscode.window.showInformationMessage('Select a test project, class, or method first.');
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

			this.store.setNodeState(node.id, 'running', undefined);
			run.appendOutput(`> ${node.label}\r\n`);

			try {
				const result = await runDotnetTarget(node, this.output, token);
				const message = formatNodeSummary(result.summary, result.status);
				this.store.setNodeState(node.id, result.status, message);

				if (item) {
					if (result.status === 'passed') {
						run.passed(item, result.summary.durationMs);
					} else if (result.status === 'failed') {
						run.failed(item, new vscode.TestMessage(message), result.summary.durationMs);
					} else {
						run.errored(item, new vscode.TestMessage(message), result.summary.durationMs);
					}
				}

				run.appendOutput(`${message}\r\n`);
				updateAggregateSummary(aggregate, result.summary, result.status);
			} catch (error) {
				if (token?.isCancellationRequested) {
					if (item) {
						run.skipped(item);
					}
					this.store.setNodeState(node.id, 'skipped', 'Cancelled');
					break;
				}

				const message = error instanceof Error ? error.message : String(error);
				this.store.setNodeState(node.id, 'errored', message);

				if (item) {
					run.errored(item, new vscode.TestMessage(message));
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

		return this.treeView.selection[0];
	}

	private async showActions(): Promise<void> {
		const selected = this.treeView.selection[0];
		const picks: ActionPick[] = [
			{
				label: 'Refresh test tree',
				detail: 'Re-scan the workspace and rediscover test projects and methods.',
				run: () => this.refresh(true),
			},
			{
				label: 'Run all tests',
				detail: 'Run every discovered .NET test project in this workspace.',
				run: () => this.runAll(),
			},
			{
				label: 'Show output',
				detail: 'Open the Dotnet Tests output channel.',
				run: async () => this.output.show(true),
			},
		];

		if (selected) {
			picks.unshift(
				{
					label: `Run selected: ${selected.label}`,
					detail: 'Run the tree item that is currently selected.',
					run: () => this.runNodes([selected], `Run ${selected.label}`),
				},
				{
					label: `Reveal selected: ${selected.label}`,
					detail: 'Reveal the selected item in the native Test Explorer.',
					run: () => this.revealInTestExplorer(selected.id),
				},
			);
		}

		const pick = await vscode.window.showQuickPick(picks, {
			placeHolder: 'Choose a Dotnet Tests action',
		});

		if (pick) {
			await pick.run();
		}
	}

	private async revealInTestExplorer(argument?: unknown): Promise<void> {
		const node = this.resolveNode(argument);
		if (!node) {
			return;
		}

		const item = this.testItems.get(node.id);
		if (!item) {
			return;
		}

		await vscode.commands.executeCommand('vscode.revealTestInExplorer', item);
	}

	private syncPresentation(): void {
		const summary = this.store.getSummary();
		if (this.refreshPromise) {
			this.statusBar.text = '$(sync~spin) Dotnet Tests';
			this.statusBar.tooltip = 'Refreshing .NET tests';
		} else if (summary) {
			this.statusBar.text = `$(beaker) ${summary.passed} passed, ${summary.failed} failed`;
			this.statusBar.tooltip = formatSummaryTooltip(summary);
		} else if (this.store.hasProjects()) {
			this.statusBar.text = `$(beaker) Dotnet Tests (${this.store.getRoots().length})`;
			this.statusBar.tooltip = 'Dotnet Tests';
		} else {
			this.statusBar.text = '$(beaker) Dotnet Tests';
			this.statusBar.tooltip = 'No .NET test projects discovered yet';
		}

		this.treeView.message = summary
			? formatSummaryMessage(summary)
			: this.store.hasProjects()
				? undefined
				: 'No .NET test projects found. Use Refresh after adding or restoring test projects.';
	}

	private createWatchers(): vscode.Disposable[] {
		const patterns = ['**/*.csproj', '**/*.cs', '**/global.json', '**/Directory.Build.props', '**/*.runsettings'];
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
			void this.refresh();
		}, 750);
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

	if (summary.passed > 0 || summary.skipped > 0) {
		return 'passed';
	}

	return 'idle';
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

function formatSummaryMessage(summary: RunSummary): string {
	const duration = summary.durationMs ? ` in ${Math.round(summary.durationMs)} ms` : '';
	return `${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped across ${summary.projectCount} project${summary.projectCount === 1 ? '' : 's'}${duration}.`;
}

function formatSummaryTooltip(summary: RunSummary): string {
	return `${summary.label}: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped.`;
}

function isNodeLike(value: unknown): value is DotnetTestNode {
	return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string';
}
