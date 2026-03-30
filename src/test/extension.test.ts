import * as assert from 'assert';
import * as vscode from 'vscode';
import type { DotnetTestsApi } from '../extension';

suite('Extension Test Suite', () => {
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
	});
});
