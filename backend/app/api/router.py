"""Aggregates every versioned route module into one router."""

from fastapi import APIRouter

from app.api.routes import convert, health, status

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(status.router)
api_router.include_router(convert.router)
