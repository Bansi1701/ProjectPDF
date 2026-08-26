"""Render a public web page to PDF with headless Chromium.

This is the one tool that genuinely belongs on a server, and the reason is
worth stating: a browser cannot fetch a third-party page. CORS blocks the HTML
and every stylesheet, font and image inside it, and `X-Frame-Options` blocks
iframing. There is no client-side version of this to build.

It does not, however, weaken the product's promise. No document of the user's
is involved — they hand over a public address, and we fetch what anyone could
fetch. Nothing private is transmitted because there is nothing private to
transmit.
"""

import asyncio
from dataclasses import dataclass

from app.services.urlsafety import UnsafeUrl, validate

# A page that has not settled in this long is not going to.
TIMEOUT_MS = 20_000

# Chromium is given no more than this to produce a file.
HARD_TIMEOUT_S = 45


@dataclass(slots=True)
class RenderResult:
    pdf: bytes
    title: str
    final_url: str


class RenderError(RuntimeError):
    """Rendering failed for a reason worth showing the user."""


async def render(url: str, landscape: bool = False) -> RenderResult:
    """Fetch and render `url`. Raises UnsafeUrl or RenderError."""
    safe = validate(url)

    try:
        from playwright.async_api import async_playwright
    except ImportError as exc:  # pragma: no cover - depends on the image
        raise RenderError(
            "The renderer is not installed in this environment."
        ) from exc

    try:
        return await asyncio.wait_for(_render(safe, landscape), timeout=HARD_TIMEOUT_S)
    except asyncio.TimeoutError as exc:
        raise RenderError("That page took too long to render.") from exc


async def _render(url: str, landscape: bool) -> RenderResult:
    from playwright.async_api import async_playwright

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
                # The page is untrusted; give it nothing to reach for.
                "--disable-background-networking",
            ]
        )
        try:
            context = await browser.new_context(
                viewport={"width": 1280, "height": 900},
                java_script_enabled=True,
                # Do not carry any identity into the fetch.
                storage_state=None,
            )
            page = await context.new_page()

            # Re-check on every navigation: a redirect can land somewhere the
            # original hostname never resolved to.
            async def guard(route, request):
                try:
                    validate(request.url)
                except UnsafeUrl:
                    await route.abort()
                    return
                await route.continue_()

            await page.route("**/*", guard)

            response = await page.goto(url, wait_until="networkidle", timeout=TIMEOUT_MS)
            if response is None:
                raise RenderError("That page did not respond.")
            if response.status >= 400:
                raise RenderError(f"That page returned HTTP {response.status}.")

            title = (await page.title()) or url

            pdf = await page.pdf(
                format="A4",
                landscape=landscape,
                print_background=True,
                margin={"top": "12mm", "bottom": "12mm", "left": "10mm", "right": "10mm"},
            )

            return RenderResult(pdf=pdf, title=title, final_url=page.url)
        finally:
            await browser.close()
