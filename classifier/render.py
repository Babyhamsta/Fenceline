"""Headless-Chromium render -> the raw fields the extension will also see.
Safety: sub-resources (images/media/fonts) are aborted; we only need DOM text.
Never stores raw HTML or media.

Async by design: every render is bounded by a hard wall-clock deadline via
``asyncio.wait_for``. ``page.goto`` has its own timeout, but ``page.evaluate``
and ``page.new_page`` do not — a page whose JS main thread is wedged (common on
anti-bot walls) would otherwise hang its worker forever. The deadline abandons
such a page instead of blocking. The bulk scraper drives ``render_on_context``
directly; ``render`` is a sync single-shot wrapper for ad-hoc/parity use."""

import asyncio
from pathlib import Path
from typing import Dict, Optional

from playwright.async_api import async_playwright

_BLOCK_TYPES = {"image", "media", "font", "stylesheet"}

# A real managed-Chromebook UA + desktop viewport so we capture the page a
# student would see, not a headless/bot-wall variant. Paired with an init script
# that hides the automation flag (navigator.webdriver) — the cheapest, most
# stable cloaking defence; full headful would need a display and destabilise a
# 16-worker overnight sweep.
_CHROMEBOOK_UA = (
    "Mozilla/5.0 (X11; CrOS x86_64 15917.71.0) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
_VIEWPORT = {"width": 1366, "height": 768}
_STEALTH_JS = "Object.defineProperty(navigator, 'webdriver', {get: () => undefined});"

# The structural-feature extractor is ONE source of truth shared with the live
# content script. We inject its source into the page and call it here so the
# training corpus and the device compute byte-identical feature vectors — there
# is no Python-side feature math to drift. Read once at import.
_STRUCT_SRC = (
    Path(__file__).resolve().parent.parent / "extension" / "content" / "structural-features.js"
).read_text(encoding="utf-8")

# Single arrow function (Playwright calls it with no args). The injected source
# defines fencelineExtractStructural() (hoisted); we add the text/title/meta/link
# extraction and return the structural dict the shared function computes. The
# file's trailing `module.exports` guard is inert here (module is undefined).
_EXTRACT_JS = (
    "() => {\n"
    + _STRUCT_SRC
    + "\n"
    + r"""
  const text = document.body ? document.body.innerText : "";
  const title = document.title || "";
  const metaEl = document.querySelector('meta[name="description"]');
  // Skip og:image/video/audio/url — they are URLs (and a common home for
  // base64 data: media), not useful text features.
  const og = [...document.querySelectorAll('meta[property^="og:"]')]
      .filter(m => !/^og:(image|video|audio|url)/i.test(m.getAttribute('property') || ''))
      .map(m => m.getAttribute('content') || '').join(' ');
  const meta = ((metaEl && metaEl.getAttribute('content')) || '') + ' ' + og;
  // Absolute hrefs of in-page links — the scraper samples a few same-eTLD+1 ones
  // to also render interior pages. Capped + deduped; transient (build_record
  // ignores it, so stored records stay byte-identical to the homepage path).
  const links = [...new Set([...document.querySelectorAll('a[href]')]
      .map(a => { try { return new URL(a.href, location.href).href; } catch { return ''; } })
      .filter(h => /^https?:/i.test(h)))].slice(0, 200);
  return { text, title, meta, links, structural: fencelineExtractStructural() };
}"""
)


async def _route(route) -> None:
    # Abort media sub-resources; let the rest through. Guarded because a
    # route can already be handled/closed mid-navigation on flaky pages.
    try:
        if route.request.resource_type in _BLOCK_TYPES:
            await route.abort()
        else:
            await route.continue_()
    except Exception:
        pass


async def open_context(browser, timeout_ms: int = 15000):
    """A media-blocking context. Reused across many pages by the bulk scraper
    so we pay one browser launch per worker instead of one per URL.
    ignore_https_errors: many live proxy/adult/gambling sites run expired or
    self-signed certs — we still want their text rather than dropping them.
    UA/viewport/stealth: present as a real Chromebook so we don't capture
    headless-only bot walls or cloaked stubs."""
    ctx = await browser.new_context(
        ignore_https_errors=True,
        user_agent=_CHROMEBOOK_UA,
        locale="en-US",
        viewport=_VIEWPORT,
    )
    await ctx.add_init_script(_STEALTH_JS)
    await ctx.route("**/*", _route)
    ctx.set_default_timeout(timeout_ms)
    ctx.set_default_navigation_timeout(timeout_ms)
    return ctx


async def render_on_context(
    ctx, url: str, timeout_ms: int = 15000, hard_deadline: Optional[float] = None
) -> Optional[Dict]:
    """Render one URL on an already-open context, bounded by a hard deadline so
    a wedged page can never block the worker. Returns the raw fields or None."""

    async def _do():
        page = await ctx.new_page()
        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            await page.wait_for_timeout(800)  # let SPAs hydrate
            return await page.evaluate(_EXTRACT_JS)
        finally:
            # Best-effort close, itself bounded so a wedged page can't hang here.
            try:
                await asyncio.wait_for(page.close(), timeout=5)
            except Exception:
                pass

    deadline = hard_deadline if hard_deadline is not None else timeout_ms / 1000 + 6
    try:
        return await asyncio.wait_for(_do(), timeout=deadline)
    except Exception:
        return None


def render(url: str, timeout_ms: int = 15000) -> Optional[Dict]:
    """Render one URL in a throwaway browser. Canonical single-shot path used by
    parity/ad-hoc checks; the bulk scraper reuses a browser via open_context."""

    async def _run():
        async with async_playwright() as p:
            browser = await p.chromium.launch(
                headless=True, args=["--disable-blink-features=AutomationControlled"]
            )
            try:
                ctx = await open_context(browser, timeout_ms)
                return await render_on_context(ctx, url, timeout_ms)
            finally:
                try:
                    await browser.close()
                except Exception:
                    pass

    return asyncio.run(_run())
