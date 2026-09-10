import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const site = readFileSync(here('../src/config/site.ts'), 'utf8');
const slugs = [...site.matchAll(/\{\s*slug:\s*'([^']+)'[^}]*?status:\s*'live'[^}]*?\}/g)].map(
  (match) => match[1]
);
const brand = /export const SITE\s*=\s*\{[\s\S]*?\bname:\s*'([^']+)'/.exec(site)?.[1];
if (!brand) throw new Error('Could not read SITE.name from src/config/site.ts');
const base = (process.env.PROJECTPDF_AUDIT_BASE ?? 'http://127.0.0.1:4326/ProjectPDF').replace(/\/$/, '');
const viewports = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'narrow-mobile', width: 320, height: 568 },
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
          wordmark: (() => {
            const element = document.querySelector('[data-wordmark]');
            const rect = element?.getBoundingClientRect();
            const style = element ? getComputedStyle(element) : null;
            return {
              text: element?.textContent?.trim() ?? '',
              visible: Boolean(
                rect && style && rect.width > 0 && rect.height > 0 &&
                style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 &&
                rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight
              ),
            };
          })(),
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
      if (result.wordmark.text !== brand) problems.push(`${viewport.name}/${slug}: wordmark is "${result.wordmark.text}" instead of "${brand}"`);
      if (!result.wordmark.visible) problems.push(`${viewport.name}/${slug}: wordmark is not visible within the viewport`);
      problems.push(...errors.map((error) => `${viewport.name}/${slug}: ${error}`));
    }

    errors = [];
    const homeResponse = await page.goto(`${base}/`, { waitUntil: 'networkidle', timeout: 30_000 });
    if (!homeResponse?.ok()) problems.push(`${viewport.name}/home: HTTP ${homeResponse?.status() ?? 'no response'}`);
    await page.getByRole('button', { name: 'Find a PDF tool' }).click();
    await page.locator('[data-header-search-input]').fill('split');
    const search = await page.evaluate(() => {
      const results = document.querySelector('[data-header-search-results]');
      const split = [...document.querySelectorAll('[data-header-search-item]')].find(
        (item) => item.dataset.search?.includes('split') && !item.hidden
      );
      const rect = results?.getBoundingClientRect();
      const splitRect = split?.getBoundingClientRect();
      const visible = (element, candidate) => Boolean(
        element && candidate && !element.hidden && candidate.width > 0 && candidate.height > 0 &&
        getComputedStyle(element).visibility !== 'hidden' && Number(getComputedStyle(element).opacity) > 0
      );
      return {
        resultsVisible: visible(results, rect),
        resultsWithinViewport: Boolean(rect && rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight),
        splitVisible: visible(split, splitRect),
      };
    });
    if (!search.resultsVisible) problems.push(`${viewport.name}/home: search results are not visible after searching for split`);
    if (!search.resultsWithinViewport) problems.push(`${viewport.name}/home: search results are clipped outside the viewport`);
    if (!search.splitVisible) problems.push(`${viewport.name}/home: split result is not visible after searching for split`);
    await page.keyboard.press('Escape');
    const dismissed = await page.evaluate(() => ({
      hidden: document.querySelector('[data-header-search-results]')?.hidden,
      collapsed: (document.querySelector('[data-header-search]')?.getBoundingClientRect().width ?? Infinity) < 50,
    }));
    if (!dismissed.hidden) problems.push(`${viewport.name}/home: Escape did not dismiss search results`);
    if (viewport.width <= 768 && !dismissed.collapsed) problems.push(`${viewport.name}/home: Escape left the mobile search covering navigation`);
    problems.push(...errors.map((error) => `${viewport.name}/home: ${error}`));
    await context.close();
  }
} finally {
  await browser.close();
}

if (problems.length) throw new Error(problems.join('\n'));

const slowest = timings.sort((a, b) => b.ms - a.ms).slice(0, 3);
console.log(
  `Browser audit: ${slugs.length} live tools passed at desktop, 390px and 320px mobile. Slowest local navigations: ${slowest
    .map(({ slug, viewport, ms }) => `${slug} ${viewport} ${ms}ms`)
    .join(', ')}.`
);
