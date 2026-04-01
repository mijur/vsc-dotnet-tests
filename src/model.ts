import * as vscode from 'vscode';

export type RunnerMode = 'vstest' | 'mtp' | 'mtp-legacy';
export type NodeKind = 'project' | 'class' | 'method';
export type RunState = 'idle' | 'queued' | 'running' | 'passed' | 'failed' | 'errored' | 'skipped';

export interface DiscoveredSourceRange {
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
}

export interface DiscoveredSourceLocation {
	filePath: string;
	range: DiscoveredSourceRange;
}

export interface DiscoveredMethod {
	fullyQualifiedName: string;
	label: string;
	sourceLocation?: DiscoveredSourceLocation;
}

export interface DiscoveredClass {
	fullyQualifiedName: string;
	label: string;
	sourceLocation?: DiscoveredSourceLocation;
	methods: DiscoveredMethod[];
}

export interface DiscoveredProject {
	projectPath: string;
	label: string;
	runnerMode: RunnerMode;
	classes: DiscoveredClass[];
	warning?: string;
}

export interface RunSummary {
	label: string;
	total: number;
	passed: number;
	failed: number;
	skipped: number;
	projectCount: number;
	durationMs?: number;
	status: Exclude<RunState, 'queued'>;
}

export interface DotnetTestsSnapshotNode {
	id: string;
	kind: NodeKind;
	label: string;
	projectPath: string;
	runnerMode: RunnerMode;
	state: RunState;
	fullyQualifiedName?: string;
	sourceLocation?: DiscoveredSourceLocation;
	children: DotnetTestsSnapshotNode[];
}

interface DotnetTestNodeBase {
	id: string;
	kind: NodeKind;
	label: string;
	projectPath: string;
	runnerMode: RunnerMode;
	childrenIds: string[];
	state: RunState;
	parentId?: string;
	fullyQualifiedName?: string;
	sourceLocation?: DiscoveredSourceLocation;
	message?: string;
	discoveryMessage?: string;
}

export interface ProjectNode extends DotnetTestNodeBase {
	kind: 'project';
	projectUri: vscode.Uri;
}

export interface ClassNode extends DotnetTestNodeBase {
	kind: 'class';
}

export interface MethodNode extends DotnetTestNodeBase {
	kind: 'method';
}

export type DotnetTestNode = ProjectNode | ClassNode | MethodNode;

export interface NodeStateUpdate {
	id: string;
	state?: RunState;
	message?: string;
}

export class DotnetTestStore {
	private readonly nodes = new Map<string, DotnetTestNode>();
	private rootIds: string[] = [];
	private summary: RunSummary | undefined;
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();

	readonly onDidChange = this.onDidChangeTreeDataEmitter.event;

	hasProjects(): boolean {
		return this.rootIds.length > 0;
	}

	getRoots(): ProjectNode[] {
		return this.rootIds
			.map(id => this.nodes.get(id))
			.filter((node): node is ProjectNode => node?.kind === 'project');
	}

	getNode(id: string): DotnetTestNode | undefined {
		return this.nodes.get(id);
	}

	getChildren(node?: DotnetTestNode): DotnetTestNode[] {
		if (!node) {
			return this.getRoots();
		}

		return node.childrenIds
			.map(id => this.nodes.get(id))
			.filter((child): child is DotnetTestNode => child !== undefined);
	}

	getDescendantMethods(node: DotnetTestNode): MethodNode[] {
		const methods: MethodNode[] = [];
		const stack: DotnetTestNode[] = [node];

		while (stack.length > 0) {
			const current = stack.pop();
			if (!current) {
				continue;
			}

			if (current.kind === 'method') {
				methods.push(current);
				continue;
			}

			for (const childId of current.childrenIds) {
				const child = this.nodes.get(childId);
				if (child) {
					stack.push(child);
				}
			}
		}

		return methods;
	}

	getSummary(): RunSummary | undefined {
		return this.summary;
	}

	getSnapshot(): DotnetTestsSnapshotNode[] {
		return this.getRoots().map(node => this.snapshotNode(node));
	}

	setSummary(summary: RunSummary | undefined): void {
		this.summary = summary;
		this.onDidChangeTreeDataEmitter.fire();
	}

	setSnapshot(projects: DiscoveredProject[]): void {
		const previousNodes = new Map(this.nodes);
		this.nodes.clear();
		this.rootIds = [];

		for (const project of [...projects].sort((left, right) => left.label.localeCompare(right.label))) {
			this.insertProject(project, previousNodes);
		}

		this.sortRootIds();
		this.onDidChangeTreeDataEmitter.fire();
	}

	setProjectSnapshot(project: DiscoveredProject): void {
		const previousNodes = this.takeProjectNodes(project.projectPath);
		this.insertProject(project, previousNodes);
		this.sortRootIds();
		this.onDidChangeTreeDataEmitter.fire();
	}

	removeProject(projectPath: string): void {
		if (this.takeProjectNodes(projectPath).size === 0) {
			return;
		}

		this.onDidChangeTreeDataEmitter.fire();
	}

	setNodeState(id: string, state: RunState, message?: string): void {
		const node = this.nodes.get(id);
		if (!node) {
			return;
		}

		node.state = state;
		node.message = message;
		this.recalculateAncestors(node.parentId);
		this.onDidChangeTreeDataEmitter.fire();
	}

	applyNodeUpdates(updates: readonly NodeStateUpdate[]): void {
		const parentIds = new Set<string>();
		let changed = false;

		for (const update of updates) {
			const node = this.nodes.get(update.id);
			if (!node) {
				continue;
			}

			if (update.state !== undefined) {
				node.state = update.state;
			}

			if ('message' in update) {
				node.message = update.message;
			}

			if (node.parentId) {
				parentIds.add(node.parentId);
			}

			changed = true;
		}

		if (!changed) {
			return;
		}

		for (const parentId of parentIds) {
			this.recalculateAncestors(parentId);
		}

		this.onDidChangeTreeDataEmitter.fire();
	}

	setSubtreeState(id: string, state: RunState, message?: string): void {
		const root = this.nodes.get(id);
		if (!root) {
			return;
		}

		const stack: DotnetTestNode[] = [root];
		while (stack.length > 0) {
			const current = stack.pop();
			if (!current) {
				continue;
			}

			current.state = state;
			current.message = message;
			for (const childId of current.childrenIds) {
				const child = this.nodes.get(childId);
				if (child) {
					stack.push(child);
				}
			}
		}

		this.recalculateAncestors(root.parentId);
		this.onDidChangeTreeDataEmitter.fire();
	}

	resetRunState(): void {
		for (const node of this.nodes.values()) {
			node.state = 'idle';
			node.message = undefined;
		}

		this.onDidChangeTreeDataEmitter.fire();
	}

	private insertProject(project: DiscoveredProject, previousNodes: ReadonlyMap<string, DotnetTestNode>): void {
		const projectId = createProjectId(project.projectPath);
		const previousProjectNode = previousNodes.get(projectId);
		const projectNode: ProjectNode = {
			id: projectId,
			kind: 'project',
			label: project.label,
			projectPath: project.projectPath,
			runnerMode: project.runnerMode,
			childrenIds: [],
			state: previousProjectNode?.state ?? 'idle',
			projectUri: vscode.Uri.file(project.projectPath),
			discoveryMessage: project.warning,
		};

		this.nodes.set(projectId, projectNode);
		this.rootIds.push(projectId);

		for (const discoveredClass of [...project.classes].sort((left, right) => left.label.localeCompare(right.label))) {
			const classId = createClassId(project.projectPath, discoveredClass.fullyQualifiedName);
			const previousClassNode = previousNodes.get(classId);
			const classNode: ClassNode = {
				id: classId,
				kind: 'class',
				label: discoveredClass.label,
				projectPath: project.projectPath,
				runnerMode: project.runnerMode,
				childrenIds: [],
				state: previousClassNode?.state ?? 'idle',
				parentId: projectId,
				fullyQualifiedName: discoveredClass.fullyQualifiedName,
				sourceLocation: discoveredClass.sourceLocation,
			};

			this.nodes.set(classId, classNode);
			projectNode.childrenIds.push(classId);

			for (const method of [...discoveredClass.methods].sort((left, right) => left.label.localeCompare(right.label))) {
				const methodId = createMethodId(project.projectPath, method.fullyQualifiedName);
				const previousMethodNode = previousNodes.get(methodId);
				const methodNode: MethodNode = {
					id: methodId,
					kind: 'method',
					label: method.label,
					projectPath: project.projectPath,
					runnerMode: project.runnerMode,
					childrenIds: [],
					state: previousMethodNode?.state ?? 'idle',
					parentId: classId,
					fullyQualifiedName: method.fullyQualifiedName,
					sourceLocation: method.sourceLocation,
					message: previousMethodNode?.message,
				};

				this.nodes.set(methodId, methodNode);
				classNode.childrenIds.push(methodId);
			}

			if (classNode.childrenIds.length > 0) {
				classNode.state = aggregateStates(classNode.childrenIds.map(childId => this.nodes.get(childId)?.state ?? 'idle'));
			}
		}

		if (projectNode.childrenIds.length > 0) {
			projectNode.state = aggregateStates(projectNode.childrenIds.map(childId => this.nodes.get(childId)?.state ?? 'idle'));
		}
	}

	private takeProjectNodes(projectPath: string): Map<string, DotnetTestNode> {
		const projectId = createProjectId(projectPath);
		const projectNode = this.nodes.get(projectId);
		if (!projectNode || projectNode.kind !== 'project') {
			return new Map();
		}

		const previousNodes = new Map<string, DotnetTestNode>();
		const pendingIds = [projectId];
		while (pendingIds.length > 0) {
			const currentId = pendingIds.pop();
			if (!currentId) {
				continue;
			}

			const currentNode = this.nodes.get(currentId);
			if (!currentNode) {
				continue;
			}

			previousNodes.set(currentId, currentNode);
			pendingIds.push(...currentNode.childrenIds);
			this.nodes.delete(currentId);
		}

		this.rootIds = this.rootIds.filter(id => id !== projectId);
		return previousNodes;
	}

	private sortRootIds(): void {
		this.rootIds.sort((left, right) => {
			const leftLabel = this.nodes.get(left)?.label ?? '';
			const rightLabel = this.nodes.get(right)?.label ?? '';
			return leftLabel.localeCompare(rightLabel);
		});
	}

	private recalculateAncestors(parentId: string | undefined): void {
		let currentId = parentId;
		while (currentId) {
			const node = this.nodes.get(currentId);
			if (!node) {
				return;
			}

			node.state = aggregateStates(node.childrenIds.map(childId => this.nodes.get(childId)?.state ?? 'idle'));
			currentId = node.parentId;
		}
	}

	private snapshotNode(node: DotnetTestNode): DotnetTestsSnapshotNode {
		return {
			id: node.id,
			kind: node.kind,
			label: node.label,
			projectPath: node.projectPath,
			runnerMode: node.runnerMode,
			state: node.state,
			fullyQualifiedName: node.fullyQualifiedName,
			sourceLocation: node.sourceLocation,
			children: this.getChildren(node).map(child => this.snapshotNode(child)),
		};
	}
}

export function formatRunnerMode(runnerMode: RunnerMode): string {
	switch (runnerMode) {
		case 'mtp':
			return 'MTP';
		case 'mtp-legacy':
			return 'MTP bridge';
		default:
			return 'VSTest';
	}
}

function aggregateStates(states: RunState[]): RunState {
	if (states.some(state => state === 'running')) {
		return 'running';
	}

	if (states.some(state => state === 'errored')) {
		return 'errored';
	}

	if (states.some(state => state === 'failed')) {
		return 'failed';
	}

	if (states.some(state => state === 'queued')) {
		return 'queued';
	}

	if (states.some(state => state === 'passed')) {
		return 'passed';
	}

	if (states.some(state => state === 'skipped')) {
		return 'skipped';
	}

	return 'idle';
}

function createProjectId(projectPath: string): string {
	return `project:${projectPath}`;
}

function createClassId(projectPath: string, fullyQualifiedName: string): string {
	return `class:${projectPath}:${fullyQualifiedName}`;
}

function createMethodId(projectPath: string, fullyQualifiedName: string): string {
	return `method:${projectPath}:${fullyQualifiedName}`;
}