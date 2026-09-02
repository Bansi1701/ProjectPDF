# HatePDF

**HatePDF** — free PDF tools that run entirely in your browser. Merge, split,
compress, convert (Word, Excel, PowerPoint, images), OCR, redact, sign, watermark
and encrypt PDFs with nothing uploaded: the file is processed on your device and
each job reports **0 document bytes sent**. No account, no limits, no cookies, no
trackers. **Live: [bansi1701.github.io/ProjectPDF](https://bansi1701.github.io/ProjectPDF/)**
(moving to hatepdf.com).

How it holds that promise: every operation runs in a Web Worker on pdf.js,
pdf-lib and self-hosted WASM engines; the build fails if an undocumented
network request or browser-storage call appears in the code; the
[privacy page](https://bansi1701.github.io/ProjectPDF/privacy/) is generated
from the same audit. Verify it yourself: open DevTools → Network before choosing
a file — [here is how](https://bansi1701.github.io/ProjectPDF/guides/how-to-check-if-a-pdf-tool-uploads-your-file/).

Not offered, honestly: certified digital signatures, cloud storage, native apps.

## Stack

| Part | Tech |
|---|---|
| Frontend | Astro + TypeScript |
| Backend | Python + FastAPI |
| Database | Neon (managed PostgreSQL) |
| PDF engine | Runs client-side — `pdf.js` + `pdf-lib` |
| Hosting | Cloudflare |

See [Docs/TECH_STACK.md](Docs/TECH_STACK.md) for the full reasoning.
All interface changes follow the shared [design language](Docs/DESIGN_LANGUAGE.md).

## Layout

```
ProjectPDF/           Repository name (the public product is HatePDF)
├── frontend/           Astro site — the product
├── backend/            FastAPI control plane — accounts, billing, limits
├── docker-compose.yml  Dev stack
└── Docs/               Business plan + tech decisions
```

## Run

```bash
# save the shared .env at backend/.env first — ask a maintainer
docker compose up
```

| Service | URL |
|---|---|
| Site | http://localhost:4321 |
| API | http://localhost:8010 |
| API docs | http://localhost:8010/docs |

Both reload on save. Port 8000 was already in use on this machine, hence 8010.

Check the database is connected:

```bash
curl localhost:8010/api/v1/health/db
```

New here? [CONTRIBUTING.md](CONTRIBUTING.md) has full setup instructions,
including how to get your own Neon database and what to do when something breaks.

The frontend does not call the backend yet — it is a static page.
