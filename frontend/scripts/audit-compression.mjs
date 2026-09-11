import assert from 'node:assert/strict';
import { PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';

const base = process.env.PROJECTPDF_AUDIT_BASE ?? 'http://127.0.0.1:4334';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('Compression regression documents must only be opened on localhost.');
const doc = await PDFDocument.create({ updateMetadata: false });
// A redistributable dependency font, never a user's document or font program.
const fontBytes = await readFile(new URL('../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf', import.meta.url));
const fontFile = doc.context.register(doc.context.flateStream(fontBytes, { Length1: fontBytes.length }));
const descriptor = doc.context.register(doc.context.obj({ Type: 'FontDescriptor', FontName: 'LiberationSans', Flags: 32, FontBBox: [-543, -303, 1302, 981], ItalicAngle: 0, Ascent: 905, Descent: -212, CapHeight: 688, StemV: 80, FontFile2: fontFile }));
const font = doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'LiberationSans', Encoding: 'WinAnsiEncoding', FirstChar: 32, LastChar: 126, Widths: Array(95).fill(600), FontDescriptor: descriptor }));
const fixturePage = doc.addPage([595, 842]);
fixturePage.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: font } }));
fixturePage.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream('BT /F1 16 Tf 40 700 Td (Preserve words, numbers 0123456789 & symbols!) Tj ET')));
const original = process.env.COMPRESSION_INPUT ? await readFile(process.env.COMPRESSION_INPUT) : Buffer.from(await doc.save({ useObjectStreams: false }));
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    // Defense in depth: private regression input cannot reach an external host.
    await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/compress-pdf/`);
    await page.locator('[data-input]').setInputFiles({ name: 'regression.pdf', mimeType: 'application/pdf', buffer: original });
    await page.locator('[data-compression-percent="50"]').click();
    assert.equal(Number(await page.locator('[data-compression-target]').inputValue()) * 1000, Math.floor(original.length / 2));
    await page.locator('[data-compression-target]').fill('1');
    await page.locator('[data-compression-unit]').selectOption('1000');
    await page.locator('[data-run]').click();
    await page.locator('[data-result]').waitFor({ state: 'visible', timeout: 60000 });
    assert.match(await page.locator('[data-notes]').innerText(), /Target not reached/);
    assert.equal(await page.locator('input[name="image-preset"]').count(), 0);
    const bytes = await page.locator('[data-file-download]').first().evaluate(async link => Array.from(new Uint8Array(await (await fetch(link.href)).arrayBuffer())));
    assert.ok(bytes.length <= original.length);
    if (!process.env.COMPRESSION_INPUT) assert.match(await page.locator('[data-result]').innerText(), /Compacted .*embedded font programs/, 'The real browser must exercise the verified font pass');
    assert.equal((await PDFDocument.load(Uint8Array.from(bytes))).getPageCount(), (await PDFDocument.load(original)).getPageCount());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), `Overflow at ${width}px`);
    assert.deepEqual(errors, []);
    if (width === 1280 && process.env.COMPRESSION_BROWSER_OUTPUT) await writeFile(process.env.COMPRESSION_BROWSER_OUTPUT, Uint8Array.from(bytes));
    await page.locator('[data-compression-target]').fill('1000');
    await page.locator('[data-compression-unit]').selectOption('1000000');
    await page.locator('[data-run]').click();
    await page.locator('[data-notes]').filter({ hasText: 'Target met:' }).waitFor({ state: 'visible' });
    const unchanged = await page.locator('[data-file-download]').first().evaluate(async link => Array.from(new Uint8Array(await (await fetch(link.href)).arrayBuffer())));
    assert.deepEqual(Buffer.from(unchanged), original, 'An already-under-target file stays byte-identical');
    await context.close();
    console.log(`PASS compression upload, unmet target, downloadable PDF and layout at ${width}px`);
  }
} finally { await browser.close(); }
