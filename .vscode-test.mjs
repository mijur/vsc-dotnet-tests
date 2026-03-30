import { defineConfig } from '@vscode/test-cli';

const targetWorkspace = process.env.DOTNET_TESTS_TARGET_WORKSPACE;

export default defineConfig({
	files: 'out/test/**/*.test.js',
	...(targetWorkspace ? { workspaceFolder: targetWorkspace } : {}),
	mocha: {
		timeout: 300000,
	},
});
