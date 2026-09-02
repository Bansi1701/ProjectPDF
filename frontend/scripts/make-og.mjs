/**
 * Renders the social-sharing card to public/brand/og.png.
 *
 * Run by hand (`node scripts/make-og.mjs`) and the result is committed, so a
 * normal build needs no browser and no image library. Facebook, X and LinkedIn
 * all refuse SVG for og:image, which is why this produces a raster at all.
 *
 * Deliberately not wired into `npm run build`: that would put Playwright on the
 * critical path for every contributor, to regenerate a file that changes when
 * the brand does and not otherwise.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../public/brand/og.png', import.meta.url));
mkdirSync(fileURLToPath(new URL('../public/brand/', import.meta.url)), { recursive: true });

const html = `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@500;700;800&family=Inter:wght@400;500&display=swap">
<style>
  * { margin: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px; display: flex; flex-direction: column;
    justify-content: space-between; padding: 72px 80px;
    background: #f8fafc; color: #0f172a;
    font-family: 'Inter', system-ui, sans-serif;
    position: relative; overflow: hidden;
  }
  /* The paper tooth from the site's own surfaces. */
  body::before {
    content: ''; position: absolute; inset: 0;
    background:
      radial-gradient(1100px 620px at 88% -12%, rgba(254,205,211,.5), transparent 62%),
      radial-gradient(820px 520px at 6% 108%, rgba(186,230,253,.42), transparent 60%);
  }
  .row { position: relative; display: flex; align-items: center; gap: 18px; }
  .mark { width: 64px; height: 64px; }
  .name { font-family: 'Plus Jakarta Sans', sans-serif; font-weight: 800; font-size: 40px; letter-spacing: -.02em; }
  h1 {
    position: relative; font-family: 'Plus Jakarta Sans', sans-serif;
    font-weight: 700; font-size: 82px; line-height: 1.02; letter-spacing: -.035em;
    max-width: 15ch;
  }
  h1 em { font-style: normal; color: #e11d48; }
  .rule { position: relative; width: 132px; height: 5px; background: #e11d48; border-radius: 3px; margin-top: 30px; }
  .facts { position: relative; display: flex; gap: 44px; align-items: baseline; }
  .fact b { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 40px; color: #15803d; font-weight: 500; }
  .fact span { font-size: 19px; color: #475569; margin-left: 10px; }
</style>
<div class="row">
  <svg class="mark" viewBox="0 0 64 64" fill="none">
    <rect x="6" y="4" width="42" height="56" rx="6" fill="#fff" stroke="#cbd5e1" stroke-width="2.5"/>
    <path d="M36 4h6l16 16v6" stroke="#cbd5e1" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M42 4v14a2 2 0 0 0 2 2h14" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M16 26h22M16 36h22M16 46h13" stroke="#e11d48" stroke-width="3.5" stroke-linecap="round"/>
  </svg>
  <span class="name">HatePDF</span>
</div>

<div>
  <h1>Your file never <em>leaves this page.</em></h1>
  <div class="rule"></div>
</div>

<div class="facts">
  <span class="fact"><b>0</b><span>bytes uploaded</span></span>
  <span class="fact"><b>0</b><span>files stored</span></span>
  <span class="fact"><b>0</b><span>accounts required</span></span>
</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out });
await browser.close();
console.log('wrote', out);
