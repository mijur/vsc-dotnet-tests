# Copilot Instructions

This workspace is a VS Code extension for discovering and running .NET tests.

## Approach

- Explore before editing. Do not front-load large summaries when the codebase can answer the question directly.
- Share only the context needed for the current task, then expand if the evidence points elsewhere.
- Keep assumptions explicit when behavior is inferred rather than confirmed in code or tests.
- Prefer small, local changes that match the existing TypeScript extension structure.

## Exploration Workflow

- For commands, activation, views, menus, or extension wiring: inspect `package.json` and `src/extension.ts` first.
- For test discovery, runner selection, filters, or `dotnet test` execution: inspect `src/dotnet.ts` first.
- For C# source-based discovery fallback: inspect `src/csharpParser.ts`.
- For node shape, run state, and aggregate summaries: inspect `src/model.ts`.
- For tree rendering, labels, icons, and descriptions: inspect `src/tree.ts`.
- For expected behavior and coverage: inspect `src/test/**` and `README.md`.

## Topic Hints

- Search for `runnerMode`, `buildFilter`, or `parseDiscoveredTests` for .NET runner behavior.
- Search for command ids like `dotnet-tests.` for user actions and entry points.
- Search for `RunSummary`, `RunState`, or `DotnetTestNode` for shared state and UI model changes.
- Search for `discoverWorkspaceTests` or `runDotnetTarget` when tracing execution flow.

## Assumptions

- The repo favors direct module boundaries over extra abstraction.
- Discovery and execution behavior should be rooted in existing extension files before proposing broader changes.
- If a topic is unclear, gather more file-level evidence instead of inventing architecture.
