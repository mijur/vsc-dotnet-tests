import * as vscode from 'vscode';

export type RunnerMode = 'vstest' | 'mtp' | 'mtp-legacy';
export type NodeKind = 'project' | 'class' | 'method';
export type RunState = 'idle' | 'queued' | 'running' | 'passed' | 'failed' | 'errored' | 'skipped';

export interface DiscoveredMethod {
	fullyQualifiedName: string;
	label: string;
}

export interface DiscoveredClass {
	fullyQualifiedName: string;
	label: string;
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
		this.nodes.clear();
		this.rootIds = [];

		for (const project of [...projects].sort((left, right) => left.label.localeCompare(right.label))) {
			const projectId = createProjectId(project.projectPath);
			const projectNode: ProjectNode = {
				id: projectId,
				kind: 'project',
				label: project.label,
				projectPath: project.projectPath,
				runnerMode: project.runnerMode,
				childrenIds: [],
				state: 'idle',
				projectUri: vscode.Uri.file(project.projectPath),
				discoveryMessage: project.warning,
			};

			this.nodes.set(projectId, projectNode);
			this.rootIds.push(projectId);

			for (const discoveredClass of [...project.classes].sort((left, right) => left.label.localeCompare(right.label))) {
				const classId = createClassId(project.projectPath, discoveredClass.fullyQualifiedName);
				const classNode: ClassNode = {
					id: classId,
					kind: 'class',
					label: discoveredClass.label,
					projectPath: project.projectPath,
					runnerMode: project.runnerMode,
					childrenIds: [],
					state: 'idle',
					parentId: projectId,
					fullyQualifiedName: discoveredClass.fullyQualifiedName,
				};

				this.nodes.set(classId, classNode);
				projectNode.childrenIds.push(classId);

				for (const method of [...discoveredClass.methods].sort((left, right) => left.label.localeCompare(right.label))) {
					const methodId = createMethodId(project.projectPath, method.fullyQualifiedName);
					const methodNode: MethodNode = {
						id: methodId,
						kind: 'method',
						label: method.label,
						projectPath: project.projectPath,
						runnerMode: project.runnerMode,
						childrenIds: [],
						state: 'idle',
						parentId: classId,
						fullyQualifiedName: method.fullyQualifiedName,
					};

					this.nodes.set(methodId, methodNode);
					classNode.childrenIds.push(methodId);
				}
			}
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

	resetRunState(): void {
		for (const node of this.nodes.values()) {
			node.state = 'idle';
			node.message = undefined;
		}

		this.onDidChangeTreeDataEmitter.fire();
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