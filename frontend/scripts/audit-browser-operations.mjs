import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';
import { Resvg } from '@resvg/resvg-js';
import { zipSync } from 'fflate';
import { chromium } from 'playwright';

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

const cases = [
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
      const box = await renderedPage.boundingBox();
      if (!box) throw new Error('redact-pdf: rendered page has no usable bounds');
      await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.22);
      await page.mouse.up();
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
        inspectorBesideCanvas: Boolean(viewportBox && properties && properties.left >= viewportBox.right - 2),
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
    if (viewport.name === 'desktop' && !layout.inspectorBesideCanvas) {
      throw new Error('edit-pdf desktop: properties inspector is not beside the document canvas');
    }
    if (viewport.name === 'mobile' && layout.thumbWidth > 100) {
      throw new Error(`edit-pdf mobile: a page thumbnail expanded to ${Math.round(layout.thumbWidth)}px`);
    }
    await context.close();
  }
  process.stdout.write('✓ edit-pdf responsive workspace\n');
}

const browser = await chromium.launch({ headless: true });
const completed = [];
try {
  await auditEditorLayout(browser);
  for (const test of cases) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const runtimeErrors = [];
    page.on('pageerror', (error) => runtimeErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') runtimeErrors.push(message.text());
    });

    await page.goto(`${base}/${test.slug}/`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.locator('[data-input]').setInputFiles(test.files);
    if (test.prepare) await test.prepare(page);
    const run = page.locator('[data-run]:visible').last();
    await run.waitFor({ state: 'visible', timeout: 30_000 });
    await run.click();

    const result = page.locator('[data-result]');
    const error = page.locator('[data-error]');
    await Promise.race([
      result.waitFor({ state: 'visible', timeout: test.timeout }),
      error.waitFor({ state: 'visible', timeout: test.timeout }).then(async () => {
        throw new Error(`${test.slug}: ${await error.textContent()}`);
      }),
    ]);

    const downloads = await page.locator('[data-downloads] a[download]').count();
    if (downloads === 0) throw new Error(`${test.slug}: completed without a downloadable result`);
    if (test.expectPdfPages) {
      const bytes = await page.locator('[data-downloads] a[download]').first().evaluate(async (anchor) => {
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
    if (runtimeErrors.length) throw new Error(`${test.slug}: ${runtimeErrors.join('; ')}`);
    completed.push(test.slug);
    process.stdout.write(`✓ ${test.slug}\n`);
    await context.close();
  }
} finally {
  await browser.close();
  await rm(directory, { recursive: true, force: true });
}

console.log(`Browser operation audit: ${completed.length} renderer and conversion pipelines completed with downloadable results.`);
