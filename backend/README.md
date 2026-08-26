# Backend

FastAPI control plane. Deliberately small.

**It does:** accounts, billing, usage limits, and the few conversions a browser cannot do.
**It does not:** receive, process, or store document bytes. Those never leave the client.

## Run

With Docker (from the repo root):

```bash
docker compose up backend
```

Or directly:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

uvicorn app.main:app --reload
pytest
```

Docs at http://localhost:8010/docs while `DEBUG=true`.

## Database (Neon)

1. Neon dashboard → your project → **Connect** → copy the connection string.
2. `cp .env.example .env` and paste it as `DATABASE_URL`. Paste it **exactly** as
   Neon gives it — the app strips the parameters `asyncpg` cannot handle
   (`sslmode`, `channel_binding`) and enables TLS itself.
3. Use the **pooled** host (contains `-pooler`) for the app; the **direct** host
   for Alembic migrations.
4. Check it: `curl localhost:8010/api/v1/health/db`

`.env` is git-ignored. Never commit it.

To work offline against a throwaway local Postgres instead:

```bash
docker compose --profile local-db up
# DATABASE_URL=postgresql://projectpdf:projectpdf@db:5432/projectpdf
```

## Structure

```
app/
├── main.py       # app instance, CORS, router mount
├── core/         # config.py — settings from env
├── api/
│   ├── router.py # aggregates route modules
│   └── routes/   # health.py, status.py
├── schemas/      # pydantic request/response models
├── models/       # database tables (empty until accounts land)
└── services/     # business logic (empty)
tests/
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/health` | Liveness probe — no dependencies |
| GET | `/api/v1/status` | Build info + launch flag |
| GET | `/api/v1/health/db` | Round-trips a query to Neon |

## Notes

The database connects but has no tables yet — models arrive with accounts and
billing. `app/core/db.py` handles the two Neon quirks: `asyncpg` rejects libpq's
`sslmode` parameter, and Neon's pooled endpoint runs PgBouncer in transaction
mode, which breaks prepared-statement caching.
