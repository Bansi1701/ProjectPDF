# Tech Stack

**Frontend:** Astro + TypeScript · **Backend:** Python + FastAPI · **Database:** PostgreSQL

Everything a user does to a PDF happens in their browser. The server handles accounts,
payments, limits, and the handful of jobs a browser genuinely cannot do.

---

## 1. The stack

| Layer | Choice | License | Why |
|---|---|---|---|
| Site | **Astro** (static output) + React islands | MIT | SEO pages ship 0 kB JS; tool pages hydrate on the ranking URL |
| Styling | Tailwind CSS v4 + shadcn/ui | MIT | shadcn is source you own — no runtime dependency |
| State | Zustand, one store per open document | MIT | Undo must be a command stack, not snapshots |
| Backend | **FastAPI** (Python 3.11+) | MIT | Every server job is document/ML work — Python's home turf |
| Database | **PostgreSQL** | — | Accounts, billing, usage. **Never documents.** |
| Hosting | Cloudflare (site) + container host (API) | — | Bandwidth is the whole bill; Cloudflare egress is $0 |
| Payments | Stripe Checkout + Billing | — | Never store card data |

**Rejected:** Next.js (`output: 'export'` drops the header control this site needs, and RSC
buys nothing when every tool is 100% client-side). Vercel (~$300+/month egress on 3 TB that
Cloudflare serves free).

---

## 2. The document engines

Five libraries, one job each. All permissive-licensed.

| Job | Engine | License | Size |
|---|---|---|---|
| Page/object operations — merge, split, rotate, crop, forms, **encrypt + decrypt** | `@cantoo/pdf-lib` | MIT | ~350 kB, no WASM |
| File-format repair — linearize, object streams, page labels, xref rebuild | **qpdf** (self-built WASM) | Apache-2.0 | ~1.3 MB |
| Viewing — render, text layer, search, annotation editors | `pdfjs-dist` (**legacy build**) | Apache-2.0 | — |
| Destructive edits — **real redaction**, content rewriting | `@embedpdf/pdfium` | MIT / BSD-3 | ~4 MB |
| Image compression | `createImageBitmap` + `@jsquash/jpeg` | Apache-2.0 | ~245 kB |

Seven of the first ten tools need only the first one — about 350 kB of JavaScript and no
WASM at all.

### Banned — permanently

**MuPDF, PyMuPDF, Ghostscript, iText** are AGPL. Shipping AGPL as WASM to a browser is
distribution; running it as a SaaS trips AGPL §13. Artifex actively enforces.

These enter through *transitive* dependencies, not direct installs:

- `ppu-pdf` → depends on `mupdf`
- `pdf2docx` → PyPI says MIT, pins AGPL PyMuPDF, now lives in Artifex's own GitHub org
- `heic2any` → npm says MIT, bundles LGPL libheif

**Add a CI license gate on the lockfile in week 1**, before someone installs the obvious
tool at 2 a.m.

---

## 3. What runs where

**In the browser (~40 tools):** merge, split, extract, delete, reorder, rotate, crop,
page numbers, watermark, compress, JPG/PNG/WEBP/TIFF→PDF, PDF→JPG/PNG, PDF text extraction,
PDF→Markdown (digital), protect, unlock, repair, redact, compare, forms (detect/fill/create/
flatten), annotate, shapes, draw, visual signatures, small-batch OCR.

**On the server (the paywall, conveniently):**

| Job | Why it can't be client-side |
|---|---|
| Word/Excel/PowerPoint ↔ PDF | LibreOffice WASM is **52 MB** and needs headers we've ruled out |
| URL → PDF | CORS blocks the page *and every subresource*. No file exists to keep private |
| PDF → Word/Excel (unruled tables) | Layout models too heavy to download casually |
| PDF/A validation + conversion | veraPDF is Java; no WASM validator exists |
| Batch OCR (200+ pages) | Exhausts a mobile tab |
| Cryptographic signatures (PAdES) | Timestamp authorities and revocation are network calls |
| E-signature workflow, workflows, public API | Multi-party and stateful by definition |

**Not supported, say so plainly:** XFA dynamic forms, PDF/UA tagged output.

---

## 4. Five rules that will save you a rewrite

**1. Never turn on cross-origin isolation.** `SharedArrayBuffer` and WASM threads require
`COOP`/`COEP`, which kills AdSense in every browser, blocks Stripe Elements iframes, breaks
YouTube embeds, and severs `window.opener` for OAuth popups. Safari has no `credentialless`
escape. Parallelize with separate `new Worker()` instances instead — ~0.85× the throughput,
100% of the compatibility. *Add a CI check that fails if `COEP` appears in `_headers`.*

**2. iOS kills tabs silently at ~100–200 MB** with no catchable exception. Use `poolSize = 1`
on iOS, cap input at 50 MB, and write a `sessionStorage` breadcrumb before large allocations
so you can detect crashes after the fact.

**3. Privacy features are theater unless you fight for them.** Setting `/CropBox` does *not*
remove cropped content. A black rectangle does not redact. `saveIncremental()` leaves the
previous revision fully intact — so a "strip metadata" button routed through it removes
nothing. **Engineering rule: privacy operations use full `save()`, never incremental.**

**4. Write validators before optimizers.** Compress will silently corrupt files — CMYK JPEGs
invert, ICC profiles get dropped, raw Flate image XObjects aren't self-contained files. Re-open
every output, render sample pages, perceptually diff, and hard-fail back to the original bytes.

**5. Build the redaction leak harness in week 2, before any redaction UI.** The obvious test is
broken: a canary file returned clean text from the API while `"SSN 123-45-6789"` was still
physically present under a `/Prev` chain. Inflate every stream, hex-decode, check UTF-16BE,
assert one `%%EOF` and no `/Prev`. Redaction is your highest-liability feature.

---

## 5. The Python backend

Deliberately small. **No document bytes pass through the API layer** — client-side tools never
call it, and server-side jobs go straight to a worker container.

```
FastAPI          API — auth, billing, quotas, job enqueue
Dramatiq + Redis job queue (simpler than Celery, same job)
PostgreSQL       users, orgs, subscriptions, usage_events, api_keys, audit
SQLAlchemy 2.x   ORM + Alembic migrations
Pydantic v2      validation and settings
```

### Server-side document libraries

| Job | Library | License |
|---|---|---|
| PDF structure, encrypt/decrypt, repair | **pikepdf** (qpdf bindings) | MPL-2.0 ✅ |
| OCR | **OCRmyPDF** + Tesseract | MPL-2.0 / Apache-2.0 ✅ |
| Office ↔ PDF | **LibreOffice headless** via unoserver | MPL-2.0 ✅ |
| URL/HTML → PDF | **Playwright** | Apache-2.0 ✅ |
| PDF → Word/Excel | **Docling** → `python-docx` | MIT ✅ |
| Images → PDF | img2pdf, Pillow | LGPL-3 / MIT-CMU ⚠️✅ |

**Never `PyMuPDF`** — it's AGPL, and it's the library every tutorial reaches for.

### Deployment

Python doesn't run on Cloudflare Workers the way JS does, so the API lives on a **container
host** (Fly.io / Railway / Hetzner + Docker) *behind* Cloudflare, while the static site and
client bundles still serve from the edge.

Worker containers run **unprivileged, read-only base image, no network egress, hard CPU/RAM/
timeout caps**. Inputs and outputs go to object storage with short-TTL lifecycle rules.

### Costs of choosing Python

You lose end-to-end type sharing with the TypeScript frontend. Fix it by generating a typed
client from FastAPI's OpenAPI schema (`openapi-typescript` + `openapi-fetch`) in CI.

What you gain: the *entire* server-side surface — OCR, Office conversion, PDF repair, document
intelligence — is native Python. One language and one service instead of an API in Go and
workers in Python.

---

## 6. Build order

**Weeks 1–2 — validate what would force a rewrite.**
Monorepo, Astro, worker pool with no cross-origin isolation, CI license gate. Ship
`/merge-pdf` and `/rotate-pdf` (pdf-lib only, zero WASM). Then the two hard spikes: self-build
qpdf WASM, and the redaction leak harness as a throwaway CLI. Build the nasty-PDF test corpus
— *and make it policy that no customer file ever enters it.*

**Weeks 3–5 — ship the MVP ten.**
Viewer (pdf.js legacy build, self-hosted cmaps/fonts) + thumbnail grid. Split, extract, delete,
reorder. Compress (structural first, validator before optimizer, basic mode with zero codec
download). Images: JPG/PNG/WEBP→PDF, PDF→JPG/PNG, watermark. **Ten tools live, all client-side.**

**Weeks 6–10 — the hard ones.**
Protect/unlock (benchmark AES throughput on a mid-tier Android before choosing the qpdf routing
threshold). Redaction — ship *only* if the week-2 harness passes in CI. Repair. Annotate +
shapes. Forms + compare (text diff is the headline; it's what businesses pay for).

**Weeks 11–12 — server and SEO.**
FastAPI + Postgres + Stripe. First container job: `/url-to-pdf` with SSRF guards — the cleanest
server tool and the best privacy story ("there is no uploaded file"). Then i18n, structured
data, sitemaps, Playwright across Chromium/Firefox/**WebKit**.

**Deferred, with triggers:** OCR (needs the engine-installer UI first) · Office↔PDF (needs the
consent dialog proven) · PDF→Word (**get a commercial SDK quote in week 1** so it isn't a
surprise in month 4) · true text editing (month 7+, single-block LTR only — that's the industry
ceiling, not a limitation you can engineer away) · AI (browser-side retrieval first) ·
e-signature and public API (later phases).

---

## 7. Two SEO corrections

- **FAQPage and HowTo rich results are deprecated.** Keep the markup for semantics; don't model
  traffic on it. `SoftwareApplication` still earns display treatment.
- **40 tools × 12 locales × keyword variants is exactly the pattern Google demotes.** Ship ~40
  real tool pages with genuinely distinct substance — real limits, real screenshots, and a
  per-tool statement of whether it runs in your browser or on a server, which no competitor
  can copy. Expand only where Search Console shows impressions.

---

*Derived from a 13-agent research pass (6 domain analyses, each independently fact-checked).
The full 87k-character version — including per-tool engine notes, exact header configuration,
memory budgets, and a complete license scorecard — is available on request.*
