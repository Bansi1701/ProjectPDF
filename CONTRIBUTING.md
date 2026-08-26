# Contributing

Thanks for helping build this. Here's how to get running locally.

---

## What you need

| Tool | Version | Notes |
|---|---|---|
| **Docker Desktop** | any recent | The easy path — everything runs in containers |
| **Git** | any | |
| Node.js | 22+ | Only if running the frontend outside Docker |
| Python | 3.11+ | Only if running the backend outside Docker |

You also need the project's `.env` file — ask a maintainer for it.

---

## Setup (Docker — recommended)

```bash
git clone https://github.com/Bansi1701/ProjectPDF.git
cd ProjectPDF
```

Ask a maintainer for the `.env` file and save it at **`backend/.env`**. It holds
the Neon database connection string. It is git-ignored — never commit it, and
don't paste its contents into chat, issues, or PRs.

Then:

```bash
docker compose up
```

| | |
|---|---|
| Site | http://localhost:4321 |
| API | http://localhost:8010 |
| API docs | http://localhost:8010/docs |

Both services hot-reload on save.

**Verify it worked:**

```bash
curl localhost:8010/api/v1/health      # {"status":"ok"}
curl localhost:8010/api/v1/health/db   # {"connected":true,...}
```

### About the ports

The API is on **8010**, not 8000 — 8000 was already taken on the machine this was
set up on. If it's free for you and you'd rather use it, change
`docker-compose.yml` locally; don't commit that change.

---

## Setup (without Docker)

Two terminals.

**Frontend:**

```bash
cd frontend
npm install
npm run dev          # http://localhost:4321
```

**Backend:**

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
uvicorn app.main:app --reload  # http://localhost:8000
```

Note this runs on **8000**, not 8010 — the 8010 mapping only exists in Docker.
Update `CORS_ORIGINS` in `backend/.env` if you change the frontend port.


---

## Running tests

```bash
docker compose exec backend python -m pytest        # in Docker
cd backend && pytest                                # or directly

cd frontend && npm run build                        # frontend has no tests yet
```

All tests must pass before a PR merges.

---

## Project layout

```
frontend/              Astro static site — this is where PDF work happens
├── src/
│   ├── components/    UI pieces
│   ├── config/        site.ts — brand name, tool list
│   ├── layouts/       page shells
│   ├── pages/         one file = one route
│   └── styles/        global.css — design tokens
└── public/            served as-is

backend/               FastAPI control plane — accounts, billing, limits
├── app/
│   ├── main.py        app instance, CORS, lifespan
│   ├── core/          config.py, db.py
│   ├── api/routes/    one file per resource
│   ├── schemas/       pydantic request/response models
│   ├── models/        database tables
│   └── services/      business logic
└── tests/

Docs/                  Business plan + TECH_STACK.md
```

---

## Three rules specific to this project

These aren't style preferences. Breaking any of them is a real problem.

### 1. No GPL or AGPL dependencies. Ever.

This is a commercial closed-source product. Shipping AGPL code as WASM to a browser
is *distribution*, and running it as a service trips AGPL §13. Artifex actively
enforces this.

**Banned:** MuPDF, PyMuPDF (`fitz`), Ghostscript, iText.

The danger is transitive, not direct — nobody installs these on purpose:

| Looks fine | Actually pulls in |
|---|---|
| `pdf2docx` (PyPI says MIT) | AGPL PyMuPDF; now lives in Artifex's GitHub org |
| `ppu-pdf` | `mupdf` as a direct dependency |
| `heic2any` (npm says MIT) | bundles LGPL libheif |

**Before adding any dependency, check its full transitive license tree** — and check
the license of native code bundled inside `.wasm` files, which `package.json` won't
tell you. Use `pikepdf` (MPL-2.0) instead of PyMuPDF.

See [Docs/TECH_STACK.md](Docs/TECH_STACK.md) for approved libraries.

### 2. Never enable cross-origin isolation.

Don't add `Cross-Origin-Embedder-Policy` or `Cross-Origin-Opener-Policy` headers,
and don't reach for `SharedArrayBuffer` or WASM threads.

It looks like an easy performance win. It isn't — COOP/COEP kills ad revenue in
every browser, blocks Stripe Elements iframes, breaks embeds, and severs
`window.opener` for OAuth popups. Safari has no `credentialless` escape hatch.

Parallelise with separate `Worker` instances instead. It's ~85% of the throughput
and 100% of the compatibility.

### 3. Never commit secrets or customer files.

- `.env` is git-ignored. Keep it that way. Put new config keys in `.env.example`
  with placeholder values.
- **No customer PDF ever enters this repo**, including as a test fixture. `/corpus/`
  is git-ignored on purpose — test files come from public corpora only.
- Don't log document contents, filenames, or extracted text. Log job id, tool,
  duration, and byte counts.

---

## Code style

**Python** — `ruff` handles formatting and linting:

```bash
cd backend
ruff check --fix .
ruff format .
```

Type hints on function signatures. Docstrings where the *why* isn't obvious from
the code; skip them where it is.

**TypeScript / Astro** — strict mode is on. Prefer static Astro components; only
reach for a React island when a page genuinely needs interactivity.

**Comments** explain reasoning, not mechanics. `# increment counter` is noise;
`# Neon's pooler breaks prepared statements` is worth writing.

---

## Making a change

```bash
git checkout -b your-feature
# ... work, commit ...
git push -u origin your-feature
gh pr create
```

Keep PRs focused — one concern each. In the description, say what changed and why.
If you added a dependency, state its license.

Commit messages: present tense, explain the why.

```
Add page-reorder drag handles

dnd-kit re-evaluates every droppable on pointer move, which janks
past ~200 thumbnails. Uses pragmatic-drag-and-drop instead.
```

---

## Common problems

**`{"connected":false,...}` from `/health/db`**

Read the `detail` field — it says what's wrong. It has no credentials in it, so
it's safe to paste when asking for help.

- `DATABASE_URL is not set` — `backend/.env` is missing or the value is empty
- `password authentication failed` — the credentials have been rotated; ask for the current `.env`

After editing `.env`, **recreate** the container — a plain restart won't reload it:

```bash
docker compose up -d --force-recreate backend
```

**Port already in use** — something else is on 4321/8010. Find it with
`lsof -nP -iTCP:8010 -sTCP:LISTEN`, or change the port in `docker-compose.yml`.

**Frontend not updating** — only `src/`, `public/` and `astro.config.mjs` are
mounted into the container. Changing `package.json` needs
`docker compose build frontend`.

**Neon connection hangs** — free-tier Neon suspends after inactivity and takes a
few seconds to wake. Retry once before assuming it's broken.
