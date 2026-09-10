import assert from 'node:assert/strict';

/** Only public production pages. Never submit visitor queries or workflow IDs. */
export function indexNowPayload(origin, key, sitemap, keyFile) {
  assert.equal(origin, 'https://filozy.com', 'IndexNow is limited to the production domain');
  assert.match(key ?? '', /^[a-zA-Z0-9-]{8,128}$/, 'Invalid configured IndexNow key');
  assert.equal(keyFile.trim(), key, 'Deployed verification key does not match');
  const urlList = [...new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, url]) => url))];
  assert.ok(urlList.length > 0 && urlList.length <= 10000, 'Invalid sitemap URL count');
  for (const raw of urlList) {
    const url = new URL(raw);
    assert.ok(url.origin === origin && !url.username && !url.password && !url.search && !url.hash, 'Only public production paths may be submitted');
    assert.ok(url.pathname.endsWith('/'), 'Expected an indexable content page');
  }
  return { host: 'filozy.com', key, keyLocation: `${origin}/${key}.txt`, urlList };
}
