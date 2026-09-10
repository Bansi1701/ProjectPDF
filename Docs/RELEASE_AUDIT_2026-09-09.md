# Filozy release audit — September 9, 2026

## Scope

Review of the browser application, its 39 live tools, connected workflows,
public policy/copy, mobile editor and AdSense preparation. Main was pulled
before work; the later Cloudflare preparation commits were also incorporated.
The existing Fold & Flow design, logo, light/dark colours and typography roles
are retained. All file-processing tests use synthetic documents, not customer
files. No credentials or real PDF fixtures are included in the commit.

## Corrections

- Shared worker messages distinguish progress from results. Probe/preview IDs
  no longer invalidate a real operation. Selecting another file or clearing a
  tool invalidates stale results. This does not promise immediate CPU cancellation.
- Buttons reflect file/busy state, unsupported formats get actionable feedback,
  completed results receive focus, and Start over is available.
- Removed a duplicated page-grid implementation from the dormant URL tool.
- Form dropdown/radio/list values can be cleared and remain cleared on export.
- Crop and page composition reject protected PDFs rather than quietly ignoring
  encryption; unlock first with authorization.
- Four workflow recipes now receive the previous output, show step instructions,
  continue with the PDF even when OCR also returns text, and apply the booklet
  and metadata-removal presets. Handoffs are committed before navigation and
  atomically claimed/deleted; failed claims retain the retry identifier.
- Editor shortcuts no longer steal native text-field undo. Canvas selection
  gets keyboard focus; Escape closes menus. Mobile tool/menu positioning stays
  below the masthead. Existing photos can be selected without requesting camera
  access in Scan.
- Redaction's generated page/mark elements now receive the intended styles;
  black boxes visibly match the marked areas. Workflow result buttons wrap on
  mobile; the redacted-statement workflow checks mobile result overflow.
- Privacy reflects preferences, temporary workflow storage, ordinary hosting
  requests and email contact. Clear site data waits for storage completion and
  reports failures. The public operator is **Filozy**, with the owner-approved
  contact **admin.filozy@gmail.com**; no personal operator name is published.
- Qualified comparison/retention claims; corrected Split help to distinguish
  visible cuts/ranges from the separately linked advanced splitting tool.
- Guide article links respect the deployment base at build time. The expanded
  link audit caught 63 root-relative article links that were previously missed
  on GitHub Pages; the shared article wrapper corrects them without changing
  the source articles or adding a client-side navigation script.
- Added six upstream engine license notices, existing font-license links and a
  public notices page. No third-party logo or copyrighted document was added.
- Patched satori's transitive fflate from 0.7.3 to the compatible 0.7.5 security
  release using an override; social-image generation still builds successfully.
- AdSense verification meta and the account-provided ads.txt seller record are
  present. **Ad scripts are absent.** The build rejects premature ad runtimes.
- Cloudflare fixed-name engines revalidate so security updates are not held in
  browser cache for a month. Root-domain links and font paths are validated in
  addition to the GitHub Pages project-path build.

## Verification and coverage

| Check | Coverage |
| --- | --- |
| Full check pipeline | TypeScript, 39 live routes, 39 unique icons, typography, 41 action labels, source-storage checks, 19 operation smoke groups, production build, bundles, links, branding, SEO and ad-readiness guard |
| Browser exports | 39 representative live-tool cases produce downloadable output without captured runtime errors; selected operations also reopen the PDF and check page count/dimensions |
| Connected recipes | Shrink for upload, print-ready booklet, scanned contract and redacted statement complete their steps; OCR's additional text output does not block continuation |
| Handoff race | Two same-browser tabs cannot claim the same synthetic PDF; the losing tab retains a retry key and cannot reopen the consumed file |
| Responsive routes | 39 tools at desktop, 390px and 320px widths: 117 initial-layout checks, plus home search/navigation checks |
| Loaded editor | Desktop and mobile workspace geometry checked after opening a PDF; screenshots inspected locally |
| Dependency scan | 372 lockfile package/version entries checked against OSV; no known findings at the time of this audit |
| Static output | 116 HTML pages; 114 indexable sitemap entries; verification-only AdSense tag; engine/font notices reachable |

Reproduce from `frontend` using `npm run check`, `npm run audit:dependencies`,
and a production preview. Set `PROJECTPDF_AUDIT_BASE` to the preview URL before
running `npm run audit:browser` and `npm run audit:browser-operations`.
`node scripts/audit-browser-operations.mjs --screenshots` additionally saves
synthetic editor screenshots under the ignored `.tmp-test/` directory.
For the Cloudflare build, set `SITE_ORIGIN=https://filozy.com` in the build
environment; leave it unset for the current GitHub Pages project site.

## Boundaries and remaining work

These checks are not an exhaustive zero-bugs claim. They do not cover every
option combination, very large/malformed documents, all mobile hardware or
Safari/Firefox differences. Visual similarity to a competitor is not evidence
of identical output fidelity. PDF/A compliance, legal signature validity and
redaction suitability require appropriate independent validation for the
recipient's requirements. No private files were uploaded to a competitor.

The dormant backend/web-page-to-PDF service was not deployed or fully tested.
It remains gated by its backend configuration. The development-only Astro
toolbar previously reported an accessibility-map import issue in this Windows
environment; the production build/preview tests are the release evidence, not
a claim that every development-environment issue was fixed.

See [ADSENSE_SETUP.md](ADSENSE_SETUP.md) for the detailed policy matrix,
copyright/content caveats and controlled activation procedure. The custom
domain, live Cloudflare settings, CMP publication, applicable operator identity
requirements and Google's approval still need verification. No complete
plagiarism/trademark clearance or worldwide legal opinion is asserted.

Public host/deployment success must be checked against the actual pushed
commit; a local build alone is not deployment verification.

## Primary references

- [fflate security advisory](https://github.com/advisories/GHSA-px8p-9vwx-vf98)
- [WCAG reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow)
- [WCAG target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)
- [AdSense setup references and launch blockers](ADSENSE_SETUP.md)
