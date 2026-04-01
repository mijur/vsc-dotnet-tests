import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { type DiscoveredClass, type DiscoveredMethod, type DiscoveredSourceLocation } from './model';

const TEST_METHOD_ATTRIBUTE_PATTERN = /\b(TestMethod|DataTestMethod|Fact|Theory|Test|TestCase|TestCaseSource|SkippableFact|SkippableTheory)\b/i;
const TEST_CLASS_ATTRIBUTE_PATTERN = /\b(TestClass|TestFixture)\b/i;

interface ParsedClass extends DiscoveredClass {}

export interface ParseCSharpTestsOptions {
	fileContents?: ReadonlyMap<string, string>;
}

interface ProjectCompileSpec {
	useDefaultCompileItems: boolean;
	includePatterns: string[];
	removePatterns: string[];
}

export async function parseCSharpTests(projectPath: string, options: ParseCSharpTestsOptions = {}): Promise<DiscoveredClass[]> {
	const projectText = await fs.readFile(projectPath, 'utf8');
	const files = await collectProjectCSharpFiles(projectPath, projectText);
	const classes = new Map<string, DiscoveredClass>();
	const normalizedFileContents = options.fileContents
		? new Map([...options.fileContents.entries()].map(([filePath, contents]) => [normalizeFilePath(filePath), contents]))
		: undefined;

	for (const filePath of files) {
		const contents = normalizedFileContents?.get(normalizeFilePath(filePath)) ?? await fs.readFile(filePath, 'utf8');
		for (const parsedClass of parseClassesFromSource(contents, filePath)) {
			const existingClass = classes.get(parsedClass.fullyQualifiedName);
			classes.set(parsedClass.fullyQualifiedName, {
				fullyQualifiedName: parsedClass.fullyQualifiedName,
				label: parsedClass.label,
				sourceLocation: existingClass?.sourceLocation ?? parsedClass.sourceLocation,
				methods: [
					...(existingClass?.methods ?? []),
					...parsedClass.methods,
				],
			});
		}
	}

	return [...classes.values()]
		.map(discoveredClass => ({
			...discoveredClass,
			methods: dedupeMethods(discoveredClass.methods),
		}))
		.sort((left, right) => left.label.localeCompare(right.label));
}

export function alignSourceClassesWithListedTests(
	classes: DiscoveredClass[],
	listedTests: readonly string[],
): DiscoveredClass[] {
	if (listedTests.length === 0) {
		return classes;
	}

	const fullyQualifiedEntries = listedTests.filter(entry => entry.includes('.'));
	if (fullyQualifiedEntries.length > 0) {
		return classes;
	}

	const allowedMethodNames = new Set(listedTests.map(entry => stripParameterizedSuffix(entry.trim())).filter(Boolean));
	if (allowedMethodNames.size === 0) {
		return classes;
	}

	return classes
		.map(discoveredClass => ({
			...discoveredClass,
			methods: discoveredClass.methods.filter(method => allowedMethodNames.has(stripParameterizedSuffix(method.label))),
		}))
		.filter(discoveredClass => discoveredClass.methods.length > 0);
}

export function mergeSourceLocationsIntoListedClasses(
	classes: readonly DiscoveredClass[],
	sourceClasses: readonly DiscoveredClass[],
): DiscoveredClass[] {
	const sourceClassLocations = new Map(sourceClasses.map(discoveredClass => [discoveredClass.fullyQualifiedName, discoveredClass.sourceLocation]));
	const sourceMethods = new Map<string, DiscoveredMethod>();
	for (const sourceClass of sourceClasses) {
		for (const method of sourceClass.methods) {
			sourceMethods.set(method.fullyQualifiedName, method);
		}
	}

	return classes.map(discoveredClass => ({
		...discoveredClass,
		sourceLocation: sourceClassLocations.get(discoveredClass.fullyQualifiedName) ?? discoveredClass.sourceLocation,
		methods: discoveredClass.methods.map(method => {
			const sourceMethod = sourceMethods.get(method.fullyQualifiedName);
			return sourceMethod?.sourceLocation
				? { ...method, sourceLocation: sourceMethod.sourceLocation }
				: method;
		}),
	}));
}

async function collectProjectCSharpFiles(projectPath: string, projectText: string): Promise<string[]> {
	const projectDirectory = path.dirname(projectPath);
	const compileSpec = parseProjectCompileSpec(projectText);
	const files = new Map<string, string>();

	if (compileSpec.useDefaultCompileItems) {
		for (const filePath of await collectCSharpFiles(projectDirectory)) {
			files.set(normalizeFilePath(filePath), filePath);
		}
	}

	for (const filePath of await collectExplicitCompileFiles(projectDirectory, compileSpec.includePatterns)) {
		files.set(normalizeFilePath(filePath), filePath);
	}

	return [...files.values()]
		.filter(filePath => !matchesAnyProjectPattern(normalizeProjectRelativePath(filePath, projectDirectory), compileSpec.removePatterns))
		.sort((left, right) => left.localeCompare(right));
}

function parseProjectCompileSpec(projectText: string): ProjectCompileSpec {
	return {
		useDefaultCompileItems: readLastBooleanTagValue(projectText, 'EnableDefaultCompileItems') ?? true,
		includePatterns: readCompileItemPatterns(projectText, 'Include'),
		removePatterns: readCompileItemPatterns(projectText, 'Remove'),
	};
}

function readLastBooleanTagValue(projectText: string, tagName: string): boolean | undefined {
	const expression = new RegExp(`<${tagName}>\\s*(true|false)\\s*</${tagName}>`, 'gi');
	let lastValue: boolean | undefined;
	for (const match of projectText.matchAll(expression)) {
		lastValue = match[1].toLowerCase() === 'true';
	}

	return lastValue;
}

function readCompileItemPatterns(projectText: string, attributeName: 'Include' | 'Remove'): string[] {
	const expression = new RegExp(`<Compile\\b[^>]*\\b${attributeName}\\s*=\\s*["']([^"']+)["'][^>]*>?(?:\\s*</Compile>)?`, 'gi');
	const patterns: string[] = [];
	for (const match of projectText.matchAll(expression)) {
		patterns.push(...splitProjectItemPatterns(match[1]));
	}

	return patterns;
}

function splitProjectItemPatterns(value: string): string[] {
	return value
		.split(';')
		.map(entry => normalizeProjectPattern(entry))
		.filter(Boolean);
}

async function collectExplicitCompileFiles(projectDirectory: string, patterns: readonly string[]): Promise<string[]> {
	const files = new Map<string, string>();
	for (const pattern of patterns) {
		for (const filePath of await collectProjectPatternFiles(projectDirectory, pattern)) {
			files.set(normalizeFilePath(filePath), filePath);
		}
	}

	return [...files.values()].sort((left, right) => left.localeCompare(right));
}

async function collectProjectPatternFiles(projectDirectory: string, pattern: string): Promise<string[]> {
	if (!hasProjectPatternWildcard(pattern)) {
		const filePath = path.resolve(projectDirectory, pattern);
		return await isCSharpFile(filePath) ? [filePath] : [];
	}

	const searchRoot = getProjectPatternSearchRoot(projectDirectory, pattern);
	if (!await isDirectory(searchRoot)) {
		return [];
	}

	const files = await collectCSharpFiles(searchRoot);
	return files.filter(filePath => matchesProjectPattern(normalizeProjectRelativePath(filePath, projectDirectory), pattern));
}

async function collectCSharpFiles(directoryPath: string): Promise<string[]> {
	const entries = await fs.readdir(directoryPath, { withFileTypes: true });
	const files: string[] = [];

	for (const entry of entries) {
		if (entry.name === 'bin' || entry.name === 'obj' || entry.name.startsWith('.')) {
			continue;
		}

		const fullPath = path.join(directoryPath, entry.name);
		if (entry.isDirectory()) {
			files.push(...await collectCSharpFiles(fullPath));
			continue;
		}

		if (entry.isFile() && fullPath.endsWith('.cs')) {
			files.push(fullPath);
		}
	}

	return files;
}

async function isDirectory(filePath: string): Promise<boolean> {
	try {
		return (await fs.stat(filePath)).isDirectory();
	} catch {
		return false;
	}
}

async function isCSharpFile(filePath: string): Promise<boolean> {
	if (!filePath.toLowerCase().endsWith('.cs')) {
		return false;
	}

	try {
		return (await fs.stat(filePath)).isFile();
	} catch {
		return false;
	}
}

function normalizeProjectPattern(pattern: string): string {
	return pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function hasProjectPatternWildcard(pattern: string): boolean {
	return /[*?]/.test(pattern);
}

function getProjectPatternSearchRoot(projectDirectory: string, pattern: string): string {
	const literalSegments: string[] = [];
	for (const segment of pattern.split('/')) {
		if (segment === '**' || /[*?]/.test(segment)) {
			break;
		}

		literalSegments.push(segment);
	}

	return path.resolve(projectDirectory, ...literalSegments);
}

function normalizeProjectRelativePath(filePath: string, projectDirectory: string): string {
	return path.relative(projectDirectory, filePath).replace(/\\/g, '/');
}

function matchesAnyProjectPattern(filePath: string, patterns: readonly string[]): boolean {
	return patterns.some(pattern => matchesProjectPattern(filePath, pattern));
}

function matchesProjectPattern(filePath: string, pattern: string): boolean {
	return createProjectPatternRegExp(pattern).test(filePath);
}

function createProjectPatternRegExp(pattern: string): RegExp {
	let expression = '^';
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index];
		if (character === '*') {
			if (pattern[index + 1] === '*') {
				if (pattern[index + 2] === '/') {
					expression += '(?:[^/]+/)*';
					index += 2;
				} else {
					expression += '.*';
					index += 1;
				}
			} else {
				expression += '[^/]*';
			}
			continue;
		}

		if (character === '?') {
			expression += '[^/]';
			continue;
		}

		expression += escapeRegExpCharacter(character);
	}

	expression += '$';
	return new RegExp(expression, 'i');
}

function escapeRegExpCharacter(character: string): string {
	return /[|\\{}()[\]^$+?.]/.test(character) ? `\\${character}` : character;
}

function parseClassesFromSource(source: string, filePath: string): ParsedClass[] {
	const lines = source.split(/\r?\n/);
	const classEntries = new Map<string, ParsedClass>();
	let namespaceName = '';
	let braceDepth = 0;
	let pendingAttributes: string[] = [];
	let attributeBuffer = '';
	let collectingAttribute = false;
	let pendingClass: { name: string; isTestClass: boolean; sourceLocation: DiscoveredSourceLocation } | undefined;
	const classStack: Array<{ name: string; depth: number; isTestClass: boolean; sourceLocation: DiscoveredSourceLocation }> = [];

	for (const [lineIndex, line] of lines.entries()) {
		const trimmed = line.trim();

		if (!namespaceName) {
			const fileScopedNamespaceMatch = trimmed.match(/^namespace\s+([A-Za-z_][\w.]*)\s*;/);
			if (fileScopedNamespaceMatch) {
				namespaceName = fileScopedNamespaceMatch[1];
			}

			const blockNamespaceMatch = trimmed.match(/^namespace\s+([A-Za-z_][\w.]*)\s*\{/);
			if (blockNamespaceMatch) {
				namespaceName = blockNamespaceMatch[1];
			}
		}

		if (collectingAttribute || trimmed.startsWith('[')) {
			attributeBuffer = attributeBuffer ? `${attributeBuffer} ${trimmed}` : trimmed;
			if (trimmed.includes(']')) {
				collectingAttribute = false;
				pendingAttributes.push(attributeBuffer);
				attributeBuffer = '';
			} else {
				collectingAttribute = true;
			}
		}

		const classMatch = trimmed.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
		if (classMatch) {
			const indentation = line.length - line.trimStart().length;
			const classColumn = indentation + trimmed.indexOf(classMatch[1]);
			pendingClass = {
				name: classMatch[1],
				isTestClass: pendingAttributes.some(attribute => TEST_CLASS_ATTRIBUTE_PATTERN.test(attribute)),
				sourceLocation: createSourceLocation(filePath, lineIndex, classColumn, classMatch[1].length),
			};
			pendingAttributes = [];
		}

		const activeClass = classStack.at(-1);
		const methodMatch = trimmed.match(/^(?:\[[^\]]+\]\s*)*(?:public|internal|private|protected|static|virtual|sealed|override|new|unsafe|extern|partial|async|\s)+[A-Za-z_][\w<>,.?\[\]\s]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
		if (activeClass && methodMatch && pendingAttributes.some(attribute => TEST_METHOD_ATTRIBUTE_PATTERN.test(attribute))) {
			const className = createClassFullyQualifiedName(namespaceName, classStack);
			const classEntry = classEntries.get(className) ?? {
				fullyQualifiedName: className,
				label: className.split('.').at(-1) ?? className,
				sourceLocation: activeClass.sourceLocation,
				methods: [],
			};
			const indentation = line.length - line.trimStart().length;
			const methodColumn = indentation + trimmed.indexOf(methodMatch[1]);
			classEntry.methods.push({
				fullyQualifiedName: `${className}.${methodMatch[1]}`,
				label: methodMatch[1],
				sourceLocation: createSourceLocation(filePath, lineIndex, methodColumn, methodMatch[1].length),
			});
			classEntries.set(className, classEntry);
			pendingAttributes = [];
		}

		const openBraceCount = countCharacter(line, '{');
		const closeBraceCount = countCharacter(line, '}');
		braceDepth += openBraceCount;
		if (pendingClass && openBraceCount > closeBraceCount) {
			classStack.push({
				name: pendingClass.name,
				depth: braceDepth,
				isTestClass: pendingClass.isTestClass,
				sourceLocation: pendingClass.sourceLocation,
			});
			const className = createClassFullyQualifiedName(namespaceName, classStack);
			const existingClass = classEntries.get(className);
			classEntries.set(className, {
				fullyQualifiedName: className,
				label: pendingClass.name,
				sourceLocation: existingClass?.sourceLocation ?? pendingClass.sourceLocation,
				methods: existingClass?.methods ?? [],
			});
			pendingClass = undefined;
		}
		braceDepth -= closeBraceCount;

		while (classStack.length > 0 && braceDepth < classStack[classStack.length - 1].depth) {
			classStack.pop();
		}

		if (!trimmed.startsWith('[') && !collectingAttribute && !trimmed.startsWith("//") && !trimmed.startsWith("/*") && !trimmed.startsWith('*')) {
			pendingAttributes = [];
		}
	}

	return [...classEntries.values()]
		.filter(discoveredClass => discoveredClass.fullyQualifiedName.length > 0 && discoveredClass.methods.length > 0);
}

function createClassFullyQualifiedName(
	namespaceName: string,
	classStack: ReadonlyArray<{ name: string }>,
): string {
	return [namespaceName, ...classStack.map(entry => entry.name)].filter(Boolean).join('.');
}

function createSourceLocation(filePath: string, line: number, character: number, length: number): DiscoveredSourceLocation {
	return {
		filePath,
		range: {
			startLine: line,
			startCharacter: character,
			endLine: line,
			endCharacter: character + length,
		},
	};
}

function dedupeMethods(methods: DiscoveredMethod[]): DiscoveredMethod[] {
	const seen = new Set<string>();
	return methods.filter(method => {
		if (seen.has(method.fullyQualifiedName)) {
			return false;
		}

		seen.add(method.fullyQualifiedName);
		return true;
	});
}

function countCharacter(value: string, character: string): number {
	return [...value].filter(entry => entry === character).length;
}

function stripParameterizedSuffix(value: string): string {
	return value.replace(/\(.*\)$/, '');
}

function normalizeFilePath(filePath: string): string {
	return path.normalize(filePath).toLowerCase();
}