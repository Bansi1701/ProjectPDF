# Search and AI discovery

Filozy publishes people-first, crawlable information about tools that actually work. Indexing, ranking, citations and recommendations are controlled by search services, not guaranteed by our code.

## Production and release checks

Production is **https://filozy.com**, hosted on Cloudflare Pages. The older **https://bansi1701.github.io/ProjectPDF/** deployment remains functional. Both currently deploy from main with host-specific absolute URLs. This is not a completed cross-domain canonical consolidation: retain the legacy app until its migration is deliberately tested. Use filozy.com in new promotion and directory listings.

`SITE_ORIGIN` sets each build's absolute URLs. The build validates every page's title, description, heading, canonical, language, share image and sitemap membership. It also checks structured-data JSON, the sitemap index, the robots sitemap reference and live-tool coverage/local links in both text indexes. Passing these checks is release QA, not proof of indexing.

## Content and structured data

- Tool instructions and FAQs come from `frontend/src/content/tools/`, with actual limitations and related working tools.
- Original task guides come from `frontend/src/content/guides/`. They appear in the guides directory, related tool pages, sitemap, feed and text indexes.
- Each tool has a stable SoftwareApplication identity linked to the site's WebSite and publisher. No invented reviews, ratings or unsupported capabilities.
- Visible answers must agree with structured data. Do not stuff keywords, create near-duplicate city/country pages, hide text or copy competitors' descriptions.
- `llms.txt` and `llms-full.txt` are optional readable reference files, not permission, an indexing API or a ranking requirement. HTML remains the primary public content.
- Only list real capabilities: local PDF processing is not the same as a network-free website; hosting analytics and file sharing must be disclosed accurately.

Google says there are no special AI markup requirements and that Google Search does not use llms.txt. Follow its [AI optimization guidance](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide), emphasizing useful original content and crawlability rather than score chasing.

## Account actions still requiring verification

1. Verify filozy.com in Google Search Console; submit `https://filozy.com/sitemap-index.xml` and inspect representative tool/guide URLs. The existing `GOOGLE_SITE_VERIFICATION` repository variable supports a public HTML verification tag. Do not publish private account credentials.
2. Verify Bing Webmaster Tools, optionally using `BING_SITE_VERIFICATION`. Submit the production sitemap. Do not claim that Bing registration guarantees appearance in a different company's assistant.
3. IndexNow is optional notification to participating engines, not guaranteed indexing or a Google submission. Only submit production URLs after that production deployment succeeds and the public verification-key file is accessible.
4. Keep normal visitors and legitimate search/retrieval crawlers accessible. Investigate actual blocks before changing Cloudflare rules; do not disable general security controls. Model-training crawlers and search-retrieval crawlers serve different purposes.
5. Monitor Search Console/Bing crawl errors and impressions, with any optional measurement handled under the privacy collection standard. A few hand-picked AI prompts are anecdotal, not reliable market-share measurement.

## Cloudflare review, 10 September 2026

The dashboard reported Quick Wins 4/5, valid robots.txt and a missing Markdown-negotiation feature requiring Pro or higher. No paid upgrade was purchased. Technical/advanced checks include accounts, APIs and commerce, which are not requirements for discovery of this free local-processing toolkit. Do not expose document-processing APIs or add login simply to improve this score. These are dated dashboard observations and should be rechecked after hosting changes.

## Verifying ownership with search engines

Six consoles are wired. Each reads a repository variable
(**Settings → Secrets and variables → Actions → Variables**); an unset one
emits no tag at all, so there is no cost to leaving any of them blank.

| Console | Repository variable | Where to get the token |
| --- | --- | --- |
| Google Search Console | `GOOGLE_SITE_VERIFICATION` | search.google.com/search-console → add property → HTML tag |
| Bing Webmaster Tools | `BING_SITE_VERIFICATION` | bing.com/webmasters → add site → meta tag |
| Yandex Webmaster | `YANDEX_SITE_VERIFICATION` | webmaster.yandex.com → add site → meta tag |
| Naver Search Advisor | `NAVER_SITE_VERIFICATION` | searchadvisor.naver.com |
| Baidu Ziyuan | `BAIDU_SITE_VERIFICATION` | ziyuan.baidu.com |
| Pinterest | `PINTEREST_SITE_VERIFICATION` | pinterest.com/settings/claim |

Paste the token value only — not the whole `<meta>` tag — then redeploy.

**Google is worth doing as a Domain property rather than a URL prefix.** It
covers every subdomain and both schemes at once, and it verifies by DNS TXT
record instead of a meta tag, so it keeps working even if the HTML changes.
Cloudflare holds the DNS for filozy.com, so that record can be added directly
to the zone.

After verifying Google: submit `sitemap-index.xml`, then use **URL inspection →
Request indexing** on the homepage and the five biggest tools. Bing needs no
sitemap submission — IndexNow already notifies it on every deploy.

## Cloudflare can rewrite robots.txt at the edge

The zone setting `is_robots_txt_managed` makes Cloudflare **prepend its own
block to the robots.txt this repo builds**. When it was on, the served file
carried `Disallow: /` for GPTBot, ClaudeBot, CCBot, Google-Extended, Bytespider,
Amazonbot, Applebot-Extended and meta-externalagent — above our own `Allow`
rules for the same agents.

This is worth knowing because it is invisible here: `dist/robots.txt` is
correct, every build audit passes, and only the live URL shows the difference.
It is also separate from *blocking* — `ai_bots_protection` was already
`disabled`, so nothing was stopped at the edge; the site was simply asking the
AI crawlers we most want to reach to stay away, and they honour robots.txt.

Checked and changed through the API (account-scoped tokens reject `PATCH` here,
so use `PUT`):

```
GET  /zones/{zone}/bot_management          # read is_robots_txt_managed
PUT  /zones/{zone}/bot_management          # {"is_robots_txt_managed": false}
```

Verify against the live host, never the build output:

```
curl -s https://filozy.com/robots.txt | grep -c Disallow    # must be 0
```

Recheck after any change in the Cloudflare dashboard's bot or AI-crawler
sections — toggles there can switch it back on.

# Search result favicon

The shared layout declares the approved Filozy mark as a square 96px PNG,
with a multi-size ICO and 180px Apple icon. These stable public URLs work at
the custom domain and under the GitHub Pages base path. Regenerate the
checked-in assets with `node scripts/generate-favicons.mjs` from `frontend`
if the approved source logo changes; do not substitute a generic PDF glyph.
The SEO build audit checks dimensions and declarations on every HTML page.

Google must recrawl the homepage and icon before its search result changes.
Request homepage indexing in Search Console when available. This does not
guarantee an icon or immediate refresh; allow days to weeks. Keep Googlebot
and Googlebot-Image able to access the homepage and favicon.
Reference: https://developers.google.com/search/docs/appearance/favicon-in-search
