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
cp backend/.env.example backend/.env    # paste your Neon connection string
docker compose up
```

| Service | URL |
|---|---|
| Site | http://localhost:4321 |
| API | http://localhost:8010 |
| API docs | http://localhost:8010/docs |

Both reload on save. Ports 8000 and 5432 were already in use on this machine,
hence 8010 and 5433.

Check the database is connected:

```bash
curl localhost:8010/api/v1/health/db
```

Without Docker, see [frontend/README.md](frontend/README.md) and
[backend/README.md](backend/README.md).

The frontend does not call the backend yet — it is a static page.
