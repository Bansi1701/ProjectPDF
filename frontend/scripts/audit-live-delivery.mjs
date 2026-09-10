import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { inspectDeliveredHtml, SELLER_RECORD } from './privacy-delivery.mjs';

const base = process.env.SITE_ORIGIN?.replace(/\/$/, '');
assert.ok(base === 'https://filozy.com' || base === 'https://bansi1701.github.io/ProjectPDF', 'Use a known public Filozy deployment');
const revision = process.env.PUBLIC_BUILD_ID;
assert.match(revision ?? '', /^[a-f0-9]{40}$/, 'Supply the full PUBLIC_BUILD_ID from the deployment');
const strictAnalytics = process.argv.includes('--require-no-analytics');
const routes = ['/', '/merge-pdf/', '/privacy/', '/terms/'];

async function get(path) {
  const response = await fetch(`${base}${path}`, {
    redirect: 'error',
    headers: { 'Cache-Control': 'no-cache', Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (compatible; FilozyDeliveryAudit/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, `Unexpected HTTP status on ${path}`);
  return response.text();
}

let failure;
for (let attempt = 1; attempt <= 6; attempt++) {
  try {
    const pages = await Promise.all(routes.map(async (route) => {
      const html = await get(route);
      return { route, html, ...inspectDeliveredHtml(html, `${base}${route}`, revision) };
    }));
    const privacy = pages.find((page) => page.route === '/privacy/').html;
    assert.match(privacy, /Ontario, Canada/, 'Operator jurisdiction missing');
    assert.match(privacy, /Advertising is not active/, 'Disabled-ad disclosure missing');
    const analyticsTags = pages.reduce((count, page) => count + page.analyticsTags, 0);
    if (analyticsTags) {
      assert.match(privacy, /Cloudflare Web Analytics is currently added/, 'Host analytics is not disclosed');
      if (strictAnalytics) throw new Error('Host-injected analytics remains; consent-controlled launch is blocked');
      console.warn('::warning::Cloudflare Web Analytics is still injected. This is NOT a consent-readiness pass. Review/replace automatic injection and verify consent before treating optional analytics or a privacy-reviewed launch as ready.');
    }
    assert.equal((await get('/ads.txt')).trim(), SELLER_RECORD, 'Seller record mismatch');
    for (const path of ['/llms.txt', '/llms-full.txt']) {
      assert.doesNotMatch(await get(path), /no cookies or trackers|no analytics or advertising scripts/i, `Outdated measurement claim in ${path}`);
    }
    console.log(`Delivered HTML revision and ad-disablement checks passed on ${routes.length} HTML routes, ads.txt and two public reference files. Known analytics tags: ${analyticsTags}. No ad tags found in these responses. Browser consent/egress tests and legal review remain required.`);
    failure = undefined;
    break;
  } catch (error) {
    failure = error;
    if (attempt < 6) {
      console.log(`Delivery check ${attempt}/6 has not passed: ${error.message}. Retrying after propagation.`);
      await setTimeout(10000);
    }
  }
}
if (failure) throw failure;
