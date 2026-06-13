"""Harvest current web-proxy domains from unblokkked.web.app into proxy-bypass
seeds. The site is a Firestore-backed SPA that lists proxy *providers*, each
exposing several mirror endpoints; we drive it the way a user would (Playwright)
rather than calling its backend.

Per the seed file's philosophy — a quality ANCHOR for the page signature, not an
exhaustive list — we take **one domain per provider**, because a provider's many
hosts are the same proxy on different endpoints (adding them all just bloats the
scrape with near-identical pages). We also drop shared hosting/CDN registrable
domains (vercel.app, workers.dev, amazonaws.com, …): the proxy is a *subdomain*
there, so force-labeling the bare platform domain would mislabel all of it.

Prints one bare domain per line. Pipe/paste the branded picks under a dated
section in ``proxy_seed.txt``. Re-runnable to refresh as proxies churn.

Usage:  python classifier/scrape_unblokkked.py [--all]
        --all also prints lower-confidence generic/squatted mirror hosts.
"""

import re
import sys
import time

from playwright.sync_api import sync_playwright

from classifier.etld import etld1

URL = "https://unblokkked.web.app/"

# Shared hosting / CDN / infra — the proxy is a subdomain, the registrable
# domain is the platform; force-labeling it proxy-bypass would mislabel clean.
INFRA = {
    "amazonaws.com",
    "vercel.app",
    "workers.dev",
    "pages.dev",
    "netlify.app",
    "onrender.com",
    "cloudflare.net",
    "cloudflare.com",
    "fastly.net",
    "jsdelivr.net",
    "unpkg.com",
    "surge.sh",
    "github.io",
    "githubusercontent.com",
    "herokuapp.com",
    "web.app",
    "firebaseapp.com",
    "gstatic.com",
    "googleapis.com",
    "plesk.page",
    "ipv64.net",
    "camdvr.org",
}
# Throwaway / proxy-ish TLDs — a reasonable secondary signal for a dedicated
# proxy domain when the name doesn't match the provider.
PROXY_TLDS = (
    "lol",
    "top",
    "lat",
    "rest",
    "space",
    "gq",
    "cc",
    "vc",
    "best",
    "games",
    "pro",
    "site",
    "fun",
    "wtf",
    "pm",
)

_HOST_RE = re.compile(r"\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b", re.IGNORECASE)
_NOISE_RE = re.compile(
    r"(^|\.)(discord\.gg|discordapp\.com|unblokkked\.|w3\.org|youtube\.com|youtu\.be)$",
    re.IGNORECASE,
)


def _hosts_from_text(text: str) -> list[str]:
    out = []
    for h in _HOST_RE.findall(text or ""):
        h = h.lower()
        if not _NOISE_RE.search(h) and not h.endswith(
            (".png", ".jpg", ".svg", ".js", ".css", ".webp", ".ico")
        ):
            out.append(h)
    return out


def _pick(provider: str, hosts: list[str]) -> str | None:
    """One anchor domain per provider: prefer a name-matched (branded) domain,
    then a proxy-ish TLD, then the first non-infra registrable domain."""
    cands: list[str] = []
    for h in hosts:
        d = etld1(h)
        if d and d not in cands and d not in INFRA:
            cands.append(d)
    if not cands:
        return None
    key = re.sub(r"[^a-z0-9]", "", provider.lower())
    for d in cands:
        label = d.split(".")[0]
        if len(label) >= 4 and (label in key or key in label or key[:5] == label[:5]):
            return d
    for d in cands:
        if d.rsplit(".", 1)[-1] in PROXY_TLDS:
            return d
    return cands[0]


def harvest() -> dict[str, str]:
    """provider -> one anchor domain. Drives the SPA: open the proxies module,
    open each provider card, read its rendered mirror hostnames, go back."""
    picks: dict[str, str] = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(URL, wait_until="domcontentloaded")
        page.wait_for_timeout(1500)
        page.get_by_role("button", name=re.compile("proxies", re.I)).first.click()
        page.wait_for_timeout(1500)

        names = page.evaluate(
            """() => [...new Set([...document.querySelectorAll('div')]
                 .filter(e => /font-heading/.test((e.className||'').toString()))
                 .map(e => (e.textContent||'').trim())
                 .filter(n => n.length >= 2 && n.toLowerCase() !== 'unblokked'))]"""
        )
        for name in names:
            # Ensure we're on the provider grid (return from any open detail view).
            page.evaluate(
                """() => { const b=[...document.querySelectorAll('button')]
                     .find(x=>/back to proxies/i.test(x.textContent||'')); if(b) b.click(); }"""
            )
            page.wait_for_timeout(300)
            opened = page.evaluate(
                """(name) => { const c=[...document.querySelectorAll('div')]
                     .find(e=>/font-heading/.test((e.className||'').toString())
                            && (e.textContent||'').trim()===name);
                     if(c){c.click(); return true;} return false; }""",
                name,
            )
            if not opened:
                continue
            page.wait_for_timeout(750)
            text = page.evaluate("() => document.body.innerText || ''")
            d = _pick(name, _hosts_from_text(text))
            if d:
                picks[name] = d
        browser.close()
    return picks


def main() -> None:
    show_all = "--all" in sys.argv
    picks = harvest()
    branded, generic = {}, {}
    for prov, dom in picks.items():
        key = re.sub(r"[^a-z0-9]", "", prov.lower())
        label = dom.split(".")[0]
        if len(label) >= 4 and (label in key or key in label or key[:5] == label[:5]):
            branded[prov] = dom
        else:
            generic[prov] = dom
    print(
        f"# unblokkked.web.app — {len(picks)} providers, "
        f"{len(set(branded.values()))} branded / {len(set(generic.values()))} generic "
        f"({time.strftime('%Y-%m-%d')})"
    )
    for d in sorted(set(branded.values())):
        print(d)
    if show_all:
        print("# --- generic / squatted mirror hosts (lower confidence) ---")
        for d in sorted(set(generic.values())):
            print(d)


if __name__ == "__main__":
    main()
