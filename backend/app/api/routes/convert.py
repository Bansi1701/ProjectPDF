"""Conversions that genuinely cannot happen in the browser.

Only one qualifies: rendering a public web page, because CORS makes it
impossible client-side. Everything else this product does stays on the user's
machine, and this route exists precisely so that stays true — there is no
general "upload your document" endpoint here, by design.
"""

from fastapi import APIRouter, HTTPException, Response

from app.schemas.convert import UrlToPdfRequest
from app.services.urlsafety import UnsafeUrl
from app.services.webpage import RenderError, render

router = APIRouter(tags=["convert"])


@router.post(
    "/convert/url-to-pdf",
    response_class=Response,
    responses={200: {"content": {"application/pdf": {}}}},
)
async def url_to_pdf(request: UrlToPdfRequest) -> Response:
    try:
        result = await render(str(request.url), landscape=request.landscape)
    except UnsafeUrl as exc:
        # 400, not 500: the request was understood and refused.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RenderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    safe_name = "".join(c for c in result.title if c.isalnum() or c in " -_")[:60].strip()

    return Response(
        content=result.pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{safe_name or "page"}.pdf"',
            # Nothing about the fetched page should be cached by anything.
            "Cache-Control": "no-store",
        },
    )
