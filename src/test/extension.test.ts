import * as assert from 'assert';
import * as vscode from 'vscode';
import { parseDetailedResultLine, parseDetailedResultsFromOutput, parseTrxResultsXml } from '../dotnet';
import type { DotnetTestsApi } from '../extension';

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

	test('registers the main commands', async () => {
		const commands = await vscode.commands.getCommands(true);
		for (const command of [
			'dotnet-tests.actions',
			'dotnet-tests.refresh',
			'dotnet-tests.runAll',
			'dotnet-tests.runNode',
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
});

function collectMethodStates(node: { kind: string; state: string; children: Array<{ kind: string; state: string; children: Array<any> }> }): string[] {
	if (node.kind === 'method') {
		return [node.state];
	}

	return node.children.flatMap(child => collectMethodStates(child));
}
