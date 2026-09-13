import assert from 'node:assert/strict';
import { assertIndexablePage, assertOpenRobots, publicSitemapUrls } from './search-discovery.mjs';

const origin = process.env.SITE_ORIGIN ?? 'https://filozy.com';
assert.equal(origin, 'https://filozy.com', 'Live search audit is limited to Filozy production');
async function read(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Filozy-Search-Readiness-Audit', 'Cache-Control': 'no-cache' } });
      if (response.status === 429 && attempt < 2) {
        const retry = response.headers.get('retry-after');
        const seconds = /^\d+$/.test(retry ?? '') ? Number(retry) : Math.ceil((Date.parse(retry ?? '') - Date.now()) / 1000);
        // A longer server delay needs a later audit, not an early retry.
        if (seconds > 60) throw new Error(`${url}: rate limited; retry after ${seconds}s`);
        await response.body?.cancel();
        await new Promise(resolve => setTimeout(resolve, Math.max(30000, (seconds || 0) * 1000)));
        continue;
      }
      assert.equal(response.status, 200, `${url}: HTTP ${response.status}`);
      return { text: await response.text(), headers: response.headers };
    } catch (error) {
      if (attempt === 2 || /rate limited/.test(error.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
}

assertOpenRobots((await read(`${origin}/robots.txt`)).text, origin);
const maps = publicSitemapUrls((await read(`${origin}/sitemap-index.xml`)).text, origin, true);
const urls = [];
for (const map of maps) urls.push(...publicSitemapUrls((await read(map)).text, origin));
assert.equal(new Set(urls).size, urls.length, 'Duplicate pages across sitemap files');
assert.ok(urls.includes(`${origin}/`), 'Homepage missing from sitemap');
const failures = [];
for (const [index, url] of urls.entries()) {
  try {
    const page = await read(url);
    assertIndexablePage(page.text, url, page.headers);
  } catch (error) { failures.push(`${url}: ${error.message}`); }
  if ((index + 1) % 25 === 0) console.log(`Checked ${index + 1}/${urls.length} public pages`);
  // Keep well below a burst of browser/navigation requests at the edge.
  await new Promise(resolve => setTimeout(resolve, 1100));
}
assert.equal(failures.length, 0, failures.join('\n'));
console.log(`PASS: ${urls.length} public pages return 200 with matching canonicals, headings and no indexing restrictions. Live robots and ${maps.length} sitemap file(s) checked.`);
console.log('This checks public delivery from this network, not search-engine indexing, rankings or all regional firewall behavior.');
