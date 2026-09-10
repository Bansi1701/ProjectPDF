import assert from 'node:assert/strict';

// Evidence checks, not a consent engine or legal-compliance certification.
// Known host injection is reported separately from first-party build output.
export const OPTIONAL_RUNTIME = /(?:googlesyndication\.com|doubleclick\.(?:net|com)|googletagmanager\.com|google-analytics\.com|fundingchoicesmessages\.google\.com|cloudflareinsights\.com|plausible\.io|usefathom\.com|hotjar\.com|segment\.(?:io|com))/i;
const AD_RUNTIME = /(?:googlesyndication\.com|doubleclick\.(?:net|com)|googletagmanager\.com|google-analytics\.com|fundingchoicesmessages\.google\.com|\badsbygoogle\b|\bgoogle_ad_client\b)/i;
export const SELLER_RECORD = 'google.com, pub-6531092487237731, DIRECT, f08c47fec0942fa0';

export function assertNoOptionalRuntime(code, label) {
  assert.doesNotMatch(code, OPTIONAL_RUNTIME, `Unreviewed optional runtime: ${label}`);
  assert.doesNotMatch(code, AD_RUNTIME, `Advertising runtime before approval: ${label}`);
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '')
    .replace(/&amp;/gi, '&')
    .replace(/&#(x[\da-f]+|\d+);?/gi, (_, value) => String.fromCodePoint(value[0].toLowerCase() === 'x' ? parseInt(value.slice(1), 16) : Number(value)));
}

export function inspectDeliveredHtml(html, pageUrl, expectedBuild) {
  const origin = new URL(pageUrl).origin;
  const tags = [...html.matchAll(/<(?:script|iframe)\b[^>]*>/gi)].map(([tag]) => tag);
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map(([tag]) => tag);
  assert.ok(metas.some((tag) => attribute(tag, 'name') === 'google-adsense-account' && attribute(tag, 'content') === 'ca-pub-6531092487237731'), 'Missing publisher verification');
  if (expectedBuild) {
    assert.ok(metas.some((tag) => attribute(tag, 'name') === 'filozy-build' && attribute(tag, 'content') === expectedBuild), 'Release not delivered yet');
  }
  let analyticsTags = 0;
  for (const tag of tags) {
    assert.doesNotMatch(tag, /\ssrcdoc\s*=/i, 'Unreviewed embedded HTML');
    const source = attribute(tag, 'src');
    if (!source) continue;
    const url = new URL(source, pageUrl);
    assert.doesNotMatch(url.href, AD_RUNTIME, 'Ad or consent runtime is active before approval');
    const declaredBeacon = origin === 'https://filozy.com' && /^<script\b/i.test(tag)
      && url.origin === 'https://static.cloudflareinsights.com'
      && /^\/beacon\.min\.js(?:\/v[\da-f]+)?$/.test(url.pathname);
    if (declaredBeacon) {
      analyticsTags++;
      continue;
    }
    assert.equal(url.origin, origin, `Unreviewed external script or frame: ${url.protocol}//${url.hostname}`);
    assert.ok(url.protocol === 'https:', 'Unexpected script or frame protocol');
    assert.doesNotMatch(url.href, OPTIONAL_RUNTIME, 'Undeclared measurement runtime');
  }
  for (const [script] of html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)) {
    assert.doesNotMatch(script, AD_RUNTIME, 'Advertising runtime is active before approval');
  }
  return { analyticsTags };
}
