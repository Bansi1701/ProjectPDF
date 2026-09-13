import assert from 'node:assert/strict';

// These checks target our generated static HTML, not arbitrary third-party HTML.
function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
    .map(([, name, double, single, bare]) => [name.toLowerCase(), double ?? single ?? bare]));
}

export function publicSitemapUrls(xml, origin, index = false) {
  assert.match(xml, index ? /<sitemapindex\b/ : /<urlset\b/, 'Unexpected sitemap format');
  const urls = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map(([, url]) => url);
  assert.ok(urls.length > 0 && urls.length <= 10000, 'Invalid sitemap size');
  assert.equal(new Set(urls).size, urls.length, 'Duplicate sitemap URLs');
  for (const raw of urls) {
    const url = new URL(raw);
    assert.ok(url.origin === origin && !url.username && !url.password && !url.search && !url.hash, 'Only public same-origin URLs are allowed');
    assert.ok(index ? /^\/sitemap-[\d]+\.xml$/.test(url.pathname) : url.pathname.endsWith('/'), 'Unexpected sitemap path');
  }
  return urls;
}

export function assertOpenRobots(text, origin) {
  const directives = text.split(/\r?\n/).map(line => line.split('#')[0].trim()).filter(Boolean);
  assert.ok(directives.some(line => /^user-agent\s*:\s*\*$/i.test(line)), 'Missing general crawler group');
  // Filozy currently publishes no private routes. Fail for review if an edge
  // rewrite adds any restriction, rather than guessing crawler precedence.
  assert.ok(!directives.some(line => /^(disallow|noindex)\s*:\s*\S/i.test(line)), 'Unexpected crawler restriction; review delivered robots.txt');
  assert.ok(directives.some(line => line.toLowerCase() === `sitemap: ${origin}/sitemap-index.xml`), 'Missing production sitemap declaration');
}

export function assertIndexablePage(html, url, headers) {
  assert.match(headers.get('content-type') ?? '', /text\/html/i, 'Expected HTML');
  const blocking = /\b(noindex|none|nofollow)\b/i;
  assert.ok(!blocking.test(headers.get('x-robots-tag') ?? ''), 'Restrictive X-Robots-Tag');
  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1];
  assert.ok(head, 'Missing HTML head');
  const tags = [...head.matchAll(/<(meta|link)\b[^>]*>/gi)].map(([tag, kind]) => ({ kind: kind.toLowerCase(), ...attributes(tag) }));
  for (const tag of tags.filter(tag => tag.kind === 'meta' && /^(robots|googlebot|bingbot|yandex|baiduspider|naverbot)$/i.test(tag.name ?? ''))) {
    assert.ok(!blocking.test(tag.content ?? ''), 'Restrictive robots meta tag');
  }
  const canonicals = tags.filter(tag => tag.kind === 'link' && /(?:^|\s)canonical(?:\s|$)/i.test(tag.rel ?? ''));
  assert.equal(canonicals.length, 1, 'Expected exactly one canonical');
  assert.equal(canonicals[0].href, url, 'Canonical does not match sitemap URL');
  assert.match(head, /<title\b[^>]*>[^<]+<\/title>/i, 'Missing title');
  assert.match(html, /<h1\b/i, 'Missing primary heading');
}
