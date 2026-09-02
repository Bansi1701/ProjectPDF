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
 * Where the site is published.
 *
 * One variable moves the whole site between hosts: canonicals, sitemap,
 * robots, schema, CNAME and every internal path derive from it. Unset, it is
 * the GitHub Pages project site; set SITE_ORIGIN=https://hatepdf.com in the
 * deploy workflow's repository variables and the build targets the domain.
 */
const DEFAULT_ORIGIN = 'https://bansi1701.github.io/ProjectPDF';
const deployment = new URL(`${(process.env.SITE_ORIGIN || DEFAULT_ORIGIN).replace(/\/+$/, '')}/`);
const site = deployment.origin;
const base = deployment.pathname.replace(/\/+$/, '') || '/';
const basePrefix = base === '/' ? '' : base;
const homeUrl = `${site}${basePrefix}/`;
const customDomain = !deployment.hostname.endsWith('.github.io');

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

/**
 * Files GitHub Pages and search engines expect at the published root.
 *
 * CNAME keeps the custom domain attached across deploys. The IndexNow key
 * file proves ownership when the deploy workflow pings Bing (which feeds
 * ChatGPT search) and its partners with the fresh sitemap.
 */
/** @returns {import('astro').AstroIntegration} */
function publishedRootFiles() {
  return {
    name: 'published-root-files',
    hooks: {
      'astro:build:done': ({ dir, logger }) => {
        const out = fileURLToPath(dir);
        if (customDomain) {
          writeFileSync(join(out, 'CNAME'), `${deployment.hostname}\n`);
          logger.info(`CNAME → ${deployment.hostname}`);
        }
        const key = process.env.INDEXNOW_KEY;
        if (key && /^[a-z0-9-]{8,128}$/i.test(key)) {
          writeFileSync(join(out, `${key}.txt`), key);
          logger.info('IndexNow key file written');
        }
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
  let route = new URL(absoluteUrl).pathname;
  if (basePrefix && route.startsWith(basePrefix)) route = route.slice(basePrefix.length);
  route = route.replace(/^\/+/, '').replace(/\/$/, '');
  const helpSlug = route.startsWith('help/') ? route.slice('help/'.length) : null;
  const guideSlug = route.startsWith('guides/') && route !== 'guides' ? route.slice('guides/'.length) : null;
  const pages = helpSlug
    ? ['frontend/src/pages/help/[slug].astro']
    : guideSlug
      ? ['frontend/src/pages/guides/[slug].astro']
      : route
        ? [`frontend/src/pages/${route}.astro`, `frontend/src/pages/${route}/index.astro`]
        : ['frontend/src/pages/index.astro'];
  const content = helpSlug
    ? `frontend/src/content/tools/${helpSlug}.md`
    : guideSlug
      ? `frontend/src/content/guides/${guideSlug}.md`
      : route && !route.includes('/')
        ? `frontend/src/content/tools/${route}.md`
        : null;
  const dates = [...pages.map(changedAt), content ? changedAt(content) : null].filter(Boolean).sort();
  return dates.at(-1);
}

/* Tools that are not live are noindexed by the layout; listing them in the
   sitemap would contradict that. Read from the same config the layout uses. */
const siteSource = readFileSync(here('./src/config/site.ts'), 'utf8');
const hiddenTools = [...siteSource.matchAll(/slug:\s*'([^']+)'[^}]*?status:\s*'(?:building|planned)'/g)].map(
  (match) => match[1]
);

export default defineConfig({
  output: 'static',
  site,
  base,
  trailingSlash: 'ignore',
  integrations: [
    pdfjsAssets(),
    publishedRootFiles(),
    sitemap({
      filter: (page) => {
        const pathname = new URL(page).pathname;
        if (/\.[a-z0-9]+$/i.test(pathname)) return false; // robots, llms, og images, 404.html
        if (pathname.includes('/og/')) return false;
        if (/\/404\/?$/.test(pathname)) return false;
        return !hiddenTools.some((slug) => pathname.endsWith(`/${slug}/`));
      },
      serialize(item) {
        const lastmod = pageLastModified(item.url);
        return {
          ...item,
          ...(lastmod ? { lastmod } : {}),
          changefreq: item.url === homeUrl ? ChangeFreqEnum.WEEKLY : ChangeFreqEnum.MONTHLY,
          priority: item.url === homeUrl ? 1 : 0.8,
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
    build: {
      // The two deliberately lazy vendor engines are 621 KiB (pdf-lib) and
      // 1.2 MiB (pdf.js's renderer). They load only after a document needs
      // them. Our own worker entry is audited separately below 100 KiB, so a
      // 1.3 MiB warning ceiling reports actual regressions instead of these
      // indivisible third-party modules.
      chunkSizeWarningLimit: 1300,
    },
  },
});
