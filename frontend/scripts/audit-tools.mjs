import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const site = readFileSync(here('../src/config/site.ts'), 'utf8');
const types = readFileSync(here('../src/lib/pdf/types.ts'), 'utf8');
const worker = readFileSync(here('../src/lib/pdf/worker.ts'), 'utf8');
const pdfTool = readFileSync(here('../src/components/PdfTool.astro'), 'utf8');
const cropStage = readFileSync(here('../src/components/CropStage.astro'), 'utf8');
const redactTool = readFileSync(here('../src/components/RedactTool.astro'), 'utf8');

const tools = [...site.matchAll(/\{\s*slug:\s*'([^']+)'[\s\S]*?status:\s*'([^']+)'[\s\S]*?\}/g)].map(
  ([, slug, status]) => ({ slug, status })
);
const live = tools.filter(({ status }) => status === 'live');

const expectedModes = new Map([
  ['merge-pdf', 'merge'],
  ['split-pdf', 'split'],
  ['rotate-pdf', 'rotate'],
  ['organise-pdf', 'reorder'],
  ['extract-pages', 'extract'],
  ['delete-pages', 'delete'],
  ['split-by', 'split-by'],
  ['compress-pdf', 'compress'],
  ['jpg-to-pdf', 'images-to-pdf'],
  ['pdf-to-jpg', 'pdf-to-images'],
  ['pdf-to-markdown', 'pdf-to-markdown'],
  ['word-to-pdf', 'word-to-pdf'],
  ['pdf-to-word', 'pdf-to-word'],
  ['pdf-to-excel', 'pdf-to-excel'],
  ['excel-to-pdf', 'excel-to-pdf'],
  ['powerpoint-to-pdf', 'powerpoint-to-pdf'],
  ['text-to-pdf', 'text-to-pdf'],
  ['extract-images', 'extract-images'],
  ['edit-pdf', 'edit'],
  ['watermark-pdf', 'watermark'],
  ['page-numbers', 'page-numbers'],
  ['grayscale-pdf', 'grayscale'],
  ['auto-crop', 'auto-crop'],
  ['crop-pdf', 'crop'],
  ['flatten-pdf', 'flatten'],
  ['impose-pdf', 'impose'],
  ['overlay-pdf', 'overlay'],
  ['header-footer', 'header-footer'],
  ['metadata-pdf', 'metadata'],
  ['compare-pdf', 'compare'],
  ['ocr-pdf', 'ocr'],
  ['pdf-forms', 'forms'],
  ['protect-pdf', 'protect'],
  ['unlock-pdf', 'unlock'],
  ['repair-pdf', 'repair'],
  ['sign-pdf', 'sign'],
  ['pdf-a', 'pdf-a'],
]);

const operationBlock = /export type Operation\s*=([\s\S]*?);/.exec(types)?.[1] ?? '';
const operations = new Set([...operationBlock.matchAll(/'([^']+)'/g)].map((match) => match[1]));
const workerCases = new Set([...worker.matchAll(/case\s+'([^']+)'/g)].map((match) => match[1]));
const problems = [];

if (!pdfTool.includes('<LivePdfEditor profile=')) {
  problems.push('Shared PdfTool no longer mounts the live editor for Edit and Sign.');
}
if (!pdfTool.includes("mode === 'crop' && <CropStage")) {
  problems.push('Shared PdfTool no longer mounts the visual crop stage.');
}
if (/mode === '(?:edit|sign)'\s*&&\s*false/.test(pdfTool)) {
  problems.push('Disabled legacy Edit or Sign UI remains in the shared tool component.');
}
if (!cropStage.includes('this.loadingTask?.destroy()')) {
  problems.push('CropStage no longer releases its pdf.js loading task.');
}
if (!redactTool.includes('await loadingTask.destroy()')) {
  problems.push('RedactTool no longer releases its pdf.js loading task.');
}

if (live.length !== 39) {
  problems.push(`Expected 39 live tools, found ${live.length}. Update this audit when a tool is intentionally launched or retired.`);
}

for (const { slug } of live) {
  const pagePath = here(`../src/pages/${slug}.astro`);
  const contentPath = here(`../src/content/tools/${slug}.md`);
  if (!existsSync(pagePath)) problems.push(`${slug}: missing tool route`);
  if (!existsSync(contentPath)) problems.push(`${slug}: missing help/SEO content`);
  if (!existsSync(pagePath)) continue;

  const page = readFileSync(pagePath, 'utf8');
  if (slug === 'redact-pdf') {
    if (!page.includes('<RedactTool')) problems.push(`${slug}: route no longer mounts RedactTool`);
    continue;
  }
  if (slug === 'scan-pdf') {
    if (!page.includes('<ScanTool')) problems.push(`${slug}: route no longer mounts ScanTool`);
    continue;
  }

  const actualMode = /<PdfTool[\s\S]*?\bmode="([^"]+)"/.exec(page)?.[1];
  const expectedMode = expectedModes.get(slug);
  if (!actualMode) {
    problems.push(`${slug}: route does not mount PdfTool with a mode`);
  } else if (actualMode !== expectedMode) {
    problems.push(`${slug}: expected mode ${expectedMode}, found ${actualMode}`);
  }
  if (actualMode && !operations.has(actualMode)) problems.push(`${slug}: unknown operation ${actualMode}`);
  if (actualMode && !workerCases.has(actualMode)) problems.push(`${slug}: worker does not handle ${actualMode}`);
}

const workerExempt = new Set(['url-to-pdf']);
for (const operation of operations) {
  if (!workerCases.has(operation) && !workerExempt.has(operation)) {
    problems.push(`Operation ${operation} has no worker handler`);
  }
}

const unexpectedExpected = [...expectedModes.keys()].filter((slug) => !live.some((tool) => tool.slug === slug));
if (unexpectedExpected.length) problems.push(`Mode audit contains retired tools: ${unexpectedExpected.join(', ')}`);

if (problems.length) throw new Error(problems.join('\n'));

console.log(`Tool audit: ${live.length} live routes have content, the expected UI mode, and a worker handler.`);
