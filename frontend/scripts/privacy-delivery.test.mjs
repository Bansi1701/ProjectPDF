import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertNoOptionalRuntime, inspectDeliveredHtml } from './privacy-delivery.mjs';

const revision = 'a'.repeat(40);
const head = `<meta name="google-adsense-account" content="ca-pub-6531092487237731"><meta content='${revision}' name='filozy-build'>`;
const url = 'https://filozy.com/privacy/';

test('accepts same-origin code and separately reports the observed host beacon', () => {
  assert.equal(inspectDeliveredHtml(`${head}<script src='/_astro/tool.js'></script>`, url, revision).analyticsTags, 0);
  assert.equal(inspectDeliveredHtml(`${head}<script src="https://static.cloudflareinsights.com/beacon.min.js/v123abc"></script>`, url, revision).analyticsTags, 1);
});
test('rejects stale releases, ads, injected external code and undeclared frames', () => {
  assert.throws(() => inspectDeliveredHtml(head, url, 'b'.repeat(40)), /Release not delivered/);
  for (const tag of [
    '<script src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script>',
    '<script>window.adsbygoogle = [];</script>',
    '<script src=//unknown.example/measurement.js></script>',
    '<script src="https://static.cloudflareinsights.com.attacker.example/beacon.min.js"></script>',
    '<script src="https:&#47;&#47;unknown.example/code.js"></script>',
    '<iframe src="https://static.cloudflareinsights.com/beacon.min.js"></iframe>',
    '<iframe srcdoc="<p>unreviewed</p>"></iframe>',
    '<script src="data:text/javascript,alert(1)"></script>',
  ]) assert.throws(() => inspectDeliveredHtml(head + tag, url, revision));
});
test('does not confuse informational privacy links with active scripts', () => {
  assert.equal(inspectDeliveredHtml(`${head}<a href="https://www.google.com/about/company/user-consent-policy/">Policy</a>`, url, revision).analyticsTags, 0);
  assert.throws(() => inspectDeliveredHtml(`${head}<script src="https://static.cloudflareinsights.com/beacon.min.js"></script>`, 'https://bansi1701.github.io/ProjectPDF/', revision));
});

test('static bundles cannot introduce ad identifiers without a remote URL', () => {
  for (const code of ['window.adsbygoogle = [];', 'window.google_ad_client = "test";', 'const src = "https://static.cloudflareinsights.com/beacon.min.js";']) {
    assert.throws(() => assertNoOptionalRuntime(code, 'synthetic.js'));
  }
  assert.doesNotThrow(() => assertNoOptionalRuntime('const theme = "dark";', 'synthetic.js'));
});
