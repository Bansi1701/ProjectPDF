"""Database engine and session handling.

Targets Neon (serverless Postgres). Two Neon details drive the code below:

1. Neon requires TLS, but ``asyncpg`` does not understand libpq's ``sslmode``
   query parameter — it raises ``TypeError: connect() got an unexpected keyword
   argument 'sslmode'``. So the URL is normalised and TLS is passed separately.
2. Neon's pooled endpoint (the host containing ``-pooler``) runs PgBouncer in
   transaction mode, which is incompatible with asyncpg's prepared-statement
   cache. The cache is disabled when a pooled host is detected.
"""

from collections.abc import AsyncIterator
from urllib.parse import urlencode, urlsplit, urlunsplit

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import get_settings

# libpq parameters asyncpg rejects. Neon's copy-paste string includes both.
_LIBPQ_ONLY_PARAMS = frozenset({"sslmode", "channel_binding", "options"})

# Hosts that speak plain TCP — the compose Postgres, not a managed provider.
_LOCAL_HOSTS = frozenset({"db", "localhost", "127.0.0.1", "::1"})


def normalise_database_url(url: str) -> tuple[str, bool]:
    """Return an asyncpg-safe URL and whether the host is a pooled endpoint.

    Accepts the connection string exactly as Neon presents it, including the
    ``postgresql://`` scheme and ``?sslmode=require&channel_binding=require``.
    """
    parts = urlsplit(url)

    scheme = parts.scheme
    if scheme in {"postgres", "postgresql"}:
        scheme = "postgresql+asyncpg"

    kept = [
        (key, value)
        for key, value in (
            pair.split("=", 1) if "=" in pair else (pair, "")
            for pair in parts.query.split("&")
            if pair
        )
        if key not in _LIBPQ_ONLY_PARAMS
    ]

    pooled = "-pooler" in (parts.hostname or "")
    cleaned = urlunsplit((scheme, parts.netloc, parts.path, urlencode(kept), parts.fragment))
    return cleaned, pooled


def create_engine(url: str) -> AsyncEngine:
    dsn, pooled = normalise_database_url(url)
    host = urlsplit(dsn).hostname or ""

    connect_args: dict[str, object] = {}
    if host not in _LOCAL_HOSTS:
        # Neon and every other managed Postgres require TLS. A local
        # container does not offer it and rejects the upgrade outright.
        connect_args["ssl"] = "require"

    if pooled:
        # PgBouncer transaction pooling cannot carry prepared statements.
        connect_args["statement_cache_size"] = 0

    return create_async_engine(
        dsn,
        connect_args=connect_args,
        # Neon scales to zero; recycle rather than hold dead connections.
        pool_pre_ping=True,
        pool_recycle=300,
        pool_size=5,
        max_overflow=5,
        echo=False,
    )


_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    """Lazily build the engine so importing this module never needs a database."""
    global _engine, _session_factory

    if _engine is None:
        settings = get_settings()
        if not settings.database_url:
            raise RuntimeError("DATABASE_URL is not set — add it to backend/.env")
        _engine = create_engine(settings.database_url)
        _session_factory = async_sessionmaker(_engine, expire_on_commit=False)

    return _engine


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency yielding a session that always closes."""
    get_engine()
    assert _session_factory is not None

    async with _session_factory() as session:
        yield session


async def dispose_engine() -> None:
    """Close the pool on shutdown so Neon sheds the connections promptly."""
    global _engine, _session_factory

    if _engine is not None:
        await _engine.dispose()
        _engine = None
        _session_factory = None
