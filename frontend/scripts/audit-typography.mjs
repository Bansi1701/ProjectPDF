import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, relative } from 'node:path';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const globalStylesPath = join(sourceRoot, 'styles', 'global.css');
const allowedWeights = new Set(['400', '500', '600', '700']);
const requiredTokens = [
  'font-sans',
  'font-display',
  'font-mono',
  'weight-regular',
  'weight-medium',
  'weight-semibold',
  'weight-bold',
  'leading-display',
  'leading-heading',
  'leading-copy',
  'leading-compact',
  'tracking-tight',
  'tracking-label',
  'step--2',
  'step--1',
  'step-0',
  'step-1',
  'step-2',
  'step-3',
  'step-4',
  'step-5',
];

async function collectStyleFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectStyleFiles(path);
    return ['.astro', '.css'].includes(extname(entry.name)) ? [path] : [];
  }));

  return nested.flat();
}

function lineNumber(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

const globalStyles = await readFile(globalStylesPath, 'utf8');
const definedTokens = new Set([...globalStyles.matchAll(/--([\w-]+)\s*:/g)].map((match) => match[1]));
const failures = [];

for (const token of requiredTokens) {
  if (!definedTokens.has(token)) failures.push(`global.css is missing --${token}`);
}

if (/fonts\.googleapis\.com/i.test(globalStyles)) {
  failures.push('global.css must use the self-hosted font files, not Google Fonts at runtime');
}

for (const path of await collectStyleFiles(sourceRoot)) {
  const source = await readFile(path, 'utf8');
  const label = relative(sourceRoot, path).replaceAll('\\', '/');

  for (const match of source.matchAll(/var\(\s*--(font-[\w-]+)/g)) {
    if (!definedTokens.has(match[1])) {
      failures.push(`${label}:${lineNumber(source, match.index)} references undefined --${match[1]}`);
    }
  }

  for (const pattern of [/font-weight\s*:\s*(\d{3})\b/g, /font\s*:\s*(\d{3})\b/g]) {
    for (const match of source.matchAll(pattern)) {
      if (!allowedWeights.has(match[1])) {
        failures.push(`${label}:${lineNumber(source, match.index)} uses unsupported font weight ${match[1]}`);
      }
    }
  }
}

if (failures.length) {
  console.error('Typography audit failed:\n');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Typography audit passed: families, roles, and loaded weights are consistent.');
