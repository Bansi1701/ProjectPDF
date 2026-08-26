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

Ask a maintainer for the `.env` file and save it here as `backend/.env`. It holds
`DATABASE_URL` — the Neon connection string.

Check it worked: `curl localhost:8010/api/v1/health/db`

`.env` is git-ignored. Never commit it.

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
