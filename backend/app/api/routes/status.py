"""Public build/status information, consumed by the frontend."""

from fastapi import APIRouter, Depends

from app.core.config import Settings, get_settings
from app.schemas.status import StatusResponse

router = APIRouter(tags=["status"])


@router.get("/status", response_model=StatusResponse)
async def status(settings: Settings = Depends(get_settings)) -> StatusResponse:
    return StatusResponse(
        name=settings.project_name,
        version=settings.version,
        environment=settings.environment,
        launched=False,
    )
