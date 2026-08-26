"""Request shapes for the conversion routes."""

from pydantic import BaseModel, Field, HttpUrl


class UrlToPdfRequest(BaseModel):
    url: HttpUrl = Field(description="A publicly reachable http or https address.")
    landscape: bool = Field(default=False)
