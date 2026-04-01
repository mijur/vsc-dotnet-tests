import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { mergeSourceLocationsIntoListedClasses, parseCSharpTests } from '../csharpParser';
import { DISCOVERY_CACHE_KEY, readDiscoveryCache, writeDiscoveryCache } from '../discoveryCache';
import { parseDetailedResultLine, parseDetailedResultsFromOutput, parseTrxResultsXml } from '../dotnet';
import { createUnreportedMethodCompletion, type DotnetTestsApi } from '../extension';
import { DotnetTestStore, type DiscoveredProject, type DotnetTestsSnapshotNode } from '../model';

suite('Extension Test Suite', () => {
	test('parses a single detailed result line for streaming updates', () => {
		const result = parseDetailedResultLine('Passed Tests.SampleProject.CalculatorTests.Adds_numbers [12 ms]');

		assert.deepStrictEqual(result, {
			name: 'Tests.SampleProject.CalculatorTests.Adds_numbers',
			fullyQualifiedName: 'Tests.SampleProject.CalculatorTests.Adds_numbers',
			state: 'passed',
			durationMs: 12,
		});
	});

	test('parses a single detailed result line when only the method label is reported', () => {
		const result = parseDetailedResultLine('Failed create_buyer_item_success [3 ms]');

		assert.deepStrictEqual(result, {
			name: 'create_buyer_item_success',
			fullyQualifiedName: undefined,
			state: 'failed',
			durationMs: 3,
		});
	});

	test('parses detailed console output into per-test results', () => {
		const results = parseDetailedResultsFromOutput([
			'Passed Tests.SampleProject.CalculatorTests.Adds_numbers [12 ms]',
			'Failed Tests.SampleProject.CalculatorTests.Subtracts_numbers [3 ms]',
			'Skipped Tests.SampleProject.CalculatorTests.Multiplies_numbers [1 ms]',
		].join('\n'));

		assert.deepStrictEqual(
			results.map(result => ({ name: result.name, state: result.state, durationMs: result.durationMs })),
			[
				{ name: 'Tests.SampleProject.CalculatorTests.Adds_numbers', state: 'passed', durationMs: 12 },
				{ name: 'Tests.SampleProject.CalculatorTests.Subtracts_numbers', state: 'failed', durationMs: 3 },
				{ name: 'Tests.SampleProject.CalculatorTests.Multiplies_numbers', state: 'skipped', durationMs: 1 },
			],
		);
	});

	test('parses detailed console output into per-test results when only method labels are reported', () => {
		const results = parseDetailedResultsFromOutput([
			'Passed add_payment_success [12 ms]',
			'Failed create_buyer_item_success [3 ms]',
		].join('\n'));

		assert.deepStrictEqual(
			results.map(result => ({ name: result.name, state: result.state, durationMs: result.durationMs })),
			[
				{ name: 'add_payment_success', state: 'passed', durationMs: 12 },
				{ name: 'create_buyer_item_success', state: 'failed', durationMs: 3 },
			],
		);
	});

	test('parses trx output into per-test results', () => {
		const results = parseTrxResultsXml(`<?xml version="1.0" encoding="utf-8"?>
		<TestRun>
		  <TestDefinitions>
		    <UnitTest id="test-1" name="Adds_numbers">
		      <TestMethod className="Tests.SampleProject.CalculatorTests" name="Adds_numbers" />
		    </UnitTest>
		    <UnitTest id="test-2" name="Subtracts_numbers">
		      <TestMethod className="Tests.SampleProject.CalculatorTests" name="Subtracts_numbers" />
		    </UnitTest>
		  </TestDefinitions>
		  <Results>
		    <UnitTestResult executionId="exec-1" testId="test-1" testName="Adds_numbers" outcome="Passed" duration="00:00:00.0123456" />
		    <UnitTestResult executionId="exec-2" testId="test-2" testName="Subtracts_numbers" outcome="Failed" duration="00:00:00.0030000" />
		  </Results>
		</TestRun>`);

		assert.deepStrictEqual(
			results.map(result => ({ name: result.name, state: result.state })),
			[
				{ name: 'Tests.SampleProject.CalculatorTests.Adds_numbers', state: 'passed' },
				{ name: 'Tests.SampleProject.CalculatorTests.Subtracts_numbers', state: 'failed' },
			],
		);
	});

	test('parses partial trx output into per-test results for live updates', () => {
		const results = parseTrxResultsXml(`<?xml version="1.0" encoding="utf-8"?>
		<TestRun>
		  <TestDefinitions>
		    <UnitTest id="test-1" name="Adds_numbers">
		      <TestMethod className="Tests.SampleProject.CalculatorTests" name="Adds_numbers" />
		    </UnitTest>
		  </TestDefinitions>
		  <Results>
		    <UnitTestResult executionId="exec-1" testId="test-1" testName="Adds_numbers" outcome="Passed" duration="00:00:00.0123456" />`);

		assert.deepStrictEqual(
			results.map(result => ({ name: result.name, state: result.state })),
			[
				{ name: 'Tests.SampleProject.CalculatorTests.Adds_numbers', state: 'passed' },
			],
		);
	});

	test('persists and restores the discovery cache', async () => {
		const cacheState = createCacheState();
		const projects: DiscoveredProject[] = [
			{
				projectPath: 'c:/repo/tests/Sample.Tests/Sample.Tests.csproj',
				label: 'Sample.Tests',
				runnerMode: 'vstest',
				warning: 'Using C# source fallback for test structure',
				classes: [
					{
						fullyQualifiedName: 'Sample.Tests.CalculatorTests',
						label: 'CalculatorTests',
						sourceLocation: {
							filePath: 'c:/repo/tests/Sample.Tests/CalculatorTests.cs',
							range: {
								startLine: 1,
								startCharacter: 13,
								endLine: 1,
								endCharacter: 28,
							},
						},
						methods: [
							{
								fullyQualifiedName: 'Sample.Tests.CalculatorTests.Adds_numbers',
								label: 'Adds_numbers',
								sourceLocation: {
									filePath: 'c:/repo/tests/Sample.Tests/CalculatorTests.cs',
									range: {
										startLine: 4,
										startCharacter: 16,
										endLine: 4,
										endCharacter: 28,
									},
								},
							},
						],
					},
				],
			},
		];

		await writeDiscoveryCache(cacheState, projects);

		assert.deepStrictEqual(readDiscoveryCache(cacheState), projects);
	});

	test('captures source locations for parsed test classes and methods', async () => {
		const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'dotnet-tests-source-'));
		const projectPath = path.join(tempDirectory, 'Sample.Tests.csproj');
		const filePath = path.join(tempDirectory, 'CalculatorTests.cs');

		try {
			await fs.writeFile(projectPath, '<Project Sdk="Microsoft.NET.Sdk" />', 'utf8');
			await fs.writeFile(filePath, [
				'namespace Sample.Tests;',
				'public class CalculatorTests',
				'{',
				'    [Fact]',
				'    public void Adds_numbers() {}',
				'}',
			].join('\n'), 'utf8');

			const classes = await parseCSharpTests(projectPath);
			assert.deepStrictEqual(classes[0]?.sourceLocation, {
				filePath,
				range: {
					startLine: 1,
					startCharacter: 13,
					endLine: 1,
					endCharacter: 28,
				},
			});
			assert.deepStrictEqual(classes[0]?.methods[0]?.sourceLocation, {
				filePath,
				range: {
					startLine: 4,
					startCharacter: 16,
					endLine: 4,
					endCharacter: 28,
				},
			});
		} finally {
			await fs.rm(tempDirectory, { recursive: true, force: true });
		}
	});

	test('merges source locations into listed tests', () => {
		const merged = mergeSourceLocationsIntoListedClasses(
			[
				{
					fullyQualifiedName: 'Sample.Tests.CalculatorTests',
					label: 'CalculatorTests',
					sourceLocation: {
						filePath: 'c:/repo/tests/Sample.Tests/CalculatorTests.cs',
						range: {
							startLine: 1,
							startCharacter: 13,
							endLine: 1,
							endCharacter: 28,
						},
					},
					methods: [
						{
							fullyQualifiedName: 'Sample.Tests.CalculatorTests.Adds_numbers',
							label: 'Adds_numbers',
						},
					],
				},
			],
			[
				{
					fullyQualifiedName: 'Sample.Tests.CalculatorTests',
					label: 'CalculatorTests',
					methods: [
						{
							fullyQualifiedName: 'Sample.Tests.CalculatorTests.Adds_numbers',
							label: 'Adds_numbers',
							sourceLocation: {
								filePath: 'c:/repo/tests/Sample.Tests/CalculatorTests.cs',
								range: {
									startLine: 4,
									startCharacter: 16,
									endLine: 4,
									endCharacter: 28,
								},
							},
						},
					],
				},
			],
		);

		assert.deepStrictEqual(merged[0]?.sourceLocation, {
			filePath: 'c:/repo/tests/Sample.Tests/CalculatorTests.cs',
			range: {
				startLine: 1,
				startCharacter: 13,
				endLine: 1,
				endCharacter: 28,
			},
		});

		assert.deepStrictEqual(merged[0]?.methods[0]?.sourceLocation, {
			filePath: 'c:/repo/tests/Sample.Tests/CalculatorTests.cs',
			range: {
				startLine: 4,
				startCharacter: 16,
				endLine: 4,
				endCharacter: 28,
			},
		});
	});

	test('ignores invalid discovery cache entries', () => {
		const cacheState = createCacheState({
			[DISCOVERY_CACHE_KEY]: {
				version: 1,
				projects: [
					{
						projectPath: 'c:/repo/tests/Broken.Tests/Broken.Tests.csproj',
						label: 'Broken.Tests',
						runnerMode: 'unknown',
						classes: [],
					},
				],
			},
		});

		assert.strictEqual(readDiscoveryCache(cacheState), undefined);
	});

	test('preserves matching method state across full snapshot refreshes', () => {
		const store = new DotnetTestStore();
		store.setSnapshot([createProjectSnapshot(['Adds_numbers', 'Subtracts_numbers'])]);

		const addsMethod = findNodeByLabel(store.getSnapshot()[0], 'Adds_numbers');
		assert.ok(addsMethod, 'Expected Adds_numbers to be present in the initial snapshot.');

		store.setNodeState(addsMethod!.id, 'passed', 'Passed');
		store.setSnapshot([createProjectSnapshot(['Adds_numbers', 'Multiplies_numbers'])]);

		const refreshedProject = store.getSnapshot()[0];
		assert.ok(refreshedProject, 'Expected the refreshed project to remain in the snapshot.');
		assert.strictEqual(findNodeByLabel(refreshedProject, 'Adds_numbers')?.state, 'passed');
		assert.strictEqual(findNodeByLabel(refreshedProject, 'Multiplies_numbers')?.state, 'idle');
		assert.strictEqual(findNodeByLabel(refreshedProject, 'Subtracts_numbers'), undefined);
	});

	test('preserves matching method state across single project refreshes', () => {
		const store = new DotnetTestStore();
		store.setSnapshot([createProjectSnapshot(['Adds_numbers', 'Subtracts_numbers'])]);

		const subtractsMethod = findNodeByLabel(store.getSnapshot()[0], 'Subtracts_numbers');
		assert.ok(subtractsMethod, 'Expected Subtracts_numbers to be present in the initial snapshot.');

		store.setNodeState(subtractsMethod!.id, 'failed', 'Failed');
		store.setProjectSnapshot(createProjectSnapshot(['Subtracts_numbers', 'Divides_numbers']));

		const refreshedProject = store.getSnapshot()[0];
		assert.ok(refreshedProject, 'Expected the refreshed project to remain in the snapshot.');
		assert.strictEqual(findNodeByLabel(refreshedProject, 'Subtracts_numbers')?.state, 'failed');
		assert.strictEqual(findNodeByLabel(refreshedProject, 'Divides_numbers')?.state, 'idle');
		assert.strictEqual(findNodeByLabel(refreshedProject, 'Adds_numbers'), undefined);
	});

	test('updates the whole subtree when a project run starts', () => {
		const store = new DotnetTestStore();
		store.setSnapshot([createProjectSnapshot(['Adds_numbers', 'Subtracts_numbers'])]);

		const initialProject = store.getSnapshot()[0];
		assert.ok(initialProject, 'Expected the project to be present in the initial snapshot.');

		const projectId = initialProject!.id;
		const addsMethod = findNodeByLabel(initialProject!, 'Adds_numbers');
		const subtractsMethod = findNodeByLabel(initialProject!, 'Subtracts_numbers');
		assert.ok(addsMethod, 'Expected Adds_numbers to be present in the initial snapshot.');
		assert.ok(subtractsMethod, 'Expected Subtracts_numbers to be present in the initial snapshot.');

		store.setNodeState(addsMethod!.id, 'passed', 'Passed');
		store.setNodeState(subtractsMethod!.id, 'failed', 'Failed');
		store.setSubtreeState(projectId, 'running');

		const runningProject = store.getSnapshot()[0];
		assert.ok(runningProject, 'Expected the project to remain in the snapshot.');
		assert.strictEqual(runningProject?.state, 'running');
		assert.strictEqual(findNodeByLabel(runningProject!, 'CalculatorTests')?.state, 'running');
		assert.strictEqual(findNodeByLabel(runningProject!, 'Adds_numbers')?.state, 'running');
		assert.strictEqual(findNodeByLabel(runningProject!, 'Subtracts_numbers')?.state, 'running');
	});

	test('marks unreported methods as skipped after a completed batch run', () => {
		assert.deepStrictEqual(createUnreportedMethodCompletion('passed'), {
			state: 'skipped',
			message: 'Skipped',
		});
		assert.deepStrictEqual(createUnreportedMethodCompletion('failed'), {
			state: 'skipped',
			message: 'Skipped',
		});
		assert.deepStrictEqual(createUnreportedMethodCompletion('skipped'), {
			state: 'skipped',
			message: 'Skipped',
		});
	});

	test('marks unreported methods as errored after an errored batch run', () => {
		assert.deepStrictEqual(createUnreportedMethodCompletion('errored'), {
			state: 'errored',
			message: 'Errored',
		});
	});

	test('parses overridden file contents for live editor updates', async () => {
		const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'dotnet-tests-source-'));
		const projectPath = path.join(tempDirectory, 'Sample.Tests.csproj');
		const filePath = path.join(tempDirectory, 'CalculatorTests.cs');

		try {
			await fs.writeFile(projectPath, '<Project Sdk="Microsoft.NET.Sdk" />', 'utf8');
			await fs.writeFile(filePath, [
				'namespace Sample.Tests;',
				'public class CalculatorTests',
				'{',
				'    [Fact]',
				'    public void Adds_numbers() {}',
				'}',
			].join('\n'), 'utf8');

			const classes = await parseCSharpTests(projectPath, {
				fileContents: new Map([[filePath, [
					'namespace Sample.Tests;',
					'public class CalculatorTests',
					'{',
					'    [Fact]',
					'    public void Subtracts_numbers() {}',
					'}',
				].join('\n')]]),
			});

			assert.deepStrictEqual(
				classes.flatMap(discoveredClass => discoveredClass.methods.map(method => method.label)),
				['Subtracts_numbers'],
			);
		} finally {
			await fs.rm(tempDirectory, { recursive: true, force: true });
		}
	});

	test('registers the main commands', async () => {
		const commands = await vscode.commands.getCommands(true);
		for (const command of [
			'dotnet-tests.actions',
			'dotnet-tests.openTestSource',
			'dotnet-tests.refresh',
			'dotnet-tests.runAll',
			'dotnet-tests.runNode',
			'dotnet-tests.revealInTestExplorer',
			'dotnet-tests.showOutput',
		]) {
			assert.ok(commands.includes(command), `Expected command ${command} to be registered.`);
		}
	});

	test('discovers tests in the configured target workspace', async function () {
		const targetWorkspace = process.env.DOTNET_TESTS_TARGET_WORKSPACE;
		if (!targetWorkspace) {
			this.skip();
			return;
		}

		const extension = vscode.extensions.getExtension<DotnetTestsApi>('local.dotnet-tests');
		assert.ok(extension, 'Expected the extension under test to be available.');
		const api = await extension!.activate();
		await api.refresh();

		const snapshot = api.getSnapshot();
		assert.ok(snapshot.length >= 5, `Expected at least 5 discovered test projects, found ${snapshot.length}.`);

		const labels = snapshot.map(node => node.label);
		for (const expectedLabel of [
			'Basket.UnitTests',
			'Catalog.FunctionalTests',
			'ClientApp.UnitTests',
			'Ordering.FunctionalTests',
			'Ordering.UnitTests',
		]) {
			assert.ok(labels.includes(expectedLabel), `Expected to discover project ${expectedLabel}.`);
		}

		const basketProject = snapshot.find(node => node.label === 'Basket.UnitTests');
		assert.ok(basketProject, 'Expected Basket.UnitTests to be discovered.');
		assert.ok((basketProject?.children.length ?? 0) > 0, 'Expected Basket.UnitTests to expose at least one discovered test class.');

		const runSummary = await api.runNodeById(basketProject!.id);
		assert.ok(runSummary, 'Expected a run summary from executing Basket.UnitTests.');
		assert.ok((runSummary?.total ?? 0) > 0, 'Expected Basket.UnitTests to execute at least one test.');
		assert.strictEqual(runSummary?.failed ?? 0, 0, 'Expected Basket.UnitTests to pass in the target repository.');

		const updatedProject = api.getSnapshot().find(node => node.id === basketProject!.id);
		assert.ok(updatedProject, 'Expected Basket.UnitTests to remain in the snapshot after execution.');

		const methodStates = collectMethodStates(updatedProject!);
		assert.ok(methodStates.length > 0, 'Expected Basket.UnitTests to include discovered methods after execution.');
		assert.ok(methodStates.every(state => state !== 'idle'), 'Expected a project run to update every discovered method state.');
	});

	test('runs an individual Ordering.FunctionalTests method in the configured target workspace', async function () {
		const targetWorkspace = process.env.DOTNET_TESTS_TARGET_WORKSPACE;
		if (!targetWorkspace) {
			this.skip();
			return;
		}

		const extension = vscode.extensions.getExtension<DotnetTestsApi>('local.dotnet-tests');
		assert.ok(extension, 'Expected the extension under test to be available.');
		const api = await extension!.activate();
		await api.refresh();

		const snapshot = api.getSnapshot();
		const orderingProject = snapshot.find(node => node.label === 'Ordering.FunctionalTests');
		assert.ok(orderingProject, 'Expected Ordering.FunctionalTests to be discovered.');

		const method = findNodeByLabel(orderingProject!, 'GetAllStoredOrdersWorks');
		assert.ok(method, 'Expected GetAllStoredOrdersWorks to be discovered.');
		assert.strictEqual(method?.kind, 'method', 'Expected GetAllStoredOrdersWorks to resolve to a method node.');

		const runSummary = await api.runNodeById(method!.id);
		assert.ok(runSummary, 'Expected a run summary from executing GetAllStoredOrdersWorks.');
		assert.strictEqual(runSummary?.total ?? 0, 1, 'Expected a single method run to execute exactly one test.');
		assert.strictEqual(runSummary?.failed ?? 0, 0, 'Expected GetAllStoredOrdersWorks to pass in the target repository.');

		const updatedProject = api.getSnapshot().find(node => node.id === orderingProject!.id);
		assert.ok(updatedProject, 'Expected Ordering.FunctionalTests to remain in the snapshot after execution.');
		assert.strictEqual(findNodeByLabel(updatedProject!, 'GetAllStoredOrdersWorks')?.state, 'passed');
	});
});

function collectMethodStates(node: { kind: string; state: string; children: Array<{ kind: string; state: string; children: Array<any> }> }): string[] {
	if (node.kind === 'method') {
		return [node.state];
	}

	return node.children.flatMap(child => collectMethodStates(child));
}

function findNodeByLabel(node: DotnetTestsSnapshotNode, label: string): DotnetTestsSnapshotNode | undefined {
	if (node.label === label) {
		return node;
	}

	for (const child of node.children) {
		const match = findNodeByLabel(child, label);
		if (match) {
			return match;
		}
	}

	return undefined;
}

function createProjectSnapshot(methodLabels: string[]): DiscoveredProject {
	return {
		projectPath: 'c:/repo/tests/Sample.Tests/Sample.Tests.csproj',
		label: 'Sample.Tests',
		runnerMode: 'vstest',
		classes: [
			{
				fullyQualifiedName: 'Sample.Tests.CalculatorTests',
				label: 'CalculatorTests',
				methods: methodLabels.map(label => ({
					fullyQualifiedName: `Sample.Tests.CalculatorTests.${label}`,
					label,
				})),
			},
		],
	};
}

function createCacheState(initialEntries: Record<string, unknown> = {}): {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Promise<void>;
} {
	const entries = new Map<string, unknown>(Object.entries(initialEntries));

	return {
		get<T>(key: string): T | undefined {
			return entries.get(key) as T | undefined;
		},
		update(key: string, value: unknown): Promise<void> {
			entries.set(key, value);
			return Promise.resolve();
		},
	};
}
