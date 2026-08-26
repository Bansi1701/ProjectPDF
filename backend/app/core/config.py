"""Application settings, loaded from the environment."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    project_name: str = "ProjectPDF API"
    version: str = "0.1.0"
    environment: str = "development"
    debug: bool = True

    # Where the Astro frontend runs. Used for CORS.
    cors_origins: list[str] = [
        "http://localhost:4321",
        "http://127.0.0.1:4321",
    ]

    # Postgres. Not used yet — the coming-soon site needs no database.
    database_url: str | None = None


@lru_cache
def get_settings() -> Settings:
    return Settings()
