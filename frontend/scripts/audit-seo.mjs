import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { googleVerificationPath, isOwnershipVerification } from './ownership-verification.mjs';

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

isOwnershipVerification(googleVerificationPath); // Fail the build if the proof is missing or changed.
const files = (await htmlFiles(dist)).filter((file) => !file.includes(`${sep}og${sep}`) && !isOwnershipVerification(file));
const sitemapPath = join(dist, 'sitemap-0.xml');
const sitemap = new Set(
  existsSync(sitemapPath)
    ? [...(await readFile(sitemapPath, 'utf8')).matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])
    : []
);

const problems = [];
const canonicals = new Map();
const iconBase = new URL(origin).pathname.replace(/\/$/, '');
for (const [filename, size] of [['favicon.png', 96], ['apple-touch-icon.png', 180]]) {
  const bytes = await readFile(join(dist, filename));
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) !== size || bytes.readUInt32BE(20) !== size) problems.push(`${filename}: wrong format or non-square dimensions`);
}
const ico = await readFile(join(dist, 'favicon.ico'));
if (ico.readUInt16LE(2) !== 1 || ico.readUInt16LE(4) !== 4) problems.push('favicon.ico: invalid multi-size fallback');

const robots = await readFile(join(dist, 'robots.txt'), 'utf8');
if (!robots.includes(`Sitemap: ${origin}/sitemap-index.xml`)) problems.push('robots.txt: sitemap does not match this deployment');
if (!/^User-agent: OAI-SearchBot\r?\nAllow: \/$/m.test(robots)) problems.push('robots.txt: intended search crawler access missing');
const sitemapIndex = await readFile(join(dist, 'sitemap-index.xml'), 'utf8');
if (!sitemapIndex.includes(`<loc>${origin}/sitemap-0.xml</loc>`)) problems.push('sitemap index: wrong deployment or missing sitemap');
for (const filename of ['llms.txt', 'llms-full.txt']) {
  const markdown = await readFile(join(dist, filename), 'utf8');
  for (const slug of liveSlugs) {
    if (!markdown.includes(`${origin}/${slug}/`)) problems.push(`${filename}: missing live tool ${slug}`);
  }
  for (const [, location] of markdown.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)) {
    if (!location.startsWith(`${origin}/`)) continue;
    const path = location.slice(origin.length).split(/[?#]/)[0];
    const target = join(dist, path, /\.[a-z0-9]+$/i.test(path) ? '' : 'index.html');
    if (!existsSync(target)) problems.push(`${filename}: broken local reference ${location}`);
  }
}

for (const file of files) {
  const label = relative(dist, file).replaceAll('\\', '/');
  const route =
    label === 'index.html' ? '/' : label.endsWith('/index.html') ? `/${label.slice(0, -'index.html'.length)}` : `/${label}`;
  const html = await readFile(file, 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  if (!head.includes(`href="${iconBase}/favicon.png" type="image/png" sizes="96x96"`)) problems.push(`${label}: missing branded search favicon`);
  if (!head.includes(`href="${iconBase}/favicon.ico"`) || !head.includes(`href="${iconBase}/apple-touch-icon.png"`)) problems.push(`${label}: missing fallback or Apple icon`);
  if (head.includes('href="/favicon.svg"') || head.includes('href="/ProjectPDF/favicon.svg"')) problems.push(`${label}: obsolete generic document icon`);

  const title = /<title>([^<]*)<\/title>/.exec(head)?.[1]?.trim();
  const description = /<meta name="description" content="([^"]*)"/.exec(head)?.[1];
  const canonical = /<link rel="canonical" href="([^"]+)"/.exec(head)?.[1];
  const noindex = /<meta name="robots" content="noindex/.test(head);
  const h1Count = (html.match(/<h1[\s>]/g) ?? []).length;
  const hasLang = /<html[^>]*\blang="[a-z]{2}/i.test(html);
  const hasShareImage = /property="og:image" content="https?:/.test(head);
  for (const [, json] of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try { JSON.parse(json); } catch { problems.push(`${label}: invalid structured-data JSON`); }
  }

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
  if (isHelpPage) {
    for (const marker of ['id="how-to-use"', 'Worked example', 'id="troubleshooting"', 'Before you rely on the output', '"TechArticle"', '"FAQPage"']) {
      if (!html.includes(marker)) problems.push(`${label}: missing reference-guide content: ${marker}`);
    }
    const toolHtml = await readFile(join(dist, slug, 'index.html'), 'utf8');
    const howTo = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
      .map(([, json]) => JSON.parse(json)).find((schema) => schema['@type'] === 'HowTo');
    if (!howTo?.step?.length || toolHtml.includes(JSON.stringify(howTo))) problems.push(`${label}: help example must differ from the tool quick steps`);
  }
  const isGuidePage = segments.length === 2 && segments[0] === 'guides';
  if (isGuidePage && !html.includes('"TechArticle"')) {
    problems.push(`${label}: guide without TechArticle structured data`);
  }
}

for (const location of sitemap) {
  if (!location.startsWith(`${origin}/`)) {
    problems.push(`sitemap: unexpected origin ${location}`);
    continue;
  }
  const path = location.replace(origin, '');
  if (!existsSync(join(dist, path, 'index.html'))) problems.push(`sitemap lists ${location} but no page was built there`);
}

if (problems.length) throw new Error(problems.join('\n'));
console.log(
  `SEO audit: ${files.length} pages checked; ${sitemap.size} sitemap entries match indexable pages; robots, structured JSON and both AI-readable indexes match the release.`
);
