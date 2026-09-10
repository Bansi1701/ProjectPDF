import test from 'node:test';
import assert from 'node:assert/strict';
import { indexNowPayload } from './indexnow.mjs';
const origin = 'https://filozy.com';
const key = 'synthetic-test-key';
const xml = (url) => `<urlset><url><loc>${url}</loc></url></urlset>`;
test('production sitemap payload is bounded and deduplicated', () => {
  const result = indexNowPayload(origin, key, xml(`${origin}/merge-pdf/`).repeat(2), `${key}\n`);
  assert.equal(result.host, 'filozy.com');
  assert.equal(result.urlList.length, 1);
});
test('rejects wrong deployment, missing key, stale key and empty sitemap', () => {
  assert.throws(() => indexNowPayload('https://bansi1701.github.io/ProjectPDF', key, xml(`${origin}/`), key));
  assert.throws(() => indexNowPayload(origin, '../key', xml(`${origin}/`), '../key'));
  assert.throws(() => indexNowPayload(origin, key, xml(`${origin}/`), 'stale'));
  assert.throws(() => indexNowPayload(origin, key, '<urlset/>', key));
});
test('never submits external URLs, workflow parameters or fragments', () => {
  for (const url of ['https://example.org/', `${origin}/?from=private`, `${origin}/#document`, 'https://user@filozy.com/', `${origin}/ads.txt`]) {
    assert.throws(() => indexNowPayload(origin, key, xml(url), key));
  }
});
