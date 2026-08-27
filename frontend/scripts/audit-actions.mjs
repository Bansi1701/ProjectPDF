import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const types = readFileSync(here('../src/lib/pdf/types.ts'), 'utf8');
const component = readFileSync(here('../src/components/PdfTool.astro'), 'utf8');

const operationBlock = /export type Operation\s*=([\s\S]*?);/.exec(types)?.[1] ?? '';
const actionBlock = /const ACTIONS:[\s\S]*?=\s*\{([\s\S]*?)\n\};/.exec(component)?.[1] ?? '';

if (!operationBlock || !actionBlock) {
  throw new Error('Could not read the Operation union or ACTIONS map.');
}

const operations = [...operationBlock.matchAll(/'([^']+)'/g)].map((match) => match[1]);
const actions = [...actionBlock.matchAll(/^\s*(?:'([^']+)'|([a-z][\w-]*))\s*:/gm)].map(
  (match) => match[1] ?? match[2]
);

const missing = operations.filter((operation) => !actions.includes(operation));
const unknown = actions.filter((action) => !operations.includes(action));

if (missing.length || unknown.length) {
  const problems = [
    missing.length ? `Operations without an action label: ${missing.join(', ')}` : '',
    unknown.length ? `Action labels without an operation: ${unknown.join(', ')}` : '',
  ].filter(Boolean);
  throw new Error(problems.join('\n'));
}

console.log(`Action audit: ${operations.length} operations, every primary button has a label.`);
