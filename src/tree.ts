import * as vscode from 'vscode';
import { DotnetTestStore, formatRunnerMode, type DotnetTestNode } from './model';

export class DotnetTestsTreeProvider implements vscode.TreeDataProvider<DotnetTestNode>, vscode.Disposable {
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<DotnetTestNode | undefined>();
	private readonly changeSubscription: vscode.Disposable;

	readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	constructor(private readonly store: DotnetTestStore) {
		this.changeSubscription = this.store.onDidChange(() => this.onDidChangeTreeDataEmitter.fire(undefined));
	}

	dispose(): void {
		this.changeSubscription.dispose();
		this.onDidChangeTreeDataEmitter.dispose();
	}

	getTreeItem(node: DotnetTestNode): vscode.TreeItem {
		const item = new vscode.TreeItem(
			node.label,
			node.childrenIds.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
		);

		item.contextValue = 'dotnetTestNode';
		item.iconPath = createIcon(node);
		item.command = {
			command: 'dotnet-tests.runNode',
			title: 'Run',
			arguments: [node.id],
		};
		item.description = createDescription(node);
		item.tooltip = createTooltip(node);

		if (node.kind === 'project') {
			item.resourceUri = node.projectUri;
		}

		return item;
	}

	getChildren(node?: DotnetTestNode): DotnetTestNode[] {
		return this.store.getChildren(node);
	}
}

function createDescription(node: DotnetTestNode): string | undefined {
	const parts: string[] = [];
	if (node.kind === 'project') {
		parts.push(formatRunnerMode(node.runnerMode));
	}

	if (node.message) {
		parts.push(node.message);
	} else if (node.discoveryMessage) {
		parts.push(node.discoveryMessage);
	} else if (node.state !== 'idle') {
		parts.push(formatState(node.state));
	}

	return parts.length > 0 ? parts.join(' · ') : undefined;
}

function createTooltip(node: DotnetTestNode): vscode.MarkdownString {
	const tooltip = new vscode.MarkdownString(undefined, true);
	tooltip.appendMarkdown(`**${node.label}**\n\n`);
	tooltip.appendCodeblock(node.projectPath);
	if (node.fullyQualifiedName) {
		tooltip.appendMarkdown('\n');
		tooltip.appendCodeblock(node.fullyQualifiedName);
	}

	if (node.message || node.discoveryMessage) {
		tooltip.appendMarkdown(`\n${node.message ?? node.discoveryMessage}`);
	}

	return tooltip;
}

function createIcon(node: DotnetTestNode): vscode.ThemeIcon {
	switch (node.state) {
		case 'running':
			return new vscode.ThemeIcon('sync~spin');
		case 'queued':
			return new vscode.ThemeIcon('clock');
		case 'passed':
			return new vscode.ThemeIcon('check');
		case 'failed':
			return new vscode.ThemeIcon('error');
		case 'errored':
			return new vscode.ThemeIcon('warning');
		case 'skipped':
			return new vscode.ThemeIcon('circle-slash');
		default:
			switch (node.kind) {
				case 'project':
					return new vscode.ThemeIcon('beaker');
				case 'class':
					return new vscode.ThemeIcon('symbol-class');
				default:
					return new vscode.ThemeIcon('symbol-method');
			}
	}
}

function formatState(state: DotnetTestNode['state']): string {
	return state[0].toUpperCase() + state.slice(1);
}