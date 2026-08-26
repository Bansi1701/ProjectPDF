// @ts-check
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'astro/config';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Self-host the pdf.js support tables.
 *
 * pdf.js renders CJK text and non-embedded base-14 fonts as a *blank page*
 * unless it can fetch the CMap and standard-font tables at render time. Taking
 * them from a CDN would tell that CDN which document someone opened, which is
 * the one thing this site promises never to happen — so they are served from
 * our own origin.
 *
 * They are copied out of node_modules rather than committed: 3.9 MB of vendored
 * binaries would drift the moment anyone bumps pdfjs-dist.
 */
function pdfjsAssets() {
  const source = here('./node_modules/pdfjs-dist/');
  const target = here('./public/pdfjs/');
  const stamp = `${target}.version`;

  return {
    name: 'pdfjs-assets',
    hooks: {
      'astro:config:setup': ({ logger }) => {
        const { version } = JSON.parse(readFileSync(`${source}package.json`, 'utf8'));

        if (existsSync(stamp) && readFileSync(stamp, 'utf8') === version) return;

        rmSync(target, { recursive: true, force: true });
        mkdirSync(target, { recursive: true });
        for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
          cpSync(`${source}${dir}`, `${target}${dir}`, { recursive: true });
        }
        writeFileSync(stamp, version);
        logger.info(`vendored pdfjs-dist ${version} cmaps, fonts, wasm and ICC profiles`);
      },
    },
  };
}

// GitHub Pages serves a project site from /<repo>/, so every absolute asset
// path needs that prefix. Use import.meta.env.BASE_URL in components rather
// than hardcoding "/" — it stays correct when this moves to a real domain.
export default defineConfig({
  output: 'static',
  site: 'https://bansi1701.github.io',
  base: '/ProjectPDF',
  trailingSlash: 'ignore',
  integrations: [pdfjsAssets()],
  vite: {
    // ES-format workers so the pdf.js import inside worker.ts stays a separate
    // chunk. With the default `iife` format Vite inlines dynamic imports, and
    // every tool — merge included — would pull 3 MB of renderer it never uses.
    worker: { format: 'es' },
  },
});
