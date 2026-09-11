import assert from 'node:assert/strict';
import { PDFDocument } from '@cantoo/pdf-lib';
import { unzipSync } from 'fflate';
import { chromium } from 'playwright';
import { join } from 'node:path';

const base = (process.env.PROJECTPDF_AUDIT_BASE ?? 'http://127.0.0.1:4331').replace(/\/$/, '');
const doc = await PDFDocument.create();
for (let i = 1; i <= 8; i++) doc.addPage([360, 480]).drawText(`Synthetic test page ${i}`, { x: 30, y: 420, size: 16 });
const fixture = Buffer.from(await doc.save());
const browser = await chromium.launch();
try {
  for (const width of [1280, 390, 320]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript(() => {
      window.batchTest = { mode: 'ok', shared: [], revoked: [] };
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = url => { window.batchTest.revoked.push(url); revoke(url); };
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => window.batchTest.mode !== 'unsupported' });
      Object.defineProperty(navigator, 'share', { configurable: true, value: async ({ files }) => {
        window.batchTest.shared = files.map(file => ({ name: file.name, size: file.size })); window.batchTest.active = navigator.userActivation.isActive;
        if (window.batchTest.mode === 'cancel') throw new DOMException('Cancelled', 'AbortError');
        if (window.batchTest.mode === 'error') throw new Error('Cannot share');
      } });
    });
    const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/split-by/`);
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.locator('[data-input]').setInputFiles({ name: 'eight-pages.pdf', mimeType: 'application/pdf', buffer: fixture });
    await page.locator('[data-split-by-value]').fill('1');
    await page.locator('[data-run]').click(); await page.locator('[data-result]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-result-file]').count(), 8);
    assert.equal(await page.locator('[data-result-count]').innerText(), '8 files ready');
    assert.ok(await page.locator('[data-downloads]').evaluate(el => el.clientHeight >= el.scrollHeight - 2), 'All results are expanded, not inside a clipped scroller');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
    assert.ok(await page.locator('.file-result__name').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize) <= 15));
    await page.locator('[data-share-all]').click();
    assert.equal((await page.evaluate(() => window.batchTest.shared)).length, 8);
    assert.ok(await page.evaluate(() => window.batchTest.active));
    for (const mode of ['cancel', 'error', 'unsupported']) {
      await page.evaluate(mode => window.batchTest.mode = mode, mode); await page.locator('[data-share-all]').click();
      await page.waitForFunction(() => /cancelled|failed|cannot share/.test(document.querySelector('[data-batch-status]').textContent));
    }
    await page.locator('[data-batch-save-all]').click(); await page.locator('[data-download-all]').waitFor({ state: 'visible' });
    const zipUrl = await page.locator('[data-download-all]').getAttribute('href');
    const bytes = await page.locator('[data-download-all]').evaluate(async a => Array.from(new Uint8Array(await (await fetch(a.href)).arrayBuffer())));
    const entries = unzipSync(Uint8Array.from(bytes)); assert.equal(Object.keys(entries).length, 8);
    for (const bytes of Object.values(entries)) assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
    const pending = page.waitForEvent('download'); await page.locator('[data-download-all]').click(); assert.equal((await pending).suggestedFilename(), 'filozy-results.zip');
    const popupEvent = page.waitForEvent('popup'); await page.locator('[data-open-all]').click(); const popup = await popupEvent;
    assert.equal(await popup.locator('li').count(), 8); assert.equal(await popup.evaluate(() => opener === null), true);
    await popup.locator('li button').last().click(); assert.match(await popup.locator('iframe').getAttribute('src'), /^blob:/);
    assert.ok(await page.locator('[data-result]').isVisible()); await popup.close();
    await page.locator('[data-file-rename]').first().click(); await page.locator('[data-save-name]').fill('Renamed batch'); await page.locator('[data-save-all]').check(); await page.locator('[data-save-confirm]').click();
    assert.equal(await page.locator('[data-download-all]').isVisible(), false);
    assert.ok(await page.evaluate(url => window.batchTest.revoked.includes(url), zipUrl));
    await page.locator('[data-batch-save-all]').click(); await page.locator('[data-download-all]').waitFor({ state: 'visible' });
    const renamed = await page.locator('[data-download-all]').evaluate(async a => Array.from(new Uint8Array(await (await fetch(a.href)).arrayBuffer())));
    assert.ok(Object.keys(unzipSync(Uint8Array.from(renamed))).every(name => name.startsWith('Renamed batch')));
    if (process.env.BATCH_SCREENSHOT_DIR) {
      await page.locator('[data-result]').scrollIntoViewIfNeeded(); await page.screenshot({ path: join(process.env.BATCH_SCREENSHOT_DIR, `results-${theme}-${width}.png`) });
    }
    const currentZip = await page.locator('[data-download-all]').getAttribute('href');
    await page.getByRole('button', { name: 'Start over', exact: true }).click();
    assert.equal(await page.locator('[data-result-file]').count(), 0);
    assert.ok(await page.evaluate(url => window.batchTest.revoked.includes(url), currentZip));
    assert.deepEqual(errors, []); await context.close();
    console.log(`PASS 8-file batch: ZIP, sharing, viewer, rename, cleanup and layout — ${theme} ${width}px`);
  }
} finally { await browser.close(); }
