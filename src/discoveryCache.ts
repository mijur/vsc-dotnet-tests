import type { DiscoveredClass, DiscoveredMethod, DiscoveredProject, DiscoveredSourceLocation, DiscoveredSourceRange, RunnerMode } from './model';

export const DISCOVERY_CACHE_KEY = 'dotnet-tests.discoveryCache';
const DISCOVERY_CACHE_VERSION = 1;

interface DiscoveryCacheRecord {
	version: number;
	projects: DiscoveredProject[];
}

interface DiscoveryCacheState {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): PromiseLike<void>;
}

export function readDiscoveryCache(state: DiscoveryCacheState): DiscoveredProject[] | undefined {
	const cachedValue = state.get<unknown>(DISCOVERY_CACHE_KEY);
	if (!isDiscoveryCacheRecord(cachedValue)) {
		return undefined;
	}

	return cachedValue.projects;
}

export function writeDiscoveryCache(state: DiscoveryCacheState, projects: DiscoveredProject[]): PromiseLike<void> {
	return state.update(DISCOVERY_CACHE_KEY, {
		version: DISCOVERY_CACHE_VERSION,
		projects,
	} satisfies DiscoveryCacheRecord);
}

function isDiscoveryCacheRecord(value: unknown): value is DiscoveryCacheRecord {
	if (!isRecord(value)) {
		return false;
	}

	return value.version === DISCOVERY_CACHE_VERSION
		&& Array.isArray(value.projects)
		&& value.projects.every(isDiscoveredProject);
}

function isDiscoveredProject(value: unknown): value is DiscoveredProject {
	if (!isRecord(value)) {
		return false;
	}

	return typeof value.projectPath === 'string'
		&& typeof value.label === 'string'
		&& isRunnerMode(value.runnerMode)
		&& Array.isArray(value.classes)
		&& value.classes.every(isDiscoveredClass)
		&& (value.warning === undefined || typeof value.warning === 'string');
}

function isDiscoveredClass(value: unknown): value is DiscoveredClass {
	if (!isRecord(value)) {
		return false;
	}

	return typeof value.fullyQualifiedName === 'string'
		&& typeof value.label === 'string'
		&& (value.sourceLocation === undefined || isDiscoveredSourceLocation(value.sourceLocation))
		&& Array.isArray(value.methods)
		&& value.methods.every(isDiscoveredMethod);
}

function isDiscoveredMethod(value: unknown): value is DiscoveredMethod {
	if (!isRecord(value)) {
		return false;
	}

	return typeof value.fullyQualifiedName === 'string'
		&& typeof value.label === 'string'
		&& (value.sourceLocation === undefined || isDiscoveredSourceLocation(value.sourceLocation));
}

function isDiscoveredSourceLocation(value: unknown): value is DiscoveredSourceLocation {
	if (!isRecord(value)) {
		return false;
	}

	return typeof value.filePath === 'string'
		&& isDiscoveredSourceRange(value.range);
}

function isDiscoveredSourceRange(value: unknown): value is DiscoveredSourceRange {
	if (!isRecord(value)) {
		return false;
	}

	return typeof value.startLine === 'number'
		&& typeof value.startCharacter === 'number'
		&& typeof value.endLine === 'number'
		&& typeof value.endCharacter === 'number';
}

function isRunnerMode(value: unknown): value is RunnerMode {
	return value === 'vstest' || value === 'mtp' || value === 'mtp-legacy';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}