import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { alignSourceClassesWithListedTests, parseCSharpTests } from './csharpParser';
import {
	type DiscoveredClass,
	type DiscoveredMethod,
	type DiscoveredProject,
	type DotnetTestNode,
	type RunState,
	type RunSummary,
	type RunnerMode,
} from './model';

const TEST_FILE_PATTERN = '**/*.csproj';
const IGNORED_PATH_SEGMENTS = ['\\bin\\', '\\obj\\', '\\node_modules\\', '/bin/', '/obj/', '/node_modules/'];
const TEST_PROJECT_PATTERNS = [
	/<IsTestProject>\s*true\s*<\/IsTestProject>/i,
	/Include=["']Microsoft\.NET\.Test\.Sdk["']/i,
	/Include=["']MSTest(?:\.[^"']+)?["']/i,
	/Include=["']xunit(?:\.[^"']+)?["']/i,
	/Include=["']NUnit(?:\.[^"']+)?["']/i,
	/Include=["']NUnit3TestAdapter["']/i,
	/Include=["']Microsoft\.Testing\.Extensions\.VSTestBridge["']/i,
];

export interface DotnetCommandResult {
	exitCode: number;
	status: RunState;
	commandLine: string;
	stdout: string;
	stderr: string;
	summary: RunSummary;
}

export async function discoverWorkspaceTests(output: vscode.OutputChannel): Promise<DiscoveredProject[]> {
	if (!vscode.workspace.workspaceFolders?.length) {
		return [];
	}

	const candidates = await vscode.workspace.findFiles(TEST_FILE_PATTERN);
	const projectFiles = candidates.filter(candidate => !isIgnoredPath(candidate.fsPath));

	const results: DiscoveredProject[] = [];
	for (const projectUri of projectFiles) {
		const project = await discoverProject(projectUri.fsPath, output);
		if (project) {
			results.push(project);
		}
	}

	return results;
}

export async function runDotnetTarget(
	node: DotnetTestNode,
	output: vscode.OutputChannel,
	token?: vscode.CancellationToken,
): Promise<DotnetCommandResult> {
	const args = buildRunArguments(node);
	const cwd = path.dirname(node.projectPath);
	const result = await executeDotnet(args, cwd, output, token);
	const summary = parseRunSummary(result.combined, args.length === 0 ? 'Run' : `Run ${node.label}`);
	const status = result.exitCode === 0 ? 'passed' : summary.total > 0 || summary.failed > 0 ? 'failed' : 'errored';

	return {
		exitCode: result.exitCode,
		status,
		commandLine: result.commandLine,
		stdout: result.stdout,
		stderr: result.stderr,
		summary: {
			...summary,
			status,
		},
	};
}

async function discoverProject(projectPath: string, output: vscode.OutputChannel): Promise<DiscoveredProject | undefined> {
	const projectText = await fs.readFile(projectPath, 'utf8');
	if (!looksLikeTestProject(projectText)) {
		return undefined;
	}

	const runnerMode = await detectRunnerMode(projectPath, projectText);
	const label = path.basename(projectPath, path.extname(projectPath));

	try {
		const args = buildListArguments(projectPath, runnerMode);
		const result = await executeDotnet(args, path.dirname(projectPath), output);
		const tests = parseDiscoveredTests(result.combined);
		let classes = groupTestsIntoClasses(tests);
		if (classes.length === 0 || tests.every(test => !test.includes('.'))) {
			const sourceClasses = await parseCSharpTests(projectPath);
			classes = alignSourceClassesWithListedTests(sourceClasses, tests);
		}

		return {
			projectPath,
			label,
			runnerMode,
			classes,
			warning: classes.length === 0 ? 'No tests discovered' : tests.every(test => !test.includes('.')) ? 'Using C# source fallback for test structure' : undefined,
		};
	} catch (error) {
		return {
			projectPath,
			label,
			runnerMode,
			classes: [],
			warning: getErrorMessage(error),
		};
	}
}

function looksLikeTestProject(projectText: string): boolean {
	if (containsTagValue(projectText, 'IsTestProject', 'true')) {
		return true;
	}

	if (/Sdk\s*=\s*"MSTest\.Sdk/i.test(projectText)) {
		return true;
	}

	return TEST_PROJECT_PATTERNS.some(pattern => pattern.test(projectText));
}

async function detectRunnerMode(projectPath: string, projectText: string): Promise<RunnerMode> {
	const globalJson = await readNearestGlobalJson(projectPath);
	if (usesMtpGlobalRunner(globalJson)) {
		return 'mtp';
	}

	if (
		containsTagValue(projectText, 'TestingPlatformDotnetTestSupport', 'true') ||
		containsTagValue(projectText, 'EnableMSTestRunner', 'true') ||
		containsTagValue(projectText, 'EnableNUnitRunner', 'true') ||
		containsTagValue(projectText, 'UseMicrosoftTestingPlatformRunner', 'true')
	) {
		return 'mtp-legacy';
	}

	return 'vstest';
}

function usesMtpGlobalRunner(globalJson: Record<string, unknown> | undefined): boolean {
	if (!globalJson) {
		return false;
	}

	const testSection = globalJson.test;
	if (typeof testSection !== 'object' || testSection === null || !('runner' in testSection)) {
		return false;
	}

	return testSection.runner === 'Microsoft.Testing.Platform';
}

async function readNearestGlobalJson(projectPath: string): Promise<Record<string, unknown> | undefined> {
	const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(projectPath));
	const rootPath = folder?.uri.fsPath;
	if (!rootPath) {
		return undefined;
	}

	let currentPath = path.dirname(projectPath);
	while (currentPath.startsWith(rootPath)) {
		const globalJsonPath = path.join(currentPath, 'global.json');
		try {
			const fileContents = await fs.readFile(globalJsonPath, 'utf8');
			return JSON.parse(fileContents) as Record<string, unknown>;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				return undefined;
			}
		}

		const parentPath = path.dirname(currentPath);
		if (parentPath === currentPath) {
			break;
		}

		currentPath = parentPath;
	}

	return undefined;
}

function buildListArguments(projectPath: string, runnerMode: RunnerMode): string[] {
	switch (runnerMode) {
		case 'mtp':
			return ['test', '--project', projectPath, '--list-tests', '--no-ansi', '--no-progress'];
		case 'mtp-legacy':
			return ['test', projectPath, '--', '--list-tests'];
		default:
			return ['test', projectPath, '--list-tests', '--nologo'];
	}
}

function buildRunArguments(node: DotnetTestNode): string[] {
	const filter = buildFilter(node);

	switch (node.runnerMode) {
		case 'mtp': {
			const args = ['test', '--project', node.projectPath, '--no-ansi', '--no-progress'];
			if (filter) {
				args.push('--filter', filter);
			}
			return args;
		}
		case 'mtp-legacy': {
			const args = ['test', node.projectPath, '--'];
			if (filter) {
				args.push('--filter', filter);
			}
			return args;
		}
		default: {
			const args = ['test', node.projectPath, '--nologo'];
			if (filter) {
				args.push('--filter', filter);
			}
			return args;
		}
	}
}

function buildFilter(node: DotnetTestNode): string | undefined {
	if (node.kind === 'project' || !node.fullyQualifiedName) {
		return undefined;
	}

	if (node.kind === 'class') {
		return `FullyQualifiedName~${escapeFilterValue(`${node.fullyQualifiedName}.`)}`;
	}

	const normalized = node.fullyQualifiedName.replace(/\(.*\)$/, '');
	return `FullyQualifiedName~${escapeFilterValue(normalized)}`;
}

function escapeFilterValue(value: string): string {
	return value.replace(/,/g, '%2C');
}

function parseDiscoveredTests(output: string): string[] {
	const tests = new Set<string>();
	for (const line of stripAnsi(output).split(/\r?\n/)) {
		const candidate = line.trim();
		if (!candidate || isNoiseLine(candidate) || !looksLikeTestName(candidate)) {
			continue;
		}

		tests.add(candidate);
	}

	return [...tests].sort((left, right) => left.localeCompare(right));
}

function groupTestsIntoClasses(tests: string[]): DiscoveredClass[] {
	const grouped = new Map<string, DiscoveredMethod[]>();

	for (const test of tests) {
		const lastDot = test.lastIndexOf('.');
		if (lastDot <= 0) {
			continue;
		}

		const className = test.slice(0, lastDot);
		const methodLabel = test.slice(lastDot + 1);
		const methods = grouped.get(className) ?? [];
		methods.push({ fullyQualifiedName: test, label: methodLabel });
		grouped.set(className, methods);
	}

	return [...grouped.entries()]
		.map(([fullyQualifiedName, methods]) => ({
			fullyQualifiedName,
			label: fullyQualifiedName.split('.').at(-1) ?? fullyQualifiedName,
			methods,
		}))
		.sort((left, right) => left.label.localeCompare(right.label));
}

interface ExecuteResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	combined: string;
	commandLine: string;
}

async function executeDotnet(
	args: string[],
	cwd: string,
	output: vscode.OutputChannel,
	token?: vscode.CancellationToken,
): Promise<ExecuteResult> {
	const commandLine = `dotnet ${args.join(' ')}`;
	output.appendLine(`$ ${commandLine}`);

	return new Promise<ExecuteResult>((resolve, reject) => {
		const child = spawn('dotnet', args, { cwd, env: process.env });
		let stdout = '';
		let stderr = '';
		let cancelled = false;

		const cancellationSubscription = token?.onCancellationRequested(() => {
			cancelled = true;
			child.kill();
		});

		child.stdout.on('data', chunk => {
			const text = chunk.toString();
			stdout += text;
			output.append(text);
		});

		child.stderr.on('data', chunk => {
			const text = chunk.toString();
			stderr += text;
			output.append(text);
		});

		child.on('error', error => {
			cancellationSubscription?.dispose();
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				reject(new Error('dotnet CLI was not found on PATH.'));
				return;
			}

			reject(error);
		});

		child.on('close', code => {
			cancellationSubscription?.dispose();
			if (cancelled) {
				reject(new Error('The dotnet test run was cancelled.'));
				return;
			}

			resolve({
				exitCode: code ?? 1,
				stdout,
				stderr,
				combined: `${stdout}\n${stderr}`,
				commandLine,
			});
		});
	});
}

function parseRunSummary(output: string, label: string): RunSummary {
	const normalizedOutput = stripAnsi(output);
	const total = readLastCount(normalizedOutput, /total:\s*(\d+)/gi);
	const passed = readLastCount(normalizedOutput, /(?:succeeded|passed):\s*(\d+)/gi);
	const failed = readLastCount(normalizedOutput, /failed:\s*(\d+)/gi);
	const skipped = readLastCount(normalizedOutput, /skipped:\s*(\d+)/gi);
	const durationMs = readLastDuration(normalizedOutput);

	return {
		label,
		total: total ?? 0,
		passed: passed ?? 0,
		failed: failed ?? 0,
		skipped: skipped ?? 0,
		projectCount: 1,
		durationMs,
		status: 'idle',
	};
}

function readLastCount(output: string, expression: RegExp): number | undefined {
	let lastValue: number | undefined;
	for (const match of output.matchAll(expression)) {
		lastValue = Number(match[1]);
	}

	return lastValue;
}

function readLastDuration(output: string): number | undefined {
	let lastDuration: number | undefined;
	for (const match of output.matchAll(/duration:\s*([\d.]+)\s*(ms|s)/gi)) {
		const amount = Number(match[1]);
		lastDuration = match[2].toLowerCase() === 's' ? amount * 1000 : amount;
	}

	return lastDuration;
}

function containsTagValue(text: string, tag: string, value: string): boolean {
	const expression = new RegExp(`<${tag}>\\s*${value}\\s*<\\/${tag}>`, 'i');
	return expression.test(text);
}

function isIgnoredPath(filePath: string): boolean {
	return IGNORED_PATH_SEGMENTS.some(segment => filePath.includes(segment));
}

function looksLikeTestName(line: string): boolean {
	if (!line.includes('.')) {
		return false;
	}

	if (line.includes('\\') || line.includes('/')) {
		return false;
	}

	const normalized = line.replace(/\(.*\)$/, '');
	return /^[A-Za-z_][\w`<>, +\[\]-]*(\.[A-Za-z_][\w`<>, +\[\]-]*)+$/.test(normalized);
}

function isNoiseLine(line: string): boolean {
	return /^(Determining projects to restore|All projects are up-to-date|Restore complete|Build succeeded\.|Build FAILED\.|Passed!|Failed!|Test run summary|Test summary|Running tests from|Results File:|Starting test execution|A total of|The following Tests are available:|Standard output:|Exit code:|xUnit\.net|NUnit Adapter|MSTest|Microsoft \(R\) Test Execution|\d+ Warning\(s\)|\d+ Error\(s\))/i.test(line);
}

function stripAnsi(text: string): string {
	return text.replace(/\u001B\[[0-9;]*m/g, '');
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}