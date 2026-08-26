"""Response models for the public status endpoints."""

from typing import Literal

from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"


class StatusResponse(BaseModel):
    name: str
    version: str
    environment: str
    launched: bool


class DatabaseHealthResponse(BaseModel):
    connected: bool
    detail: str
