# CLAUDE.md

Conventions for this repo. Claude Code reads this automatically; humans should
read it too. Full contributor setup is in [CONTRIBUTING.md](CONTRIBUTING.md).

## What this is

Privacy-first PDF tools. **Every document operation runs in the user's browser.**
Files do not reach a server. That constraint drives every decision below — when
something is easier server-side, that is not a reason to move it there.

Frontend: Astro + TypeScript. Backend: Python + FastAPI. Database: Neon Postgres.
Reasoning is in [Docs/TECH_STACK.md](Docs/TECH_STACK.md) — read it before proposing
a library or architecture change.

## Commands

```bash
docker compose up                                  # run everything
docker compose up -d --force-recreate backend      # after editing backend/.env

docker compose exec backend python -m pytest       # tests
docker compose exec backend ruff check --fix .     # lint
docker compose exec backend ruff format .          # format
cd frontend && npm run build                       # frontend check
```

Site on **:4321**, API on **:8010** (not 8000 — it was taken).

## Hard rules

**Never add a GPL or AGPL dependency.** This is closed-source commercial software;
shipping AGPL as WASM to a browser is distribution, and running it as a service
trips AGPL §13. Banned: MuPDF, PyMuPDF (`fitz`), Ghostscript, iText. The risk is
transitive — `pdf2docx` reads as MIT but pins AGPL PyMuPDF; `heic2any` reads as MIT
but bundles LGPL libheif. **Check the full dependency tree and any native code
inside a `.wasm` before adding anything.** Use `pikepdf` (MPL-2.0), not PyMuPDF.

**Never enable cross-origin isolation.** No `Cross-Origin-Opener-Policy` or
`Cross-Origin-Embedder-Policy` headers, no `SharedArrayBuffer`, no WASM threads.
It reads as an obvious performance win and is not: COOP/COEP kills ad revenue in
every browser, blocks Stripe Elements, breaks embeds, and severs `window.opener`
for OAuth popups. Safari has no `credentialless` escape. Parallelise with separate
`Worker` instances — ~85% of the throughput, 100% of the compatibility.

**Never let document content leave the client.** No document bytes through the API.
No filenames, extracted text, or document contents in logs, analytics, or error
reports. Log job id, tool, duration, byte counts. No customer file enters this repo,
not even as a test fixture — `/corpus/` is git-ignored deliberately.

**Never commit secrets.** `.env` is git-ignored. New config keys go in
`.env.example` with placeholder values.

## Git

**Do not add `Co-Authored-By` trailers, "Generated with Claude Code" lines, or any
AI attribution to commits or PRs.** Commits are authored by the human running the
work.

Branch off `main`, one concern per PR. Commit messages are present tense and
explain *why*, not what — the diff already says what:

```
Add page-reorder drag handles

dnd-kit re-evaluates every droppable on pointer move, which janks past
~200 thumbnails. Uses pragmatic-drag-and-drop instead.
```

If a change adds a dependency, name its license in the message.

## Backend patterns

Routes are thin. Business logic lives in `app/services/`, database models in
`app/models/`, request/response shapes in `app/schemas/`.

Adding an endpoint:

1. Response model in `app/schemas/<area>.py`
2. Route in `app/api/routes/<area>.py` — an `APIRouter` with `tags`
3. Register it in `app/api/router.py`
4. Test in `tests/`

```python
router = APIRouter(tags=["documents"])

@router.get("/documents/{doc_id}", response_model=DocumentResponse)
async def get_document(
    doc_id: UUID,
    session: AsyncSession = Depends(get_session),
) -> DocumentResponse:
    ...
```

`async def` everywhere — the database driver is async. Type hints on every
signature. Settings come from `get_settings()`, never `os.environ` directly.
Database sessions come from the `get_session` dependency, never by constructing
an engine.

**Probes report failure as data, not exceptions.** `/health/db` returns
`{"connected": false, "detail": "..."}` rather than a 500 — the point is to say
what broke. Keep `detail` credential-free so it can be pasted into a bug report.

## Frontend patterns

Default to a static `.astro` component. Add a React island only when a page needs
real interactivity, and give it the narrowest `client:*` directive that works
(`client:idle` over `client:load`).

- `src/config/site.ts` — brand name, tool list. Content changes go here, not in markup.
- `src/layouts/` — page shells and `<head>`
- `src/components/` — reusable pieces, styles scoped in the component's `<style>`
- `src/styles/global.css` — design tokens only

Use the CSS custom properties (`--ink`, `--muted`, `--line`, `--accent`, `--radius`).
Don't hardcode colours.

**SEO pages ship zero JavaScript.** A tool page's `<h1>` and dropzone must paint
from static HTML with no JS on the critical path. **Never fetch WASM on page load** —
fetch it on first user interaction, or it tanks LCP on mobile.

Every PDF operation runs in a Web Worker. Never block the main thread.

## Code style

Python: `ruff` (line length 100). Docstrings where the *why* isn't obvious; skip
them where it is.

TypeScript: strict mode, no `any`.

Comments explain reasoning, not mechanics. `# increment counter` is noise;
`# Neon's pooler breaks prepared statements` earns its place.

## When unsure

Check [Docs/TECH_STACK.md](Docs/TECH_STACK.md) first — it has a per-tool matrix of
what runs client-side vs. server-side and which engine handles it. If a change
would move work from the browser to the server, that is a product decision, not an
implementation detail. Ask.
