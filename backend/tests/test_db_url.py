"""The URL rewriting is the part most likely to break silently, so pin it."""

from app.core.db import normalise_database_url

NEON = (
    "postgresql://alice:pw@ep-cool-cell-123-pooler.us-east-2.aws.neon.tech"
    "/neondb?sslmode=require&channel_binding=require"
)


def test_neon_string_is_rewritten_for_asyncpg() -> None:
    dsn, pooled = normalise_database_url(NEON)

    assert dsn.startswith("postgresql+asyncpg://")
    assert "sslmode" not in dsn
    assert "channel_binding" not in dsn
    assert pooled is True


def test_direct_endpoint_is_not_flagged_as_pooled() -> None:
    _, pooled = normalise_database_url(NEON.replace("-pooler", ""))
    assert pooled is False


def test_other_query_params_survive() -> None:
    dsn, _ = normalise_database_url(f"{NEON}&application_name=projectpdf")
    assert "application_name=projectpdf" in dsn
