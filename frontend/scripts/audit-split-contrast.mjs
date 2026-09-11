import assert from 'node:assert/strict';
import { PDFDocument } from '@cantoo/pdf-lib';
import { chromium } from 'playwright';
import { join } from 'node:path';

const base = process.env.PROJECTPDF_AUDIT_BASE ?? 'http://127.0.0.1:4331';
const doc = await PDFDocument.create();
doc.addPage([420, 595]).drawText('First test page');
doc.addPage([420, 595]).drawText('Second test page');
const buffer = Buffer.from(await doc.save());
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1280, 320]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${base}/split-pdf/`);
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.locator('[data-input]').setInputFiles({ name: 'split-test.pdf', mimeType: 'application/pdf', buffer });
    const cut = page.locator('[data-grid-cut]').first();
    await cut.waitFor({ state: 'visible' });
    const check = async () => {
      const details = await cut.evaluate(button => {
        const style = getComputedStyle(button);
        const luminance = css => {
          const rgb = css.match(/[\d.]+/g).slice(0, 3).map(n => Number(n) / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
          return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
        };
        const a = luminance(style.color), b = luminance(style.backgroundColor);
        const rect = button.getBoundingClientRect();
        return { contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), width: rect.width, height: rect.height, stroke: button.querySelector('svg')?.getAttribute('stroke') };
      });
      assert.ok(details.contrast >= 4.5, `${theme}: icon contrast ${details.contrast}`);
      assert.ok(details.width >= 44 && details.height >= 44);
      assert.equal(details.stroke, 'currentColor');
    };
    await check();
    await cut.click();
    assert.equal(await cut.getAttribute('aria-pressed'), 'true');
    await check();
    await cut.focus();
    await page.keyboard.press('Space');
    assert.equal(await cut.getAttribute('aria-pressed'), 'false');
    await page.keyboard.press('Space');
    assert.equal(await cut.getAttribute('aria-pressed'), 'true');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2));
    if (process.env.SPLIT_SCREENSHOT_DIR) await page.locator('page-grid').screenshot({ path: join(process.env.SPLIT_SCREENSHOT_DIR, `split-${theme}-${width}.png`) });
    await page.locator('[data-run]').click();
    await page.locator('[data-result]').waitFor({ state: 'visible', timeout: 30000 });
    const output = await page.locator('[data-file-download]').first().evaluate(async a => Array.from(new Uint8Array(await (await fetch(a.href)).arrayBuffer())));
    assert.equal((await PDFDocument.load(Uint8Array.from(output))).getPageCount(), 1);
    await context.close();
    console.log(`PASS split scissors: ${theme}, ${width}px, contrast, touch target, keyboard and output`);
  }
} finally { await browser.close(); }
