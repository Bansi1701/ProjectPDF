import assert from 'node:assert/strict';
import { indexNowPayload } from './indexnow.mjs';

const origin = process.env.SITE_ORIGIN;
const key = process.env.INDEXNOW_KEY;
assert.equal(origin, 'https://filozy.com');
assert.match(key ?? '', /^[a-zA-Z0-9-]{8,128}$/);
async function publicFile(path) {
  const response = await fetch(`${origin}/${path}`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, 'Required production discovery file is unavailable');
  return response.text();
}
const [sitemap, keyFile] = await Promise.all([publicFile('sitemap-0.xml'), publicFile(`${key}.txt`)]);
const payload = indexNowPayload(origin, key, sitemap, keyFile);
const response = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(15000),
});
assert.ok(response.status === 200 || response.status === 202, `IndexNow notification returned HTTP ${response.status}`);
console.log(`IndexNow received ${payload.urlList.length} public production URLs (HTTP ${response.status}). Receipt is not indexing, ranking or AI citation approval.`);
