import assert from 'node:assert/strict';
import { indexNowPayload } from './indexnow.mjs';

const origin = process.env.SITE_ORIGIN;
const key = process.env.INDEXNOW_KEY;
assert.equal(origin, 'https://filozy.com');
assert.match(key ?? '', /^[a-zA-Z0-9-]{8,128}$/);
/**
 * A deploy reaches the edge slightly after the API call that created it
 * returns, so a discovery file requested immediately can still 404 — which
 * failed this step the first time the IndexNow key was introduced. Retry
 * briefly rather than treating a propagation delay as a missing file.
 */
async function publicFile(path) {
  let last = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 5000));
    try {
      const response = await fetch(`${origin}/${path}`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
      last = response.status;
      if (response.status === 200) return response.text();
    } catch {
      last = 0;
    }
  }
  assert.fail(`Required production discovery file is unavailable: /${path} (last status ${last})`);
}
const [sitemap, keyFile] = await Promise.all([publicFile('sitemap-0.xml'), publicFile(`${key}.txt`)]);
const payload = indexNowPayload(origin, key, sitemap, keyFile);
const response = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(15000),
});
assert.ok(response.status === 200 || response.status === 202, `IndexNow notification returned HTTP ${response.status}`);
console.log(`IndexNow received ${payload.urlList.length} public production URLs (HTTP ${response.status}). Receipt is not indexing, ranking or AI citation approval.`);
