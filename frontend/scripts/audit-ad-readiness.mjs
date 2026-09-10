import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const publisher = 'ca-pub-6531092487237731';
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}
const builtFiles = files(root);
const pages = builtFiles.filter((path) => path.endsWith('.html'));
assert.ok(pages.length > 0, 'Build the site before auditing advertising readiness');
for (const path of pages) {
  const html = readFileSync(path, 'utf8');
  assert.match(html, new RegExp(`<meta\\b[^>]*name="google-adsense-account"[^>]*content="${publisher}"`), `Missing verification tag: ${path}`);
  // The current approved release is verification-only, not ad activation.
  assert.doesNotMatch(html, /<(?:script|iframe)\b[^>]*(?:googlesyndication|doubleclick|googletagmanager|fundingchoicesmessages)/i, `Ads or consent scripts activated prematurely: ${path}`);
}
for (const path of builtFiles.filter((path) => path.endsWith('.js'))) {
  assert.doesNotMatch(readFileSync(path, 'utf8'), /(?:googlesyndication\.com|doubleclick\.net|googletagmanager\.com|fundingchoicesmessages\.google\.com)/i, `Advertising runtime found in JavaScript: ${path}`);
}
assert.equal(readFileSync(join(root, 'ads.txt'), 'utf8').trim(), 'google.com, pub-6531092487237731, DIRECT, f08c47fec0942fa0');
for (const notice of ['pdf-lib', 'pdfjs', 'tesseract', 'tesseract-core', 'fflate', 'harfbuzz']) {
  assert.ok(readFileSync(join(root, 'licenses', `${notice}.txt`), 'utf8').length > 100, `Missing license: ${notice}`);
}
console.log(`Ad readiness: ${pages.length} pages have verification only; ads disabled; seller record and six engine notices present. Consent, legal and Google approval remain separate checks.`);
