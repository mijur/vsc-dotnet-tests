# Dotnet Tests

Dotnet Tests is a VS Code extension for discovering and running .NET tests directly from a dedicated Activity Bar view and the native Test Explorer.

## Current Features

- Recursively discovers `.csproj` test projects in the workspace.
- Uses `dotnet test --list-tests` to build a nested project, class, and method tree.
- Mirrors the same hierarchy into VS Code's native Testing API.
- Adds a dedicated Dotnet Tests Activity Bar pane.
- Runs a selected test method, class, or project.
- Runs all discovered test projects.
- Streams command output into a dedicated output channel.
- Shows summarized pass/fail counts in the tree message and status bar.
- Refreshes automatically when C#, project, or runsettings files change.

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

- Initial implementation slice for discovery, tree rendering, command execution, and summarized results.
