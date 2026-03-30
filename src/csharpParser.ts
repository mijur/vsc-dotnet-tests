import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { type DiscoveredClass, type DiscoveredMethod } from './model';

const TEST_METHOD_ATTRIBUTE_PATTERN = /\b(TestMethod|DataTestMethod|Fact|Theory|Test|TestCase|TestCaseSource|SkippableFact|SkippableTheory)\b/i;
const TEST_CLASS_ATTRIBUTE_PATTERN = /\b(TestClass|TestFixture)\b/i;

interface ParsedMethod extends DiscoveredMethod {
	classFullyQualifiedName: string;
}

export async function parseCSharpTests(projectPath: string): Promise<DiscoveredClass[]> {
	const projectDirectory = path.dirname(projectPath);
	const files = await collectCSharpFiles(projectDirectory);
	const classes = new Map<string, DiscoveredMethod[]>();

	for (const filePath of files) {
		const contents = await fs.readFile(filePath, 'utf8');
		for (const parsedMethod of parseMethodsFromSource(contents)) {
			const methods = classes.get(parsedMethod.classFullyQualifiedName) ?? [];
			methods.push({
				fullyQualifiedName: parsedMethod.fullyQualifiedName,
				label: parsedMethod.label,
			});
			classes.set(parsedMethod.classFullyQualifiedName, methods);
		}
	}

	return [...classes.entries()]
		.map(([fullyQualifiedName, methods]) => ({
			fullyQualifiedName,
			label: fullyQualifiedName.split('.').at(-1) ?? fullyQualifiedName,
			methods: dedupeMethods(methods),
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

function parseMethodsFromSource(source: string): ParsedMethod[] {
	const lines = source.split(/\r?\n/);
	const results: ParsedMethod[] = [];
	let namespaceName = '';
	let braceDepth = 0;
	let pendingAttributes: string[] = [];
	let attributeBuffer = '';
	let collectingAttribute = false;
	let pendingClass: { name: string; isTestClass: boolean } | undefined;
	const classStack: Array<{ name: string; depth: number; isTestClass: boolean }> = [];

	for (const line of lines) {
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
			pendingClass = {
				name: classMatch[1],
				isTestClass: pendingAttributes.some(attribute => TEST_CLASS_ATTRIBUTE_PATTERN.test(attribute)),
			};
			pendingAttributes = [];
		}

		const activeClass = classStack.at(-1);
		const methodMatch = trimmed.match(/^(?:\[[^\]]+\]\s*)*(?:public|internal|private|protected|static|virtual|sealed|override|new|unsafe|extern|partial|async|\s)+[A-Za-z_][\w<>,.?\[\]\s]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
		if (activeClass && methodMatch && pendingAttributes.some(attribute => TEST_METHOD_ATTRIBUTE_PATTERN.test(attribute))) {
			const className = [namespaceName, ...classStack.map(entry => entry.name)].filter(Boolean).join('.');
			results.push({
				classFullyQualifiedName: className,
				fullyQualifiedName: `${className}.${methodMatch[1]}`,
				label: methodMatch[1],
			});
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

	return results.filter(result => result.classFullyQualifiedName.length > 0);
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