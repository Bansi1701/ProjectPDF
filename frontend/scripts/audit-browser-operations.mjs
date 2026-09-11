import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';
import { Resvg } from '@resvg/resvg-js';
import { zipSync, unzipSync } from 'fflate';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const base = (process.env.PROJECTPDF_AUDIT_BASE ?? 'http://127.0.0.1:4326/ProjectPDF').replace(/\/$/, '');
const directory = await mkdtemp(join(tmpdir(), 'projectpdf-browser-'));
const encoded = (value) => new TextEncoder().encode(value);
const png = new Uint8Array(
  new Resvg(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64"><rect width="96" height="64" rx="10" fill="#e11d48"/><path d="M22 33h52M48 16v32" stroke="white" stroke-width="7" stroke-linecap="round"/></svg>'
  ).render().asPng()
);

async function fixture(name, changed = false) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([360, 480]);
  page.drawText(changed ? 'ProjectPDF changed draft' : 'ProjectPDF audited document', {
    x: 42,
    y: 408,
    size: 20,
    font,
    color: rgb(0.08, 0.12, 0.2),
  });
  page.drawText('Item', { x: 42, y: 370, size: 12, font });
  page.drawText('Total', { x: 230, y: 370, size: 12, font });
  ['Audit', 'Design', 'Testing', 'Delivery'].forEach((label, index) => {
    const y = 340 - index * 28;
    page.drawText(label, { x: 42, y, size: 11, font });
    page.drawText(String((index + 1) * 42), { x: 230, y, size: 11, font });
  });
  page.drawRectangle({ x: 36, y: 355, width: 260, height: 2, color: rgb(0.88, 0.12, 0.28) });
  const image = await doc.embedPng(png);
  page.drawImage(image, { x: 42, y: 170, width: 120, height: 60 });
  const secondPage = doc.addPage([360, 480]);
  secondPage.drawText(changed ? 'Changed second page' : 'Audited second page', {
    x: 42,
    y: 408,
    size: 20,
    font,
    color: rgb(0.08, 0.12, 0.2),
  });
  secondPage.drawText('This page validates split and multi-page operations.', {
    x: 42,
    y: 370,
    size: 11,
    font,
  });
  const path = join(directory, name);
  await writeFile(path, await doc.save({ useObjectStreams: true, addDefaultPage: false }));
  return path;
}

const pdf = await fixture('audited.pdf');
const changedPdf = await fixture('changed.pdf', true);
const image = join(directory, 'pixel.png');
await writeFile(image, png);
const textFile = join(directory, 'notes.md');
await writeFile(textFile, '# ProjectPDF audit\n\n- browser conversion\n- local processing\n', 'utf8');

const docx = join(directory, 'sample.docx');
await writeFile(
  docx,
  zipSync({
    'word/document.xml': encoded(
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>ProjectPDF audit</w:t></w:r></w:p><w:p><w:r><w:t>Word conversion works in this browser.</w:t></w:r></w:p></w:body></w:document>'
    ),
  })
);

const xlsx = join(directory, 'sample.xlsx');
await writeFile(
  xlsx,
  zipSync({
    'xl/workbook.xml': encoded(
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Audit" sheetId="1" r:id="rId1"/></sheets></workbook>'
    ),
    'xl/_rels/workbook.xml.rels': encoded(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
    ),
    'xl/worksheets/sheet1.xml': encoded(
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" t="inlineStr"><is><t>Total</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Audit</t></is></c><c r="B2"><v>42</v></c></row></sheetData></worksheet>'
    ),
  })
);

const pptx = join(directory, 'sample.pptx');
await writeFile(
  pptx,
  zipSync({
    'ppt/presentation.xml': encoded(
      '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldSz cx="9144000" cy="6858000"/><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>'
    ),
    'ppt/_rels/presentation.xml.rels': encoded(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>'
    ),
    'ppt/slides/slide1.xml': encoded(
      '<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="5486400" cy="1371600"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="2800"/><a:t>ProjectPDF browser audit</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
    ),
  })
);

// Reuse these synthetic inputs for interactive browser QA without opening a
// second browser controller. No customer documents enter this test corpus.
const fixturePassword = 'Synthetic-Password-42!';
const formPdf = await fixture('form.pdf');
{
  const doc = await PDFDocument.load(await readFile(formPdf), { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const field = doc.getForm().createTextField('AuditField');
  field.setText('Before');
  field.addToPage(doc.getPage(0), { x: 42, y: 118, width: 180, height: 28, font });
  await writeFile(formPdf, await doc.save({ useObjectStreams: true, addDefaultPage: false }));
}
const blankPdf = join(directory, 'blank.pdf');
{
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.addPage([360, 480]);
  await writeFile(blankPdf, await doc.save({ useObjectStreams: true, addDefaultPage: false }));
}
const protectedPdf = join(directory, 'protected.pdf');
{
  const doc = await PDFDocument.load(await readFile(pdf), { updateMetadata: false });
  doc.encrypt({ userPassword: fixturePassword, ownerPassword: fixturePassword, algorithm: 'AES-256', permissions: { printing: false, copying: false, modifying: false, annotating: false, fillingForms: false, contentAccessibility: true, documentAssembly: false } });
  await writeFile(protectedPdf, await doc.save({ useObjectStreams: true, addDefaultPage: false }));
}
if (process.argv.includes('--fixtures-only')) {
  const manifest = join(directory, 'manifest.json');
  await writeFile(manifest, JSON.stringify({ pdf, changedPdf, formPdf, blankPdf, protectedPdf, password: fixturePassword, image, textFile, docx, xlsx, pptx }, null, 2));
  console.log(`Synthetic audit fixtures: ${manifest}`);
  process.exit(0);
}

const cases = [
  { slug: 'merge-pdf', files: [pdf, changedPdf], timeout: 45_000, expectPdfPages: 4 },
  { slug: 'split-pdf', files: [pdf], timeout: 45_000, expectPdfPages: 1,
    prepare: async (page) => { await page.locator('[data-grid-pages] > *').first().waitFor(); await page.locator('[data-grid-cut]').first().click(); } },
  { slug: 'rotate-pdf', files: [pdf], timeout: 45_000, expectPdfPages: 2,
    prepare: async (page) => { await page.locator('[data-grid-pages] > *').first().waitFor(); await page.locator('[data-grid-turn-all="90"]').click(); } },
  { slug: 'organise-pdf', files: [pdf], timeout: 45_000, expectPdfPages: 2 },
  { slug: 'extract-pages', files: [pdf], timeout: 45_000,
    prepare: async (page) => { await page.locator('[data-grid-pages] > *').first().waitFor(); await page.locator('[data-grid-all]').click(); } },
  { slug: 'delete-pages', files: [pdf], timeout: 45_000, expectPdfPages: 2 },
  { slug: 'watermark-pdf', files: [pdf], timeout: 45_000, prepare: async (page) => page.locator('[data-text]').fill('SYNTHETIC AUDIT') },
  { slug: 'page-numbers', files: [pdf], timeout: 45_000, expectPdfPages: 2 },
  { slug: 'pdf-a', files: [blankPdf], timeout: 45_000, expectPdfPages: 1 },
  { slug: 'pdf-forms', files: [formPdf], timeout: 45_000,
    prepare: async (page) => page.locator('[data-field="AuditField"]').fill('After') },
  { slug: 'protect-pdf', files: [pdf], timeout: 45_000,
    prepare: async (page) => page.locator('[data-user-password]').fill(fixturePassword) },
  { slug: 'unlock-pdf', files: [protectedPdf], timeout: 45_000,
    prepare: async (page) => page.locator('[data-user-password]').fill(fixturePassword) },
  { slug: 'repair-pdf', files: [pdf], timeout: 45_000, expectPdfPages: 2 },
  { slug: 'scan-pdf', files: [image], timeout: 60_000, input: '.scan__picker-input', run: '[data-scan-run]' },
  { slug: 'compare-pdf', files: [pdf, changedPdf], timeout: 45_000 },
  { slug: 'pdf-to-jpg', files: [pdf], timeout: 45_000 },
  { slug: 'ocr-pdf', files: [pdf], timeout: 120_000 },
  { slug: 'pdf-to-markdown', files: [pdf], timeout: 45_000 },
  { slug: 'pdf-to-word', files: [pdf], timeout: 45_000 },
  { slug: 'pdf-to-excel', files: [pdf], timeout: 45_000 },
  { slug: 'compress-pdf', files: [pdf], timeout: 45_000 },
  { slug: 'extract-images', files: [pdf], timeout: 45_000 },
  { slug: 'grayscale-pdf', files: [pdf], timeout: 45_000 },
  { slug: 'auto-crop', files: [pdf], timeout: 45_000 },
  { slug: 'flatten-pdf', files: [pdf], timeout: 45_000 },
  { slug: 'impose-pdf', files: [pdf], timeout: 45_000 },
  { slug: 'overlay-pdf', files: [pdf, changedPdf], timeout: 45_000 },
  { slug: 'text-to-pdf', files: [textFile], timeout: 45_000 },
  {
    slug: 'split-by',
    files: [pdf],
    timeout: 45_000,
    prepare: async (page) => page.locator('[data-split-by-value]').fill('1'),
  },
  {
    slug: 'header-footer',
    files: [pdf],
    timeout: 45_000,
    prepare: async (page) => page.locator('[data-header]').fill('Audit · {page} of {pages}'),
  },
  {
    slug: 'metadata-pdf',
    files: [pdf],
    timeout: 45_000,
    prepare: async (page) => {
      await page.locator('[data-metadata-report] dl').waitFor({ state: 'visible', timeout: 30_000 });
      await page.locator('[data-metadata-field="title"]').fill('ProjectPDF browser audit');
    },
  },
  {
    slug: 'edit-pdf',
    files: [pdf],
    timeout: 45_000,
    expectPdfPages: 2,
    prepare: async (page) => {
      await page.locator('live-pdf-editor:not([hidden])').waitFor({ state: 'visible', timeout: 30_000 });
      await page.locator('[data-editor-loading]').waitFor({ state: 'hidden', timeout: 30_000 });
      await page.locator('[data-editor-menu-trigger="stamp"]').click();
      await page.locator('[data-editor-action="text"]').click();
      await page.locator('[data-editor-overlay]').click({ position: { x: 180, y: 150 } });
      await page.locator('[data-editor-onpage-text]').fill('Browser regression text');
      await page.locator('[data-editor-text-done]').click();
    },
  },
  {
    slug: 'sign-pdf',
    files: [pdf],
    timeout: 45_000,
    expectPdfPages: 2,
    prepare: async (page) => {
      await page.locator('live-pdf-editor:not([hidden])').waitFor({ state: 'visible', timeout: 30_000 });
      await page.locator('[data-editor-loading]').waitFor({ state: 'hidden', timeout: 30_000 });
      await page.locator('[data-editor-signature-trigger]').click();
      await page.locator('[data-editor-signature-text]').fill('Audit Signer');
      await page.locator('[data-editor-signature-kind="signature"]').click();
      await page.locator('[data-editor-overlay]').click({ position: { x: 210, y: 260 } });
    },
  },
  {
    slug: 'crop-pdf',
    files: [pdf],
    timeout: 45_000,
    prepare: async (page) => {
      const stage = page.locator('crop-stage:not([hidden])');
      await stage.waitFor({ state: 'visible', timeout: 30_000 });
      await stage.evaluate((element) => element.setBox({ x: 0.08, y: 0.08, width: 0.84, height: 0.84 }));
    },
  },
  {
    slug: 'redact-pdf',
    files: [pdf],
    timeout: 60_000,
    prepare: async (page) => {
      const renderedPage = page.locator('[data-pages] .page').first();
      await renderedPage.waitFor({ state: 'visible', timeout: 30_000 });
      await page.waitForFunction(() => {
        const preview = document.querySelector('[data-pages] .page');
        return preview && !preview.closest('[inert]');
      });
      await renderedPage.scrollIntoViewIfNeeded();
      const box = await renderedPage.boundingBox();
      if (!box) throw new Error('redact-pdf: rendered page has no usable bounds');
      await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.22);
      await page.mouse.up();
      await page.locator('[data-pages] .mark:not(.mark--drawing)').first().waitFor({ state: 'visible' });
      const overlay = await page.locator('[data-pages] .mark:not(.mark--drawing)').first().evaluate((mark) => ({
        position: getComputedStyle(mark).position,
        color: getComputedStyle(mark).backgroundColor,
      }));
      if (overlay.position !== 'absolute' || overlay.color !== 'rgb(0, 0, 0)') throw new Error('Redaction marks are missing the visible black overlay styling');
    },
  },
  { slug: 'jpg-to-pdf', files: [image], timeout: 45_000 },
  { slug: 'word-to-pdf', files: [docx], timeout: 45_000 },
  { slug: 'excel-to-pdf', files: [xlsx], timeout: 45_000 },
  { slug: 'powerpoint-to-pdf', files: [pptx], timeout: 45_000 },
];

async function auditEditorLayout(browser) {
  for (const viewport of [
    { name: 'desktop', width: 1280, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.goto(`${base}/edit-pdf/`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.locator('[data-input]').setInputFiles(pdf);
    await page.locator('live-pdf-editor:not([hidden])').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('[data-editor-loading]').waitFor({ state: 'hidden', timeout: 30_000 });

    const layout = await page.evaluate(() => {
      const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
      const stage = rect('[data-editor-page-stage]');
      const viewportBox = rect('[data-editor-viewport]');
      const tools = rect('.editor__tools');
      const pages = rect('.editor__pages');
      const properties = rect('.editor__properties');
      const thumb = rect('.editor-thumb');
      const actions = document.querySelector('[data-editor-inspector-actions]');
      return {
        horizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
        stageWidth: stage?.width ?? 0,
        viewportInnerWidth: document.querySelector('[data-editor-viewport]')?.clientWidth ?? 0,
        toolbarBeforePages: Boolean(tools && pages && tools.top < pages.top),
        inspectorBelowCanvas: Boolean(viewportBox && properties && properties.top >= viewportBox.bottom - 2 && Math.abs(properties.width - viewportBox.width) < 3),
        optionsCollapsed: document.querySelector('.editor__properties') instanceof HTMLDetailsElement && !document.querySelector('.editor__properties').open,
        thumbWidth: thumb?.width ?? 0,
        emptyActionsHidden: actions instanceof HTMLElement && actions.hidden,
      };
    });

    if (layout.horizontalOverflow > 2) throw new Error(`edit-pdf ${viewport.name}: ${layout.horizontalOverflow}px page overflow after upload`);
    if (layout.stageWidth <= 0 || layout.stageWidth > layout.viewportInnerWidth + 2) {
      throw new Error(`edit-pdf ${viewport.name}: page does not fit the editing canvas (${layout.stageWidth}/${layout.viewportInnerWidth})`);
    }
    if (!layout.toolbarBeforePages) throw new Error(`edit-pdf ${viewport.name}: tool rail is not above the document workspace`);
    if (!layout.emptyActionsHidden) throw new Error(`edit-pdf ${viewport.name}: object actions are visible without a selection`);
    if (!layout.inspectorBelowCanvas || !layout.optionsCollapsed) {
      throw new Error(`edit-pdf ${viewport.name}: object options should be collapsed below the full-width document canvas`);
    }
    if (viewport.name === 'mobile' && layout.thumbWidth > 100) {
      throw new Error(`edit-pdf mobile: a page thumbnail expanded to ${Math.round(layout.thumbWidth)}px`);
    }
    if (process.argv.includes('--screenshots')) {
      const output = fileURLToPath(new URL('../.tmp-test/', import.meta.url));
      await mkdir(output, { recursive: true });
      await page.locator('live-pdf-editor').screenshot({ path: join(output, `editor-${viewport.name}.png`) });
    }
    await context.close();
  }
  process.stdout.write('✓ edit-pdf responsive workspace\n');
}

async function auditWorkflows(browser) {
  const recipes = [
    ['shrink-pdf-under-upload-limit', ['flatten-pdf', 'compress-pdf']],
    ['make-print-ready-booklet', ['auto-crop', 'impose-pdf']],
    ['prepare-scanned-contract-for-filing', ['auto-crop', 'ocr-pdf', 'header-footer', 'protect-pdf']],
    ['redact-bank-statement-before-sending', ['redact-pdf', 'metadata-pdf', 'protect-pdf']],
  ];
  for (const [recipe, steps] of recipes) {
    const context = await browser.newContext({ viewport: recipe === 'redact-bank-statement-before-sending'
      ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/how-to/${recipe}/`, { waitUntil: 'networkidle' });
    await page.locator('[data-recipe-input]').setInputFiles(pdf);
    await page.locator('[data-recipe-start]').click();
    for (const [index, slug] of steps.entries()) {
      await page.waitForURL((url) => url.pathname.endsWith(`/${slug}/`) && !url.searchParams.has('from'));
      await page.locator('.workflow-banner').waitFor();
      const banner = await page.locator('.workflow-banner').textContent();
      if (!banner.includes(`Step ${index + 1} of ${steps.length}`)) throw new Error(`${recipe}: wrong step banner`);
      if (slug === 'impose-pdf' && await page.locator('[data-impose-kind]').inputValue() !== 'booklet') throw new Error('Booklet recipe did not select booklet mode');
      if (slug === 'metadata-pdf' && !await page.locator('[data-metadata-strip]').isChecked()) throw new Error('Redaction recipe did not select metadata removal');
      const test = cases.find((item) => item.slug === slug);
      if (test?.prepare && slug !== 'metadata-pdf') await test.prepare(page);
      await page.locator('[data-run]:visible').last().click();
      await page.locator('[data-result]').waitFor({ state: 'visible', timeout: 120_000 });
      if (recipe === 'redact-bank-statement-before-sending') {
        const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth);
        if (overflow > 2) throw new Error(`${slug}: workflow result overflows the mobile viewport by ${overflow}px`);
      }
      if (index < steps.length - 1) {
        if (recipe === 'shrink-pdf-under-upload-limit' && index === 0) {
          await page.locator('[data-file-rename]').first().click();
          await page.locator('[data-save-name]').fill('Renamed workflow');
          await page.locator('[data-save-confirm]').click();
        }
        await page.getByRole('button', { name: /^Continue to / }).click();
        if (recipe === 'shrink-pdf-under-upload-limit' && index === 0) {
          await page.waitForURL((url) => url.pathname.endsWith('/compress-pdf/') && !url.searchParams.has('from'));
          await page.locator('[data-files]').filter({ hasText: 'Renamed workflow.pdf' }).waitFor({ state: 'attached' });
        }
      }
      else if (!await page.getByText('Workflow complete. Review and save your finished file.').isVisible()) throw new Error(`${recipe}: completion missing`);
    }
    if (errors.length) throw new Error(`${recipe}: ${errors.join('; ')}`);
    await context.close();
    process.stdout.write(`✓ workflow ${recipe}\n`);
  }
}

async function auditHandoffClaims(browser) {
  const context = await browser.newContext();
  try {
    const seed = await context.newPage();
    await seed.goto(`${base}/compress-pdf/`, { waitUntil: 'networkidle' });
    const key = 'synthetic-single-claim';
    const bytes = Array.from(await readFile(pdf));
    await seed.evaluate(async ({ key, bytes }) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('projectpdf-handoff', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'key' });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const transaction = db.transaction('files', 'readwrite');
        transaction.objectStore('files').put({ key, name: 'synthetic.pdf', type: 'application/pdf', blob: new Blob([Uint8Array.from(bytes)], { type: 'application/pdf' }), at: Date.now() });
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error);
      });
      db.close();
    }, { key, bytes });
    const pages = await Promise.all([context.newPage(), context.newPage()]);
    await Promise.all(pages.map(async (page) => {
      await page.goto(`${base}/compress-pdf/?recipe=shrink-pdf-under-upload-limit&step=2&from=${key}`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => {
        const run = document.querySelector('[data-run]');
        const error = document.querySelector('[data-error]');
        return (run && !run.disabled) || (error && !error.hidden && error.textContent.includes('handoff'));
      });
    }));
    const winners = [];
    const losers = [];
    for (const page of pages) (await page.locator('[data-run]').isEnabled() ? winners : losers).push(page);
    if (winners.length !== 1 || losers.length !== 1) throw new Error('A temporary PDF must be claimed by exactly one tab');
    if (new URL(winners[0].url()).searchParams.has('from')) throw new Error('Successful handoff retained its consumed key');
    if (new URL(losers[0].url()).searchParams.get('from') !== key) throw new Error('Failed handoff lost its retry key');
    await losers[0].reload({ waitUntil: 'networkidle' });
    await losers[0].locator('[data-error]').waitFor({ state: 'visible' });
    if (await losers[0].locator('[data-run]').isEnabled()) throw new Error('A consumed PDF was unexpectedly opened a second time');
    process.stdout.write('✓ atomic two-tab handoff and failed-claim retry\n');
  } finally {
    await context.close();
  }
}

async function auditSaving(browser) {
  for (const width of [320, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, acceptDownloads: true });
    try {
      // Native device dialogs are mocked, never mistaken for real-phone QA.
      await context.addInitScript(() => {
        window.__saveAudit = { mode: 'success', share: null, picker: null, written: 0, revoked: [] };
        const original = URL.revokeObjectURL;
        URL.revokeObjectURL = (url) => { window.__saveAudit.revoked.push(url); original.call(URL, url); };
        Object.defineProperty(navigator, 'canShare', { configurable: true, value: ({ files }) => files?.length === 1 && files[0] instanceof File });
        Object.defineProperty(navigator, 'share', { configurable: true, value: async ({ files }) => {
          window.__saveAudit.share = { name: files[0].name, size: files[0].size, type: files[0].type, active: navigator.userActivation.isActive };
          if (window.__saveAudit.mode === 'cancel') throw new DOMException('cancelled', 'AbortError');
          if (window.__saveAudit.mode === 'error') throw new Error('unsupported');
        }});
        window.showSaveFilePicker = async ({ suggestedName }) => {
          window.__saveAudit.picker = { name: suggestedName, active: navigator.userActivation.isActive };
          if (window.__saveAudit.mode === 'cancel') throw new DOMException('cancelled', 'AbortError');
          return { name: suggestedName, createWritable: async () => ({
            write: async (blob) => { window.__saveAudit.written = blob.size; }, close: async () => {}, abort: async () => {},
          }) };
        };
      });
      const page = await context.newPage();
      await page.goto(`${base}/split-pdf/`, { waitUntil: 'networkidle' });
      await page.locator('[data-input]').setInputFiles(pdf);
      await cases.find((item) => item.slug === 'split-pdf').prepare(page);
      await page.locator('[data-run]:visible').last().click();
      await page.locator('[data-result]').waitFor({ state: 'visible' });
      if (await page.locator('[data-result-file]').count() !== 2) throw new Error('Split result should retain two files');
      const first = page.locator('[data-result-file]').first();
      await first.locator('[data-file-rename]').click();
      await page.locator('[data-save-name]').fill('Mobile result');
      await page.locator('[data-save-all]').check();
      await page.locator('[data-save-confirm]').click();
      const names = await page.locator('[data-file-download]').evaluateAll((links) => links.map((link) => link.download));
      if (names.some((name) => !name.startsWith('Mobile result') || !name.endsWith('.pdf')) || new Set(names).size !== 2) throw new Error('Batch rename did not update distinct download names');
      const pending = page.waitForEvent('download');
      await first.locator('[data-file-download]').click();
      const downloaded = await pending;
      if (downloaded.suggestedFilename() !== names[0]) throw new Error('Downloaded filename differs from visible result');
      const actual = await PDFDocument.load(await readFile(await downloaded.path()));
      if (actual.getPageCount() !== 1) throw new Error('Downloaded PDF lost its expected page');
      if (!await page.locator('[data-result]').isVisible() || await page.locator('dialog[open]').count()) throw new Error('Download unexpectedly hid results or opened Rename');
      await first.locator('[data-file-share]').click();
      await first.locator('[role=status]').filter({ hasText: 'handed to your device' }).waitFor();
      const shared = await page.evaluate(() => window.__saveAudit.share);
      if (!shared.active || shared.name !== names[0] || shared.size === 0 || shared.type !== 'application/pdf') throw new Error('Native share lost gesture, bytes or filename');
      await first.locator('[data-file-picker]').click();
      await first.locator('[role=status]').filter({ hasText: 'Saved as' }).waitFor();
      if (!await page.evaluate(() => window.__saveAudit.picker.active && window.__saveAudit.written === window.__saveAudit.share.size)) throw new Error('Picker lost gesture or file bytes');
      await page.evaluate(() => { window.__saveAudit.mode = 'cancel'; });
      await first.locator('[data-file-share]').click();
      await first.locator('[role=status]').filter({ hasText: 'cancelled' }).waitFor();
      await first.locator('[data-file-picker]').click();
      await first.locator('[role=status]').filter({ hasText: 'Save cancelled' }).waitFor();
      await page.evaluate(() => { window.__saveAudit.mode = 'error'; });
      await first.locator('[data-file-share]').click();
      await first.locator('[role=status]').filter({ hasText: 'Try Download or Open' }).waitFor();
      const popupEvent = page.waitForEvent('popup');
      await first.locator('[data-file-open]').click();
      const popup = await popupEvent;
      if (!await page.locator('[data-result]').isVisible()) throw new Error('Open replaced the tool tab');
      await popup.close();
      const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth);
      if (overflow > 2) throw new Error(`Result overflows ${width}px viewport by ${overflow}px`);
      const smallControls = await first.locator('.btn').evaluateAll((nodes) => nodes.filter((node) => !node.hidden && node.getBoundingClientRect().height < 43).length);
      if (smallControls) throw new Error('Result has undersized touch controls');
      const screenshots = fileURLToPath(new URL('../.tmp-test/mobile-saving/', import.meta.url));
      await mkdir(screenshots, { recursive: true });
      await page.locator('[data-result]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(screenshots, `saving-${width}.png`), fullPage: false });
      const previous = await first.locator('[data-file-download]').getAttribute('href');
      await page.getByRole('button', { name: 'Start over', exact: true }).click();
      if (await page.locator('[data-result-file]').count() || !await page.evaluate((url) => window.__saveAudit.revoked.includes(url), previous)) throw new Error('Reset retained result or blob URL');
      process.stdout.write(`✓ ${width}px mobile results: rename, download, open, native API mocks, cancellation and reset\n`);
    } finally { await context.close(); }
  }
  const context = await browser.newContext();
  try {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => { throw new Error('unsupported'); } });
      Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined });
    });
    const page = await context.newPage();
    await page.goto(`${base}/merge-pdf/`, { waitUntil: 'networkidle' });
    await page.locator('[data-input]').setInputFiles([pdf, changedPdf]);
    await page.locator('[data-run]:visible').last().click();
    await page.locator('[data-result]').waitFor({ state: 'visible' });
    if (await page.locator('[data-file-share]').isVisible() || await page.locator('[data-file-picker]').count()) throw new Error('Unsupported native APIs must not be offered');
    process.stdout.write('✓ unsupported native save/share safely fall back to Download/Open\n');
  } finally { await context.close(); }
}

async function auditFormCopySafety(browser) {
  const routes = new Set(['merge-pdf', 'split-pdf', 'rotate-pdf', 'organise-pdf', 'extract-pages', 'delete-pages', 'split-by', 'redact-pdf', 'unlock-pdf', 'repair-pdf']);
  for (const test of cases.filter((item) => routes.has(item.slug))) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${base}/${test.slug}/`, { waitUntil: 'networkidle' });
      await page.locator('[data-input]').setInputFiles(test.slug === 'merge-pdf' ? [pdf, formPdf] : [formPdf]);
      if (test.prepare) await test.prepare(page);
      await page.locator('[data-run]:visible').last().click();
      await page.locator('[data-error]').waitFor({ state: 'visible' });
      if (!(await page.locator('[data-error]').textContent()).includes('Flatten')) throw new Error(`${test.slug}: missing form-safety guidance`);
      if (await page.locator('[data-result]').isVisible()) throw new Error(`${test.slug}: exposed a result after refusing unsafe form copying`);
    } finally { await context.close(); }
  }
  process.stdout.write('✓ ten rebuilding tool views safely reject interactive forms with actionable guidance\n');
}

const browser = await chromium.launch({ headless: true });
const completed = [];
try {
  await auditFormCopySafety(browser);
  await auditSaving(browser);
  await auditWorkflows(browser);
  await auditHandoffClaims(browser);
  await auditEditorLayout(browser);
  for (const test of process.argv.includes('--workflows-only') ? [] : cases) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const runtimeErrors = [];
    page.on('pageerror', (error) => runtimeErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') runtimeErrors.push(message.text());
    });

    await page.goto(`${base}/${test.slug}/`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.locator(test.input ?? '[data-input]').setInputFiles(test.files);
    if (test.prepare) await test.prepare(page);
    const run = page.locator(test.run ?? '[data-run]:visible').last();
    await run.waitFor({ state: 'visible', timeout: 30_000 });
    await run.click();

    const result = page.locator(test.result ?? '[data-result]');
    const error = page.locator(test.error ?? '[data-error]');
    await Promise.race([
      result.waitFor({ state: 'visible', timeout: test.timeout }),
      error.waitFor({ state: 'visible', timeout: test.timeout }).then(async () => {
        throw new Error(`${test.slug}: ${await error.textContent()}`);
      }),
    ]);

    const downloads = await page.locator(test.downloads ?? '[data-file-download]').count();
    if (downloads === 0) throw new Error(`${test.slug}: completed without a downloadable result`);
    if (await page.locator('[data-result-file]').count() !== downloads) throw new Error(`${test.slug}: missing persistent saving controls`);
    if (await page.locator('[data-file-rename]').count() !== downloads) throw new Error(`${test.slug}: missing independent Rename`);
    if (test.expectPdfPages) {
      const bytes = await page.locator('[data-file-download]').first().evaluate(async (anchor) => {
        const response = await fetch(anchor.href);
        return Array.from(new Uint8Array(await response.arrayBuffer()));
      });
      const output = await PDFDocument.load(Uint8Array.from(bytes));
      if (output.getPageCount() !== test.expectPdfPages) {
        throw new Error(`${test.slug}: expected ${test.expectPdfPages} output pages, found ${output.getPageCount()}`);
      }
      const [first] = output.getPages();
      if (!first || Math.abs(first.getWidth() - 360) > 0.1 || Math.abs(first.getHeight() - 480) > 0.1) {
        throw new Error(`${test.slug}: output changed the source page dimensions`);
      }
    }
    if (downloads > 1) {
      for (const action of ['batch-save-all', 'share-all', 'open-all']) if (!await page.locator(`[data-${action}]`).isVisible()) throw new Error(`${test.slug}: missing ${action}`);
      await page.locator('[data-batch-save-all]').click();
      await page.locator('[data-download-all]').waitFor({ state: 'visible' });
      const zip = await page.locator('[data-download-all]').evaluate(async a => Array.from(new Uint8Array(await (await fetch(a.href)).arrayBuffer())));
      const entries = Object.values(unzipSync(Uint8Array.from(zip)));
      const originals = await page.locator('[data-file-download]').evaluateAll(async links => Promise.all(links.map(async a => Array.from(new Uint8Array(await (await fetch(a.href)).arrayBuffer())))));
      if (entries.length !== downloads || entries.some((bytes, i) => Buffer.compare(Buffer.from(bytes), Buffer.from(originals[i])) !== 0)) throw new Error(`${test.slug}: ZIP did not preserve all output bytes`);
    }
    if (runtimeErrors.length) throw new Error(`${test.slug}: ${runtimeErrors.join('; ')}`);
    if (test.slug === 'scan-pdf' || test.slug === 'redact-pdf') {
      await page.locator(test.slug === 'scan-pdf' ? '[data-scan-clear]' : '[data-clear]').click();
      if (await page.locator('[data-result-file]').count()) throw new Error(`${test.slug}: reset retained finished files`);
    }
    completed.push(test.slug);
    process.stdout.write(`✓ ${test.slug}\n`);
    await context.close();
  }
} finally {
  await browser.close();
  await rm(directory, { recursive: true, force: true });
}

console.log(`Browser operation audit: ${completed.length} renderer and conversion pipelines completed with downloadable results.`);
