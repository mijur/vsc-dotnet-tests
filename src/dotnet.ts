import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { alignSourceClassesWithListedTests, mergeSourceLocationsIntoListedClasses, parseCSharpTests } from './csharpParser';
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
const TRX_LOG_FILE_PREFIX = 'dotnet-tests';
const LIVE_TRX_POLL_INTERVAL_MS = 200;
const TEST_PROJECT_PATTERNS = [
	/<IsTestProject>\s*true\s*<\/IsTestProject>/i,
	/Include=["']Microsoft\.NET\.Test\.Sdk["']/i,
	/Include=["']MSTest(?:\.[^"']+)?["']/i,
	/Include=["']xunit(?:\.[^"']+)?["']/i,
	/Include=["']NUnit(?:\.[^"']+)?["']/i,
	/Include=["']NUnit3TestAdapter["']/i,
	/Include=["']Microsoft\.Testing\.Extensions\.VSTestBridge["']/i,
];
const XUNIT_MTP_PACKAGE_PATTERNS = [
	/Include=["']xunit\.v3(?:\.[^"']+)?["']/i,
];

type CompletedRunState = Exclude<RunState, 'idle' | 'queued' | 'running'>;

export interface DetailedTestResult {
	name: string;
	fullyQualifiedName?: string;
	state: CompletedRunState;
	durationMs?: number;
}

export interface DotnetCommandResult {
	exitCode: number;
	status: CompletedRunState;
	commandLine: string;
	stdout: string;
	stderr: string;
	summary: RunSummary;
	testResults: DetailedTestResult[];
}

interface RunContext {
	args: string[];
	resultsDirectory?: string;
}

interface RunArgumentOptions {
	resultsDirectory?: string;
}

export interface RunDotnetTargetOptions {
	token?: vscode.CancellationToken;
	onTestResult?: (result: DetailedTestResult) => void;
}

interface ExecuteDotnetOptions extends RunDotnetTargetOptions {}

interface DetailedResultMonitor {
	stop(): Promise<void>;
}

type RunDotnetTargetArgument = RunDotnetTargetOptions | vscode.CancellationToken;

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

export async function discoverProject(projectPath: string, output: vscode.OutputChannel): Promise<DiscoveredProject | undefined> {
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
		const sourceClasses = await tryParseSourceClasses(projectPath, output);
		if (classes.length === 0 || tests.every(test => !test.includes('.'))) {
			classes = sourceClasses ? alignSourceClassesWithListedTests(sourceClasses, tests) : classes;
		} else if (sourceClasses) {
			classes = mergeSourceLocationsIntoListedClasses(classes, sourceClasses);
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

async function tryParseSourceClasses(projectPath: string, output: vscode.OutputChannel): Promise<DiscoveredClass[] | undefined> {
	try {
		return await parseCSharpTests(projectPath);
	} catch (error) {
		output.appendLine(`Failed to parse C# test sources for ${projectPath}: ${getErrorMessage(error)}`);
		return undefined;
	}
}

export async function runDotnetTarget(
	node: DotnetTestNode,
	output: vscode.OutputChannel,
	optionsOrToken: RunDotnetTargetArgument = {},
): Promise<DotnetCommandResult> {
	const options = normalizeRunDotnetTargetOptions(optionsOrToken);
	const runContext = await createRunContext(node);
	const streamedTestResults: DetailedTestResult[] = [];
	const observedLiveResults = new Set<string>();
	const emitLiveTestResult = (testResult: DetailedTestResult) => {
		const key = createObservedDetailedResultKey(testResult);
		if (observedLiveResults.has(key)) {
			return;
		}

		observedLiveResults.add(key);
		streamedTestResults.push(testResult);
		options.onTestResult?.(testResult);
	};
	const resultMonitor = startDetailedResultMonitor(runContext, emitLiveTestResult);

	try {
		const cwd = path.dirname(node.projectPath);
		const result = await executeDotnet(runContext.args, cwd, output, {
			token: options.token,
			onTestResult: runContext.resultsDirectory ? undefined : emitLiveTestResult,
		});
		await resultMonitor?.stop();
		const summary = parseRunSummary(result.combined, `Run ${node.label}`);
		const status = determineRunStatus(result.exitCode, summary);
		const parsedTestResults = await readDetailedTestResults(runContext, result.combined);
		const testResults = parsedTestResults.length > 0 ? parsedTestResults : streamedTestResults;

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
			testResults,
		};
	} finally {
		await resultMonitor?.stop();
		await cleanupRunContext(runContext);
	}
}

function normalizeRunDotnetTargetOptions(argument: RunDotnetTargetArgument): RunDotnetTargetOptions {
	if (isCancellationToken(argument)) {
		return { token: argument };
	}

	return argument;
}

function isCancellationToken(value: RunDotnetTargetArgument): value is vscode.CancellationToken {
	return typeof value === 'object'
		&& value !== null
		&& 'isCancellationRequested' in value
		&& 'onCancellationRequested' in value;
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

async function createRunContext(node: DotnetTestNode): Promise<RunContext> {
	const filterArguments = await buildFilterArguments(node);

	if (node.runnerMode === 'vstest') {
		const resultsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'dotnet-tests-'));
		return {
			resultsDirectory,
			args: buildRunArguments(node, { resultsDirectory }, filterArguments),
		};
	}

	return {
		args: buildRunArguments(node, {}, filterArguments),
	};
}

async function cleanupRunContext(runContext: RunContext): Promise<void> {
	if (!runContext.resultsDirectory) {
		return;
	}

	await fs.rm(runContext.resultsDirectory, { recursive: true, force: true });
}

function buildRunArguments(node: DotnetTestNode, runContext: RunArgumentOptions, filterArguments: string[]): string[] {
	switch (node.runnerMode) {
		case 'mtp': {
			const args = ['test', '--project', node.projectPath, '--no-ansi', '--no-progress', '--output', 'Detailed'];
			if (filterArguments.length > 0) {
				args.push(...filterArguments);
			}
			return args;
		}
		case 'mtp-legacy': {
			const args = ['test', node.projectPath, '--', '--output', 'Detailed'];
			if (filterArguments.length > 0) {
				args.push(...filterArguments);
			}
			return args;
		}
		default: {
			const args = [
				'test',
				node.projectPath,
				'--nologo',
				'--results-directory',
				runContext.resultsDirectory ?? path.join(path.dirname(node.projectPath), 'TestResults'),
				'--logger',
				'console;verbosity=detailed',
				'--logger',
				`trx;LogFilePrefix=${TRX_LOG_FILE_PREFIX}`,
			];
			if (filterArguments.length > 0) {
				args.push(...filterArguments);
			}
			return args;
		}
	}
}

async function buildFilterArguments(node: DotnetTestNode): Promise<string[]> {
	if (node.kind === 'project' || !node.fullyQualifiedName) {
		return [];
	}

	if (node.runnerMode === 'mtp' || node.runnerMode === 'mtp-legacy') {
		const projectText = await tryReadProjectText(node.projectPath);
		if (projectText && usesXunitMtpFilters(projectText)) {
			if (node.kind === 'class') {
				return ['--filter-class', node.fullyQualifiedName];
			}

			return ['--filter-method', normalizeMethodFullyQualifiedName(node.fullyQualifiedName)];
		}
	}

	const filter = buildVstestFilter(node);
	return filter ? ['--filter', filter] : [];
}

async function tryReadProjectText(projectPath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(projectPath, 'utf8');
	} catch {
		return undefined;
	}
}

function usesXunitMtpFilters(projectText: string): boolean {
	return XUNIT_MTP_PACKAGE_PATTERNS.some(pattern => pattern.test(projectText));
}

function buildVstestFilter(node: DotnetTestNode): string | undefined {
	if (node.kind === 'project' || !node.fullyQualifiedName) {
		return undefined;
	}

	if (node.kind === 'class') {
		return `FullyQualifiedName~${escapeFilterValue(`${node.fullyQualifiedName}.`)}`;
	}

	const normalized = normalizeMethodFullyQualifiedName(node.fullyQualifiedName);
	return `FullyQualifiedName~${escapeFilterValue(normalized)}`;
}

function normalizeMethodFullyQualifiedName(value: string): string {
	return value.replace(/\(.*\)$/, '');
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
	options: ExecuteDotnetOptions = {},
): Promise<ExecuteResult> {
	const commandLine = `dotnet ${args.join(' ')}`;
	output.appendLine(`$ ${commandLine}`);

	return new Promise<ExecuteResult>((resolve, reject) => {
		const child = spawn('dotnet', args, { cwd, env: process.env });
		let stdout = '';
		let stderr = '';
		let cancelled = false;
		let stdoutBuffer = '';
		let stderrBuffer = '';
		const seenDetailedResults = new Set<string>();

		const cancellationSubscription = options.token?.onCancellationRequested(() => {
			cancelled = true;
			child.kill();
		});

		child.stdout.on('data', chunk => {
			const text = chunk.toString();
			stdout += text;
			output.append(text);
			stdoutBuffer = processDetailedResultText(stdoutBuffer, text, seenDetailedResults, options.onTestResult);
		});

		child.stderr.on('data', chunk => {
			const text = chunk.toString();
			stderr += text;
			output.append(text);
			stderrBuffer = processDetailedResultText(stderrBuffer, text, seenDetailedResults, options.onTestResult);
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

			flushDetailedResultBuffer(stdoutBuffer, seenDetailedResults, options.onTestResult);
			flushDetailedResultBuffer(stderrBuffer, seenDetailedResults, options.onTestResult);

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

async function readDetailedTestResults(runContext: RunContext, output: string): Promise<DetailedTestResult[]> {
	if (runContext.resultsDirectory) {
		const trxResults = await readTrxResults(runContext.resultsDirectory);
		if (trxResults.length > 0) {
			return trxResults;
		}
	}

	return parseDetailedResultsFromOutput(output);
}

async function readTrxResults(resultsDirectory: string): Promise<DetailedTestResult[]> {
	const trxFiles = await collectFiles(resultsDirectory, filePath => filePath.toLowerCase().endsWith('.trx'));
	if (trxFiles.length === 0) {
		return [];
	}

	const results = await Promise.all(
		trxFiles.map(async trxFile => parseTrxResultsXml(await fs.readFile(trxFile, 'utf8'))),
	);

	return results.flat();
}

function startDetailedResultMonitor(
	runContext: RunContext,
	emitResult: (result: DetailedTestResult) => void,
): DetailedResultMonitor | undefined {
	if (!runContext.resultsDirectory) {
		return undefined;
	}

	let stopped = false;
	let activePoll: Promise<void> | undefined;
	const resultsDirectory = runContext.resultsDirectory;
	const poll = async () => {
		const results = await readTrxResults(resultsDirectory);
		for (const result of results) {
			emitResult(result);
		}
	};
	const schedulePoll = () => {
		if (stopped || activePoll) {
			return;
		}

		activePoll = poll()
			.catch(() => undefined)
			.finally(() => {
				activePoll = undefined;
			});
	};

	schedulePoll();
	const handle = setInterval(schedulePoll, LIVE_TRX_POLL_INTERVAL_MS);

	return {
		async stop(): Promise<void> {
			if (!stopped) {
				stopped = true;
				clearInterval(handle);
			}

			await activePoll;
		},
	};
}

async function collectFiles(directory: string, predicate: (filePath: string) => boolean): Promise<string[]> {
	try {
		const entries = await fs.readdir(directory, { withFileTypes: true, encoding: 'utf8' });
		const files: string[] = [];
		for (const entry of entries) {
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				files.push(...await collectFiles(entryPath, predicate));
				continue;
			}

			if (predicate(entryPath)) {
				files.push(entryPath);
			}
		}

		return files;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}

		throw error;
	}
}

export function parseDetailedResultsFromOutput(output: string): DetailedTestResult[] {
	const lines = stripAnsi(output).split(/\r?\n/);
	const prefixedResults = lines
		.map(parsePrefixedResultLine)
		.filter((result): result is DetailedTestResult => result !== undefined);

	if (prefixedResults.length > 0) {
		return dedupeDetailedResults(prefixedResults);
	}

	return dedupeDetailedResults(
		lines
			.map(parseBracketedResultLine)
			.filter((result): result is DetailedTestResult => result !== undefined),
	);
}

export function parseDetailedResultLine(line: string): DetailedTestResult | undefined {
	return parsePrefixedResultLine(line) ?? parseBracketedResultLine(line);
}

export function parseTrxResultsXml(contents: string): DetailedTestResult[] {
	const testDefinitions = new Map<string, string>();
	const definitionPattern = /<UnitTest\b[\s\S]*?\bid="([^"]+)"[\s\S]*?<TestMethod\b[^>]*className="([^"]+)"[^>]*name="([^"]+)"[\s\S]*?<\/UnitTest>/g;
	for (const match of contents.matchAll(definitionPattern)) {
		const testId = decodeXmlAttribute(match[1]);
		const className = decodeXmlAttribute(match[2]).split(',')[0]?.trim();
		const methodName = decodeXmlAttribute(match[3]).trim();
		if (!testId || !className || !methodName) {
			continue;
		}

		testDefinitions.set(testId, `${className}.${methodName}`);
	}

	const results: DetailedTestResult[] = [];
	const resultPattern = /<UnitTestResult\b([\s\S]*?)(?:\/>|>[\s\S]*?<\/UnitTestResult>)/g;
	for (const match of contents.matchAll(resultPattern)) {
		const attributes = parseXmlAttributes(match[1]);
		const state = mapTrxOutcome(attributes.outcome);
		if (!state) {
			continue;
		}

		const fullyQualifiedName = attributes.testId ? testDefinitions.get(attributes.testId) : undefined;
		const fallbackName = decodeXmlAttribute(attributes.testName ?? '').trim();
		const name = fullyQualifiedName ?? fallbackName;
		if (!name) {
			continue;
		}

		results.push({
			name,
			fullyQualifiedName,
			state,
			durationMs: parseTrxDuration(attributes.duration),
		});
	}

	return results;
}

function parsePrefixedResultLine(line: string): DetailedTestResult | undefined {
	const match = line.trim().match(/^(Passed|Failed|Skipped)\s+(.+)$/i);
	if (!match) {
		return undefined;
	}

	const name = extractReportedTestName(match[2]);
	if (!name) {
		return undefined;
	}

	return {
		name,
		fullyQualifiedName: name.includes('.') ? stripParameterizedSuffix(name) : undefined,
		state: normalizeCompletedState(match[1]),
		durationMs: readInlineDuration(match[2]),
	};
}

function parseBracketedResultLine(line: string): DetailedTestResult | undefined {
	const match = line.trim().match(/^\[[^\]]+\]\s+(.+?)\s+\[(PASS|FAIL|SKIP|SKIPPED)\]\s*$/i);
	if (!match) {
		return undefined;
	}

	const name = extractReportedTestName(match[1]);
	if (!name) {
		return undefined;
	}

	return {
		name,
		fullyQualifiedName: name.includes('.') ? stripParameterizedSuffix(name) : undefined,
		state: normalizeCompletedState(match[2]),
	};
}

function extractReportedTestName(text: string): string | undefined {
	const candidate = text
		.replace(/\s+\[[\d.]+\s*(?:ms|s)\]\s*$/i, '')
		.replace(/\s+\([\d.]+\s*(?:ms|s)\)\s*$/i, '')
		.trim();
	const normalizedCandidate = stripParameterizedSuffix(candidate);

	const trailingNameMatch = candidate.match(/[A-Za-z_][\w`<>, +\[\]-]*(?:\.[A-Za-z_][\w`<>, +\[\]-]*)+(?:\([^)]*\))?$/);
	if (trailingNameMatch) {
		return trailingNameMatch[0].trim();
	}

	return looksLikeTestName(normalizedCandidate) || looksLikeReportedMethodLabel(normalizedCandidate)
		? candidate
		: undefined;
}

function dedupeDetailedResults(results: DetailedTestResult[]): DetailedTestResult[] {
	const unique = new Map<string, DetailedTestResult>();
	for (const result of results) {
		const key = createDetailedResultKey(result);
		if (!unique.has(key)) {
			unique.set(key, result);
		}
	}

	return [...unique.values()];
}

function normalizeReportedName(value: string): string {
	return stripParameterizedSuffix(value).replace(/\s+/g, ' ').trim();
}

function createDetailedResultKey(result: DetailedTestResult): string {
	return `${result.state}:${normalizeReportedName(result.fullyQualifiedName ?? result.name)}:${result.durationMs ?? ''}`;
}

function createObservedDetailedResultKey(result: DetailedTestResult): string {
	return `${result.state}:${normalizeReportedName(result.fullyQualifiedName ?? result.name)}`;
}

function processDetailedResultText(
	buffer: string,
	text: string,
	seenDetailedResults: Set<string>,
	onTestResult?: (result: DetailedTestResult) => void,
): string {
	const combined = buffer + text;
	const lines = combined.split(/\r?\n/);
	const remainder = lines.pop() ?? '';

	for (const line of lines) {
		emitDetailedResultLine(line, seenDetailedResults, onTestResult);
	}

	return remainder;
}

function flushDetailedResultBuffer(
	buffer: string,
	seenDetailedResults: Set<string>,
	onTestResult?: (result: DetailedTestResult) => void,
): void {
	if (!buffer.trim()) {
		return;
	}

	emitDetailedResultLine(buffer, seenDetailedResults, onTestResult);
}

function emitDetailedResultLine(
	line: string,
	seenDetailedResults: Set<string>,
	onTestResult?: (result: DetailedTestResult) => void,
): void {
	const result = parseDetailedResultLine(line);
	if (!result) {
		return;
	}

	const key = createDetailedResultKey(result);
	if (seenDetailedResults.has(key)) {
		return;
	}

	seenDetailedResults.add(key);
	onTestResult?.(result);
}

function stripParameterizedSuffix(value: string): string {
	return value
		.replace(/\s*\([^)]*\)\s*$/, '')
		.replace(/\s*\[[^\]]+\]\s*$/, '')
		.trim();
}

function readInlineDuration(text: string): number | undefined {
	const match = text.match(/(?:\[|\()([\d.]+)\s*(ms|s)(?:\]|\))\s*$/i);
	if (!match) {
		return undefined;
	}

	const amount = Number(match[1]);
	if (!Number.isFinite(amount)) {
		return undefined;
	}

	return match[2].toLowerCase() === 's' ? amount * 1000 : amount;
}

function normalizeCompletedState(value: string): CompletedRunState {
	switch (value.toLowerCase()) {
		case 'passed':
		case 'pass':
			return 'passed';
		case 'failed':
		case 'fail':
			return 'failed';
		default:
			return 'skipped';
	}
}

function parseXmlAttributes(fragment: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	for (const match of fragment.matchAll(/([A-Za-z_:][A-Za-z0-9_.:-]*)="([^"]*)"/g)) {
		attributes[match[1]] = decodeXmlAttribute(match[2]);
	}

	return attributes;
}

function decodeXmlAttribute(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

function mapTrxOutcome(outcome: string | undefined): CompletedRunState | undefined {
	if (!outcome) {
		return undefined;
	}

	switch (outcome.toLowerCase()) {
		case 'passed':
			return 'passed';
		case 'failed':
			return 'failed';
		case 'notexecuted':
		case 'skipped':
		case 'pending':
			return 'skipped';
		case 'error':
		case 'timeout':
		case 'aborted':
			return 'errored';
		default:
			return undefined;
	}
}

function parseTrxDuration(duration: string | undefined): number | undefined {
	if (!duration) {
		return undefined;
	}

	const match = duration.match(/^(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?$/);
	if (!match) {
		return undefined;
	}

	const hours = Number(match[1] ?? 0);
	const minutes = Number(match[2]);
	const seconds = Number(match[3]);
	const fraction = Number(`0.${match[4] ?? '0'}`);

	return ((hours * 60 * 60) + (minutes * 60) + seconds + fraction) * 1000;
}

function determineRunStatus(exitCode: number, summary: RunSummary): CompletedRunState {
	if (summary.failed > 0) {
		return 'failed';
	}

	if (summary.total > 0 && summary.skipped === summary.total) {
		return 'skipped';
	}

	if (exitCode === 0) {
		return 'passed';
	}

	if (summary.total > 0 || summary.skipped > 0) {
		return 'failed';
	}

	return 'errored';
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

export function isIgnoredPath(filePath: string): boolean {
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

function looksLikeReportedMethodLabel(line: string): boolean {
	if (!line || line.includes('\\') || line.includes('/')) {
		return false;
	}

	return /^[A-Za-z_][\w`<>, +\[\]-]*$/.test(line);
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