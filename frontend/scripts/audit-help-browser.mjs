import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';

const base = (process.env.PROJECTPDF_AUDIT_BASE ?? 'http://127.0.0.1:4331').replace(/\/$/, '');
const site = await readFile(new URL('../src/config/site.ts', import.meta.url), 'utf8');
const slugs = [...site.matchAll(/slug:\s*'([^']+)'[^}]*?status:\s*'live'/g)].map(([, slug]) => slug);
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  for (const width of process.argv.includes('--capture-only') ? [] : [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const slug of slugs) {
      assert.ok((await page.goto(`${base}/help/${slug}/`))?.ok(), `Help route: ${slug}`);
      await page.evaluate(() => document.fonts.ready);
      const exampleImage = page.locator('.example-image img');
      if (await exampleImage.count()) {
        await exampleImage.scrollIntoViewIfNeeded();
        await exampleImage.evaluate((image) => image.decode());
      }
      const result = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - innerWidth,
        steps: document.querySelectorAll('#how-to-use .steps li').length,
        troubleshooting: document.querySelector('#troubleshooting')?.textContent?.trim().length ?? 0,
        brokenImage: [...document.images].some((image) => image.complete && image.naturalWidth === 0),
      }));
      assert.ok(result.overflow <= 1, `${slug} at ${width}px overflows ${result.overflow}px`);
      assert.equal(result.steps, 3, `${slug}: example steps`);
      assert.ok(result.troubleshooting > 200, `${slug}: substantive troubleshooting`);
      assert.ok(!result.brokenImage, `${slug}: broken image`);
      await page.locator('.article-toc a[href="#troubleshooting"]').click();
      assert.equal(new URL(page.url()).hash, '#troubleshooting');
    }
    console.log(`Checked ${slugs.length} Help pages at ${width}px.`);
  }
  // Explicit capture uses fictional, generated fixtures only. It never reads a user's documents.
  if (process.argv.includes('--capture') || process.argv.includes('--capture-only')) {
    const directory = fileURLToPath(new URL('../public/help/', import.meta.url));
    await mkdir(directory, { recursive: true });
    async function fixture(name, count) {
      const pdf = await PDFDocument.create();
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      for (let index = 1; index <= count; index++) {
        const sheet = pdf.addPage([360, 480]);
        sheet.drawText(name, { x: 30, y: 410, size: 20, font });
        sheet.drawText(`Page ${index} - fictional example`, { x: 30, y: 375, size: 12, font });
        sheet.drawText('No personal document data.', { x: 30, y: 340, size: 12, font });
      }
      return { name: `${name}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) };
    }
    await page.setViewportSize({ width: 1100, height: 1000 });
    for (const [slug, files, count] of [
      ['merge-pdf', [await fixture('Cover letter', 1), await fixture('Resume', 2), await fixture('Portfolio', 4)], 7],
      ['split-pdf', [await fixture('Two chapters', 6)], 6],
    ]) {
      await page.goto(`${base}/${slug}/`);
      await page.locator('[data-input]').setInputFiles(files);
      await page.locator('page-grid').waitFor({ state: 'visible' });
      await page.waitForFunction((expected) => document.querySelectorAll('page-grid .page-cell canvas').length === expected, count);
      await page.evaluate(() => document.fonts.ready);
      await page.locator('page-grid').screenshot({ path: `${directory}/${slug}-example.png`, animations: 'disabled' });
    }
    console.log('Captured two real interface screenshots using fictional documents.');
  }
  assert.deepEqual(errors, [], 'Help pages must have no uncaught browser errors');
  if (!process.argv.includes('--capture-only')) console.log(`Help browser audit: ${slugs.length} articles at desktop, 390px and 320px; examples, troubleshooting, anchors and horizontal layout passed.`);
} finally {
  await browser.close();
}
