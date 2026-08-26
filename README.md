# ProjectPDF

Privacy-first PDF tools. Everything runs in the browser — files never reach a server.

**Status:** pre-launch. The site shows a coming-soon page.

## Stack

| Part | Tech |
|---|---|
| Frontend | Astro + TypeScript |
| Backend | Python + FastAPI |
| Database | Neon (managed PostgreSQL) |
| PDF engine | Runs client-side — `pdf.js` + `pdf-lib` |
| Hosting | Cloudflare |

See [Docs/TECH_STACK.md](Docs/TECH_STACK.md) for the full reasoning.

## Layout

```
ProjectPDF/
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
