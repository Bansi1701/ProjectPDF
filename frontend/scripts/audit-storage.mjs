import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const extensions = new Set(['.astro', '.js', '.mjs', '.ts']);
const ignored = new Set(['lib/storageAudit.ts']);

const allowed = [
  { source: 'layouts/BaseLayout.astro', needle: 'localStorage.getItem(themeKey)' },
  { source: 'layouts/BaseLayout.astro', needle: 'localStorage.removeItem' },
  { source: 'lib/browserPreferences.ts', needle: 'localStorage.getItem(key)' },
  { source: 'lib/browserPreferences.ts', needle: 'localStorage.setItem(key' },
  { source: 'lib/browserPreferences.ts', needle: 'localStorage.removeItem(key)' },
  { source: 'lib/handoff.ts', needle: 'indexedDB.open(DB' },
  { source: 'lib/handoff.ts', needle: 'indexedDB.deleteDatabase(DB)' },
];

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    if (!extensions.has(extname(entry.name))) return [];
    return [path];
  });
}

const patterns = [
  /(?:window\.)?(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem|clear)\s*\(/,
  /\bindexedDB\.(?:open|deleteDatabase)\s*\(/,
  /\bdocument\.cookie\b/,
  /\bcookieStore\./,
  /\bcaches\.(?:open|match|delete|keys)\s*\(/,
  /\bserviceWorker\.register\s*\(/,
];

const calls = files(sourceRoot).flatMap((path) => {
  const source = relative(sourceRoot, path).replaceAll('\\', '/');
  if (ignored.has(source)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).flatMap((text, index) =>
    patterns.some((pattern) => pattern.test(text)) ? [{ source, line: index + 1, text: text.trim() }] : []
  );
});

const undocumented = calls.filter(
  (call) => !allowed.some((rule) => rule.source === call.source && call.text.includes(rule.needle))
);
const staleRules = allowed.filter(
  (rule) => !calls.some((call) => call.source === rule.source && call.text.includes(rule.needle))
);

if (undocumented.length || staleRules.length) {
  const problems = [
    ...undocumented.map((call) => `Undocumented browser storage at ${call.source}:${call.line}: ${call.text}`),
    ...staleRules.map((rule) => `Stale browser-storage audit rule: ${rule.source} -> ${rule.needle}`),
  ];
  throw new Error(problems.join('\n'));
}

if (calls.some((call) => /document\.cookie|cookieStore/.test(call.text))) {
  throw new Error('ProjectPDF must not set browser cookies without an approved consent design.');
}

console.log(`Storage audit: ${calls.length} approved call sites; no cookies, Cache API, or service worker storage.`);
