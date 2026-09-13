import { readdir, readFile } from 'node:fs/promises';
import { isOwnershipVerification } from './ownership-verification.mjs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));

async function htmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await htmlFiles(path));
    else if (entry.name.endsWith('.html')) files.push(path);
  }
  return files;
}

const files = (await htmlFiles(dist)).filter((file) => !isOwnershipVerification(file));
const problems = [];

for (const file of files) {
  const html = await readFile(file, 'utf8');
  if (/github\.com\/Bansi1701\/ProjectPDF|public GitHub repository|Source repository:/i.test(html)) {
    problems.push(`${relative(dist, file)} exposes a removed public repository reference`);
  }
  const withoutRepositoryPaths = html
    .replaceAll('https://bansi1701.github.io/ProjectPDF', '')
    .replaceAll('https://github.com/Bansi1701/ProjectPDF', '')
    .replaceAll('/ProjectPDF/', '');
  // Lowercase legacy storage keys and logo filenames are compatibility IDs,
  // not product labels. Keep them intact for existing visitors.
  if (/ProjectPDF|Project PDF|HatePDF|HATEPDF|Hate PDF|PDFCraft/.test(withoutRepositoryPaths)) {
    problems.push(`${relative(dist, file)} still exposes the previous product name`);
  }
  if (!/<title>[^<]*Filozy[^<]*<\/title>/.test(html)) {
    problems.push(`${relative(dist, file)} is missing Filozy in the page title`);
  }
}

for (const resource of ['llms.txt', 'llms-full.txt', 'guides/feed.xml']) {
  const content = await readFile(join(dist, resource), 'utf8');
  if (/github\.com\/Bansi1701\/ProjectPDF|Source repository:/i.test(content)) problems.push(`${resource} exposes a removed public repository reference`);
  if (!content.includes('Filozy') || /HatePDF|Hate PDF|PDFCraft/i.test(content)) {
    problems.push(`${resource} has missing or outdated public branding`);
  }
}

const home = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
if (!home.includes('Filozy')) problems.push('homepage is missing the Filozy wordmark');
if (!home.includes('brand/pdfcraft-fold-mark.png')) problems.push('homepage no longer uses the approved logo asset');

const privacy = await readFile(new URL('../dist/privacy/index.html', import.meta.url), 'utf8');
const privacyVisible = privacy.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
for (const internalDetail of [
  'Complete script-initiated request audit',
  'audited manifest',
  'source files for',
  'XMLHttpRequest',
  'projectpdf-handoff',
  'localStorage',
  'IndexedDB',
]) {
  if (privacyVisible.includes(internalDetail)) problems.push(`privacy page exposes internal detail: ${internalDetail}`);
}

if (problems.length) throw new Error(problems.join('\n'));
console.log(`Brand audit: ${files.length} HTML pages use Filozy, retain the approved logo, and keep internal privacy details private.`);
