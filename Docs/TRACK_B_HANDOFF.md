# Track B handoff

Track B is complete on `pages/track-b`. It deliberately did not edit Track A's shared layout, masthead, homepage/footer, sitemap, or crawler assets.

## New routes Track A should surface

### Connected recipes

- `/how-to/`
- `/how-to/prepare-scanned-contract-for-filing/`
- `/how-to/shrink-pdf-under-upload-limit/`
- `/how-to/redact-bank-statement-before-sending/`
- `/how-to/make-print-ready-booklet/`

### Fair comparisons and high-intent pages

- `/vs/ilovepdf/`
- `/vs/smallpdf/`
- `/merge-pdf-without-uploading/`
- `/compress-pdf-offline/`

### Trust pages

- `/privacy/`
- `/terms/`
- `/about/`

## Three Track A follow-ups

1. Add every route above to the sitemap owned by Track A.
2. Link Privacy, Terms, About, and How-to recipes from the homepage footer/navigation owned by Track A.
3. Mount Track A's live request counter in `[data-proof-counter-slot]` on the comparison pages. The static zero-byte receipt explanation remains a useful fallback.

## Contract checks

- Every live tool has a validated `src/content/tools/<slug>.md` entry.
- Tool builds fail when a live tool is missing content.
- The privacy page build scans source for `fetch` and `XMLHttpRequest`; any undocumented call fails the build.
- Recipe handoffs use IndexedDB, are single-use, and expire after one hour.
- The specialized Scan and Redact pages render the same breadcrumbs and content layer as shared `PdfTool` pages.
