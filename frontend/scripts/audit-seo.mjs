import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The SEO contract every built page must keep.
 *
 * Search visibility is lost in small, silent ways: a page shipped without a
 * description, two H1s after a component refactor, a canonical pointing at
 * the old host, a noindexed page still in the sitemap. None of those show up
 * in a browser. This checks the built HTML, so the failure is loud and the
 * fix lands before the deploy.
 */
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const DEFAULT_ORIGIN = 'https://bansi1701.github.io/ProjectPDF';
const origin = (process.env.SITE_ORIGIN || DEFAULT_ORIGIN).replace(/\/+$/, '');

const siteSource = await readFile(new URL('../src/config/site.ts', import.meta.url), 'utf8');
const liveSlugs = new Set(
  [...siteSource.matchAll(/slug:\s*'([^']+)'[^}]*?status:\s*'live'/g)].map((match) => match[1])
);

async function htmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await htmlFiles(path)));
    else if (entry.name.endsWith('.html')) files.push(path);
  }
  return files;
}

const files = (await htmlFiles(dist)).filter((file) => !file.includes(`${sep}og${sep}`));
const sitemapPath = join(dist, 'sitemap-0.xml');
const sitemap = new Set(
  existsSync(sitemapPath)
    ? [...(await readFile(sitemapPath, 'utf8')).matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])
    : []
);

const problems = [];
const canonicals = new Map();

for (const file of files) {
  const label = relative(dist, file).replaceAll('\\', '/');
  const route =
    label === 'index.html' ? '/' : label.endsWith('/index.html') ? `/${label.slice(0, -'index.html'.length)}` : `/${label}`;
  const html = await readFile(file, 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));

  const title = /<title>([^<]*)<\/title>/.exec(head)?.[1]?.trim();
  const description = /<meta name="description" content="([^"]*)"/.exec(head)?.[1];
  const canonical = /<link rel="canonical" href="([^"]+)"/.exec(head)?.[1];
  const noindex = /<meta name="robots" content="noindex/.test(head);
  const h1Count = (html.match(/<h1[\s>]/g) ?? []).length;
  const hasLang = /<html[^>]*\blang="[a-z]{2}/i.test(html);
  const hasShareImage = /property="og:image" content="https?:/.test(head);

  if (!title) problems.push(`${label}: missing <title>`);
  else if (title.length > 90) problems.push(`${label}: title is ${title.length} characters (max 90): ${title}`);
  if (!description) problems.push(`${label}: missing meta description`);
  else if (description.length < 50 || description.length > 175) {
    problems.push(`${label}: description is ${description.length} characters (want 50–175)`);
  }
  if (!hasLang) problems.push(`${label}: <html> has no lang attribute`);
  if (h1Count !== 1) problems.push(`${label}: ${h1Count} <h1> elements (want exactly one)`);
  if (!hasShareImage) problems.push(`${label}: no absolute og:image`);

  if (!canonical) {
    problems.push(`${label}: missing canonical`);
  } else if (!noindex) {
    const expected = route === '/' ? `${origin}/` : `${origin}${route}`;
    if (canonical !== expected) problems.push(`${label}: canonical ${canonical} should be ${expected}`);
    if (canonicals.has(canonical)) problems.push(`${label}: canonical duplicates ${canonicals.get(canonical)}`);
    canonicals.set(canonical, label);
    if (!sitemap.has(canonical)) problems.push(`${label}: indexable but absent from the sitemap`);
  } else if (sitemap.has(canonical)) {
    problems.push(`${label}: noindex yet listed in the sitemap`);
  }

  const segments = route.split('/').filter(Boolean);
  const slug = segments.at(-1) ?? '';
  const isToolPage = segments.length === 1 && liveSlugs.has(slug);
  const isHelpPage = segments.length === 2 && segments[0] === 'help' && liveSlugs.has(slug);
  if ((isToolPage || isHelpPage) && !html.includes('"SoftwareApplication"')) {
    problems.push(`${label}: tool page without SoftwareApplication structured data`);
  }
  if (isToolPage && !html.includes('"FAQPage"')) {
    problems.push(`${label}: tool page without its guide content (no FAQ)`);
  }
}

for (const location of sitemap) {
  const path = location.replace(origin, '');
  if (!existsSync(join(dist, path, 'index.html'))) problems.push(`sitemap lists ${location} but no page was built there`);
}

if (problems.length) throw new Error(problems.join('\n'));
console.log(
  `SEO audit: ${files.length} pages carry one H1, a title, a description, a canonical and a share image; ${sitemap.size} sitemap entries match the indexable pages.`
);
