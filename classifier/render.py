"""Headless-Chromium render -> the raw fields the extension will also see.
Safety: sub-resources (images/media/fonts) are aborted; we only need DOM text.
Never stores raw HTML or media."""
from typing import Dict, Optional

from playwright.sync_api import sync_playwright

_BLOCK_TYPES = {"image", "media", "font", "stylesheet"}

_EXTRACT_JS = r"""() => {
  const text = document.body ? document.body.innerText : "";
  const title = document.title || "";
  const metaEl = document.querySelector('meta[name="description"]');
  const og = [...document.querySelectorAll('meta[property^="og:"]')]
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


def render(url: str, timeout_ms: int = 15000) -> Optional[Dict]:
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context()
            ctx.route("**/*", lambda route: (
                route.abort() if route.request.resource_type in _BLOCK_TYPES
                else route.continue_()))
            page = ctx.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            page.wait_for_timeout(800)  # let SPAs hydrate
            raw = page.evaluate(_EXTRACT_JS)
            browser.close()
            return raw
    except Exception:
        return None
