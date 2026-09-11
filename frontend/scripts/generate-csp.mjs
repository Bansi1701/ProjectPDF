import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Generate the Content-Security-Policy after the site is built.
 *
 * A CSP is the one defence that still works when something else has already
 * gone wrong: if injected markup ever reaches a page, the browser refuses to
 * run it. It cannot be written by hand here because the policy has to name a
 * hash for every inline script the build emits, and those change whenever the
 * scripts do. So it is derived from the built output and appended to the
 * _headers file Cloudflare reads.
 *
 * Two deliberate allowances, both load-bearing for this site:
 *
 *   'wasm-unsafe-eval' — pdf.js, the HarfBuzz subsetter and the OCR engine are
 *   WebAssembly. Without it every document tool stops working. It permits
 *   compiling WASM only; it does not restore eval() for JavaScript.
 *
 *   worker-src blob: — tesseract.js spawns its worker from a blob URL, and the
 *   PDF operations run in Workers. Without it nothing leaves the main thread.
 *
 * style-src keeps 'unsafe-inline' because Astro inlines scoped component CSS
 * into every page. Injected CSS cannot execute script, so this is a far
 * smaller exposure than an inline-script allowance would be, and closing it
 * would mean hashing 110 style blocks that change on every content edit.
 *
 * JSON-LD is not hashed: `application/ld+json` is a data block, not an
 * executable script, so script-src does not apply to it.
 */
const dist = fileURLToPath(new URL('../dist/', import.meta.url));

function htmlFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return htmlFiles(path);
    return extname(entry.name) === '.html' ? [path] : [];
  });
}

const SCRIPT = /<script([^>]*)>([\s\S]*?)<\/script>/g;
const hashes = new Set();
let pages = 0;

for (const file of htmlFiles(dist)) {
  pages += 1;
  const html = readFileSync(file, 'utf8');
  for (const [, attributes, body] of html.matchAll(SCRIPT)) {
    if (/\bsrc=/.test(attributes)) continue; // external, covered by 'self'
    if (/application\/ld\+json/.test(attributes)) continue; // data, not script
    if (!body.trim()) continue;
    hashes.add(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
}

const policy = [
  "default-src 'self'",
  `script-src 'self' 'wasm-unsafe-eval' ${[...hashes].sort().join(' ')}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "media-src 'self' blob: mediastream:",
  // Same-origin engine and asset fetches only. Add the advertising origins
  // here at the same time as the ad script, never before.
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  'upgrade-insecure-requests',
].join('; ');

const headersPath = join(dist, '_headers');
const lines = readFileSync(headersPath, 'utf8').split('\n');

/* Both headers go INSIDE the existing "/*" rule rather than into a second one.
   Cloudflare merges two rules matching the same path unreliably — a duplicate
   "/*" block silently dropped X-Frame-Options and Permissions-Policy from the
   live response, which is exactly the kind of regression a security header is
   supposed to prevent. One rule, one source of truth. */
const start = lines.findIndex((line) => line.trim() === '/*');
if (start === -1) throw new Error('generate-csp: no "/*" rule found in _headers');

let end = start + 1;
while (end < lines.length && /^\s+\S/.test(lines[end])) end += 1;

lines.splice(
  end,
  0,
  `  Content-Security-Policy: ${policy}`,
  // Refuse plain HTTP for a year, closing the window where a first request
  // could be intercepted before the redirect lands.
  '  Strict-Transport-Security: max-age=31536000; includeSubDomains'
);

writeFileSync(headersPath, lines.join('\n'));

console.log(
  `CSP generated: ${hashes.size} inline-script hash${hashes.size === 1 ? '' : 'es'} across ${pages} pages; HSTS set.`
);
