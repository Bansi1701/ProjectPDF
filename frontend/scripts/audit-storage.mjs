import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const extensions = new Set(['.astro', '.js', '.mjs', '.ts']);

const allowed = [
  { source: 'layouts/BaseLayout.astro', needle: 'localStorage.getItem(themeKey)' },
  { source: 'layouts/BaseLayout.astro', needle: 'localStorage.removeItem' },
  { source: 'lib/browserPreferences.ts', needle: 'localStorage.getItem(key)' },
  { source: 'lib/browserPreferences.ts', needle: 'localStorage.setItem(key' },
  { source: 'lib/browserPreferences.ts', needle: 'localStorage.removeItem(key)' },
  { source: 'lib/handoff.ts', needle: 'indexedDB.open(DB' },
  { source: 'lib/handoff.ts', needle: 'indexedDB.deleteDatabase(DB)' },
  { source: 'pages/privacy.astro', needle: "indexedDB.deleteDatabase('keyval-store')" },
];

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return files(path);
    if (!extensions.has(extname(entry.name))) return [];
    return [path];
  });
}

/* Member access, not just the four named methods: bracket reads, property
   assignment, indexedDB.databases and the OPFS entry points would all have
   slipped past the original list. */
const patterns = [
  /(?:window\.)?(?:localStorage|sessionStorage)\s*[.[]/,
  /\bindexedDB\s*\./,
  /\bdocument\.cookie\b/,
  /\bcookieStore\./,
  /\bcaches\s*\./,
  /\bserviceWorker\.register\s*\(/,
  /\bnavigator\.storage\b/,
  /\bgetDirectory\s*\(\s*\)/,
];

const calls = files(sourceRoot).flatMap((path) => {
  const source = relative(sourceRoot, path).replaceAll('\\', '/');
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

/* The scan above only sees first-party source. The tesseract worker ships
   from public/ and caches language data in IndexedDB unless told not to, so
   the privacy promise also depends on ocr.ts pinning every path to our origin
   and declining the cache. Assert the options instead of trusting review. */
const ocrSource = readFileSync(join(sourceRoot, 'lib/pdf/ocr.ts'), 'utf8');
const pinnedEngineOptions = [
  "workerPath: origin(",
  "corePath: origin(",
  "langPath: origin(",
  "cacheMethod: 'none'",
];
const unpinned = pinnedEngineOptions.filter((needle) => !ocrSource.includes(needle));

if (undocumented.length || staleRules.length || unpinned.length) {
  const problems = [
    ...undocumented.map((call) => `Undocumented browser storage at ${call.source}:${call.line}: ${call.text}`),
    ...staleRules.map((rule) => `Stale browser-storage audit rule: ${rule.source} -> ${rule.needle}`),
    ...unpinned.map((needle) => `lib/pdf/ocr.ts no longer pins the tesseract worker option ${needle} — the vendored worker would fall back to a CDN or cache language data in IndexedDB.`),
  ];
  throw new Error(problems.join('\n'));
}

if (calls.some((call) => /document\.cookie|cookieStore/.test(call.text))) {
  throw new Error('HatePDF must not set browser cookies without an approved consent design.');
}

console.log(`Storage audit: ${calls.length} approved call sites; no cookies, Cache API, or service worker storage; OCR engine options pinned.`);
