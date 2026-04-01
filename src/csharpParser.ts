import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { type DiscoveredClass, type DiscoveredMethod, type DiscoveredSourceLocation } from './model';

const TEST_METHOD_ATTRIBUTE_PATTERN = /\b(TestMethod|DataTestMethod|Fact|Theory|Test|TestCase|TestCaseSource|SkippableFact|SkippableTheory)\b/i;
const TEST_CLASS_ATTRIBUTE_PATTERN = /\b(TestClass|TestFixture)\b/i;

interface ParsedClass extends DiscoveredClass {}

export interface ParseCSharpTestsOptions {
	fileContents?: ReadonlyMap<string, string>;
}

export async function parseCSharpTests(projectPath: string, options: ParseCSharpTestsOptions = {}): Promise<DiscoveredClass[]> {
	const projectDirectory = path.dirname(projectPath);
	const files = await collectCSharpFiles(projectDirectory);
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