# Dotnet Tests

Dotnet Tests is a VS Code extension for discovering and running .NET tests directly in VS Code's built-in Testing view.

## Current Features

- Recursively discovers `.csproj` test projects in the workspace.
- Uses `dotnet test --list-tests` to build a nested project, class, and method tree.
- Publishes the discovered hierarchy into VS Code's native Testing API.
- Relies on the built-in Testing pane for browsing and running tests.
- Adds source locations to discovered test classes and methods so VS Code can navigate from test items and result messages back to code.
- Runs a selected test method, class, or project.
- Runs all discovered test projects.
- Propagates the last run state down to discovered methods when a project or class run emits detailed outcomes.
- Streams command output into a dedicated output channel.
- Keeps discovery and live editor refresh behavior fully automatic.
- Refreshes automatically while editing open C# files in detected test projects, and runs authoritative rediscovery when saved project or test configuration files change.

## Commands

- `Dotnet Tests: Show Actions` opens a quick-pick for refresh, run, reveal, and output commands.
- `Dotnet Tests: Go to Test Source` opens a discovered test class or method in the editor.
- `Dotnet Tests: Refresh Discovered Tests` forces a full workspace rediscovery.
- `Dotnet Tests: Run All Tests` runs every discovered .NET test project.
- `Dotnet Tests: Run Test Target` lets you pick a discovered project, class, or method to run.
- `Dotnet Tests: Reveal in Testing View` lets you pick a discovered project, class, or method and focus it in the Testing pane.
- `Dotnet Tests: Show Output` opens the extension output channel.

You can also use `Go to Test Source` from a discovered test class or method's context menu in the Testing view, and VS Code can use the attached source locations for direct navigation from test UI elements.

## Requirements

- `dotnet` must be installed and available on `PATH`.
- Test discovery currently expects SDK-style test projects that can be listed through `dotnet test --list-tests`.

## Notes

- Runner mode is detected per project and currently distinguishes between VSTest, native Microsoft Testing Platform (MTP), and legacy MTP bridge usage.
- Method filters use `FullyQualifiedName` matching. Theory and data-driven tests may run at the method level rather than a single data row.
- When a test runner does not emit detailed per-test outcomes, the extension falls back to summarized project or node results.

## Development

- `npm run compile` builds the extension.
- `npm run watch` runs the TypeScript compiler in watch mode.
- `npm test` runs the VS Code extension test harness.
- To run the integration test suite against a real repo, set `DOTNET_TESTS_TARGET_WORKSPACE` to the target folder before `npm test`.
- Use the `Run Extension` launch configuration to start an Extension Development Host.

## Release Notes

### 0.0.1

- Initial implementation slice for discovery, Testing view integration, command execution, and summarized results.
