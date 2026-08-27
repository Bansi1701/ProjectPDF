// @ts-check
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { defineConfig } from 'astro/config';
import sitemap, { ChangeFreqEnum } from '@astrojs/sitemap';

/** @param {string} path */
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
/** @returns {import('astro').AstroIntegration} */
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

const repository = here('../');

/** A real source date, not the build time that changes on every deploy. */
/** @param {string} file */
function changedAt(file) {
  if (!existsSync(join(repository, file))) return null;
  try {
    return execFileSync('git', ['log', '-1', '--format=%cI', '--', file], {
      cwd: repository,
      encoding: 'utf8',
    }).trim() || null;
  } catch {
    return null;
  }
}

/** @param {string} absoluteUrl */
function pageLastModified(absoluteUrl) {
  const route = new URL(absoluteUrl).pathname
    .replace(/^\/ProjectPDF\/?/, '')
    .replace(/\/$/, '');
  const pages = route
    ? [`frontend/src/pages/${route}.astro`, `frontend/src/pages/${route}/index.astro`]
    : ['frontend/src/pages/index.astro'];
  const content = route && !route.includes('/') ? `frontend/src/content/tools/${route}.md` : null;
  const dates = [...pages.map(changedAt), content ? changedAt(content) : null].filter(Boolean).sort();
  return dates.at(-1);
}

// GitHub Pages serves a project site from /<repo>/, so every absolute asset
// path needs that prefix. Use import.meta.env.BASE_URL in components rather
// than hardcoding "/" — it stays correct when this moves to a real domain.
export default defineConfig({
  output: 'static',
  site: 'https://bansi1701.github.io',
  base: '/ProjectPDF',
  trailingSlash: 'ignore',
  integrations: [
    pdfjsAssets(),
    sitemap({
      filter: (page) => !page.includes('/og/') && !page.endsWith('/url-to-pdf/'),
      serialize(item) {
        const lastmod = pageLastModified(item.url);
        return {
          ...item,
          ...(lastmod ? { lastmod } : {}),
          changefreq: item.url.endsWith('/ProjectPDF/')
            ? ChangeFreqEnum.WEEKLY
            : ChangeFreqEnum.MONTHLY,
          priority: item.url.endsWith('/ProjectPDF/') ? 1 : 0.8,
        };
      },
    }),
  ],
  vite: {
    // Astro consumes these CommonJS accessibility maps on the server. Keeping
    // them out of Vite's browser pre-bundle avoids an esbuild path walk above
    // the workspace on restricted Windows build agents.
    optimizeDeps: { exclude: ['aria-query', 'axobject-query'] },
    // ES-format workers so the pdf.js import inside worker.ts stays a separate
    // chunk. With the default `iife` format Vite inlines dynamic imports, and
    // every tool — merge included — would pull 3 MB of renderer it never uses.
    worker: { format: 'es' },
  },
});
