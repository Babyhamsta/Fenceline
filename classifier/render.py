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
from typing import Dict, Optional

from playwright.async_api import async_playwright

_BLOCK_TYPES = {"image", "media", "font", "stylesheet"}

_EXTRACT_JS = r"""() => {
  const text = document.body ? document.body.innerText : "";
  const title = document.title || "";
  const metaEl = document.querySelector('meta[name="description"]');
  // Skip og:image/video/audio/url — they are URLs (and a common home for
  // base64 data: media), not useful text features.
  const og = [...document.querySelectorAll('meta[property^="og:"]')]
      .filter(m => !/^og:(image|video|audio|url)/i.test(m.getAttribute('property') || ''))
      .map(m => m.getAttribute('content') || '').join(' ');
  const meta = ((metaEl && metaEl.getAttribute('content')) || '') + ' ' + og;
  const scriptHosts = [...new Set([...document.scripts]
      .map(s => { try { return new URL(s.src).hostname; } catch { return ''; } })
      .filter(Boolean))];
  const hasAgeGate = /age.?(verification|gate)|must be (18|21|over)|adults only/i
      .test(text);
  return { text, title, meta,
           structural: { script_hosts: scriptHosts,
                         iframe_count: document.querySelectorAll('iframe').length,
                         has_age_gate: hasAgeGate } };
}"""


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
    self-signed certs — we still want their text rather than dropping them."""
    ctx = await browser.new_context(ignore_https_errors=True)
    await ctx.route("**/*", _route)
    ctx.set_default_timeout(timeout_ms)
    ctx.set_default_navigation_timeout(timeout_ms)
    return ctx


async def render_on_context(ctx, url: str, timeout_ms: int = 15000,
                            hard_deadline: Optional[float] = None
                            ) -> Optional[Dict]:
    """Render one URL on an already-open context, bounded by a hard deadline so
    a wedged page can never block the worker. Returns the raw fields or None."""
    async def _do():
        page = await ctx.new_page()
        try:
            await page.goto(url, wait_until="domcontentloaded",
                            timeout=timeout_ms)
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
            browser = await p.chromium.launch(headless=True)
            try:
                ctx = await open_context(browser, timeout_ms)
                return await render_on_context(ctx, url, timeout_ms)
            finally:
                try:
                    await browser.close()
                except Exception:
                    pass

    return asyncio.run(_run())
