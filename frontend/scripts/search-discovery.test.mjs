import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertIndexablePage, assertOpenRobots, publicSitemapUrls } from './search-discovery.mjs';
const origin = 'https://filozy.com';
const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });
const html = `<html><head><title>Filozy</title><link href='${origin}/' rel='canonical'><meta content='index, follow' name='robots'></head><body><h1>PDF tools</h1></body></html>`;

test('accepts generated public HTML and sitemap', () => {
  assertIndexablePage(html, `${origin}/`, headers);
  assert.deepEqual(publicSitemapUrls(`<urlset><url><loc>${origin}/</loc></url></urlset>`, origin), [`${origin}/`]);
});
test('rejects redirects in canonical, duplicate canonical, and missing headings', () => {
  assert.throws(() => assertIndexablePage(html, `${origin}/merge-pdf/`, headers));
  assert.throws(() => assertIndexablePage(html.replace('</head>', `<link rel="canonical" href="${origin}/"></head>`), `${origin}/`, headers));
  assert.throws(() => assertIndexablePage(html.replace('<h1>', '<p>'), `${origin}/`, headers));
});
test('detects global and bot-specific indexing restrictions', () => {
  for (const name of ['robots', 'googlebot', 'bingbot', 'yandex', 'baiduspider', 'naverbot']) {
    assert.throws(() => assertIndexablePage(html.replace('</head>', `<meta NAME="${name}" CONTENT="NOINDEX, follow"></head>`), `${origin}/`, headers));
  }
  assert.throws(() => assertIndexablePage(html, `${origin}/`, new Headers({ 'content-type': 'text/html', 'x-robots-tag': 'googlebot: noindex' })));
});
test('robots catches edge restrictions but ignores empty disallow and comments', () => {
  const robots = `User-agent: *\nAllow: /\nDisallow:\n# Disallow: /\nSitemap: ${origin}/sitemap-index.xml`;
  assertOpenRobots(robots, origin);
  assert.throws(() => assertOpenRobots(`${robots}\nUser-agent: Googlebot\nDisallow: /`, origin));
});
test('sitemaps cannot send audits off-site or into query/private workflow URLs', () => {
  for (const url of ['https://other.example/', `${origin}/?document=private`, `${origin}/#secret`, `${origin}/file.pdf`]) {
    assert.throws(() => publicSitemapUrls(`<urlset><loc>${url}</loc></urlset>`, origin));
  }
  assert.deepEqual(publicSitemapUrls(`<sitemapindex><loc>${origin}/sitemap-0.xml</loc></sitemapindex>`, origin, true), [`${origin}/sitemap-0.xml`]);
  assert.throws(() => publicSitemapUrls(`<urlset><loc>${origin}/</loc><loc>${origin}/</loc></urlset>`, origin));
});
