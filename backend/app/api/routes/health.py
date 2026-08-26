"""Liveness and dependency probes."""

from fastapi import APIRouter
from sqlalchemy import text

from app.core.db import get_engine
from app.schemas.status import DatabaseHealthResponse, HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Liveness only. Dependency-free so it stays green during an outage."""
    return HealthResponse()


@router.get("/health/db", response_model=DatabaseHealthResponse)
async def health_db() -> DatabaseHealthResponse:
    """Round-trips a query to confirm the database is actually reachable."""
    try:
        engine = get_engine()
        async with engine.connect() as conn:
            version = await conn.scalar(text("select version()"))
    except Exception as exc:  # surfaced as data, not a 500 — this IS the probe
        return DatabaseHealthResponse(
            connected=False,
            detail=f"{type(exc).__name__}: {exc}"[:300],
        )

    return DatabaseHealthResponse(connected=True, detail=str(version)[:120])
