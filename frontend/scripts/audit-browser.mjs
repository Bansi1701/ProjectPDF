import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const site = readFileSync(here('../src/config/site.ts'), 'utf8');
const slugs = [...site.matchAll(/\{\s*slug:\s*'([^']+)'[\s\S]*?status:\s*'live'[\s\S]*?\}/g)].map(
  (match) => match[1]
);
const base = (process.env.PROJECTPDF_AUDIT_BASE ?? 'http://127.0.0.1:4326/ProjectPDF').replace(/\/$/, '');
const viewports = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
];
const problems = [];
const timings = [];

const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    let errors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });
    page.on('pageerror', (error) => errors.push(`page: ${error.message}`));
    page.on('requestfailed', (request) => errors.push(`request: ${request.url()} — ${request.failure()?.errorText ?? 'failed'}`));

    for (const slug of slugs) {
      errors = [];
      const started = performance.now();
      const response = await page.goto(`${base}/${slug}/`, { waitUntil: 'networkidle', timeout: 30_000 });
      timings.push({ slug, viewport: viewport.name, ms: Math.round(performance.now() - started) });
      if (!response?.ok()) problems.push(`${viewport.name}/${slug}: HTTP ${response?.status() ?? 'no response'}`);

      await page.evaluate(() => document.fonts.ready);
      const result = await page.evaluate(() => {
        const h1 = document.querySelector('h1');
        const main = document.querySelector('main');
        const bodyFont = getComputedStyle(document.body).fontFamily;
        const headingFont = h1 ? getComputedStyle(h1).fontFamily : '';
        const primaryInput = main?.querySelector('input[type="file"]');
        const scanInput = main?.querySelector('[data-scan-open]');
        const inputControl = primaryInput ?? scanInput;
        const mainRect = main?.getBoundingClientRect();
        return {
          h1: h1?.textContent?.trim() ?? '',
          bodyFont,
          headingFont,
          hasMain: Boolean(main),
          hasInputControl: Boolean(inputControl),
          inputDisabled: inputControl instanceof HTMLInputElement || inputControl instanceof HTMLButtonElement
            ? inputControl.disabled
            : false,
          horizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
          mainWidth: Math.round(mainRect?.width ?? 0),
          mainLeft: Math.round(mainRect?.left ?? 0),
          domNodes: document.querySelectorAll('*').length,
        };
      });

      if (!result.h1) problems.push(`${viewport.name}/${slug}: missing page heading`);
      if (!result.hasMain) problems.push(`${viewport.name}/${slug}: missing main landmark`);
      if (!result.hasInputControl || result.inputDisabled) problems.push(`${viewport.name}/${slug}: file/camera input is missing or disabled`);
      if (result.horizontalOverflow > 2) problems.push(`${viewport.name}/${slug}: ${result.horizontalOverflow}px horizontal overflow`);
      if (result.mainWidth <= 0 || result.mainLeft < -2) problems.push(`${viewport.name}/${slug}: main tool workspace is clipped`);
      if (!/Inter/i.test(result.bodyFont)) problems.push(`${viewport.name}/${slug}: body does not use Inter (${result.bodyFont})`);
      if (!/Plus Jakarta Sans/i.test(result.headingFont)) problems.push(`${viewport.name}/${slug}: heading does not use Plus Jakarta Sans (${result.headingFont})`);
      if (result.domNodes > 3_000) problems.push(`${viewport.name}/${slug}: excessive initial DOM size (${result.domNodes} nodes)`);
      problems.push(...errors.map((error) => `${viewport.name}/${slug}: ${error}`));
    }
    await context.close();
  }
} finally {
  await browser.close();
}

if (problems.length) throw new Error(problems.join('\n'));

const slowest = timings.sort((a, b) => b.ms - a.ms).slice(0, 3);
console.log(
  `Browser audit: ${slugs.length} live tools passed at desktop and 390px mobile. Slowest local navigations: ${slowest
    .map(({ slug, viewport, ms }) => `${slug} ${viewport} ${ms}ms`)
    .join(', ')}.`
);
