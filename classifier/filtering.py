"""Drop pages that would poison training: dead/thin shells, parked domains, and
bot-challenge/security interstitials (Cloudflare et al.). An interstitial shows
the same "verify you are human" text regardless of the site's real category, so
keeping them teaches the model that boilerplate maps to whatever label the page
sat behind — e.g. a gambling site stuck behind Cloudflare would push "ray id"
toward `clean`, causing under-blocking. Also doubles as a blocklist liveness
audit downstream."""

from typing import Dict

# Thin-page gate, mirrored byte-for-byte in extension/content/scan.js so the
# model is only ever asked to score input shapes it trained on. A page carries
# enough signal if its body has real text OR its title+meta do — an interior
# game page is often one canvas element (empty body) under a loud title
# ("Slope Unblocked — Play Free") + og:description, and that signal is real.
# Body is counted in non-space CHARS (a glyph-cipher page maps spaces away, so
# token-counting would wrongly read it as empty); title+meta in tokens.
MIN_BODY_CHARS = 80
MIN_META_TOKENS = 6
_PARK_MARKERS = (
    "domain is for sale",
    "buy this domain",
    "this domain is parked",
    "domain parking",
    "is for sale",
    "purchase this domain",
    "godaddy",
    "sedo",
    "hugedomains",
)
# Multi-word signatures specific to bot-walls/challenge pages — chosen to be
# phrases real content almost never contains, to avoid dropping genuine pages.
_INTERSTITIAL_MARKERS = (
    "performing security verification",
    "this website uses a security service to protect",
    "verifying you are not a bot",
    "verify you are human by completing",
    "checking your browser before accessing",
    "enable javascript and cookies to continue",
    "needs to review the security of your connection",
    "sorry, you have been blocked",
    "ddos protection by cloudflare",
    "performance & security by cloudflare",
    "ray id:",
    # Non-Cloudflare bot/rate-limit/consent walls a headless crawl can land on
    # (Google "unusual traffic" security check, PerimeterX press-and-hold, generic
    # access-denied). Measured at ~0.23% of the scraped corpus, concentrated in
    # the proxy-bypass tail; same boilerplate-maps-to-wrong-label hazard.
    "detected unusual traffic",
    "unusual traffic from your computer",
    "checks to see if it's really you",
    "press & hold to confirm",
    "access to this page has been denied",
    "please verify you are a human",
    "your request has been blocked",
    "please enable javascript to continue",
)
# Deleted-content / error / server-default boilerplate. These platform pages
# render the same text on thousands of domains regardless of the (now gone) site
# — e.g. the "blog has been removed" page that dominates the adult blocklist's
# dead blogspot tail — so they are pure label noise, not category content.
_REMOVED_ERROR_MARKERS = (
    "blog has been removed",
    "requested url was not found",
    "404 not found",
    "page not found",
    "this account has been suspended",
    "account has been suspended",
    "default webpage generated",
    "this is the default web page",
    "welcome to nginx",
    "directory listing for",
)


def is_usable(record: Dict) -> bool:
    text = (record.get("text") or "").lower()
    title = (record.get("title") or "").lower()
    meta = (record.get("meta") or "").lower()
    body_chars = len("".join(text.split()))  # non-space chars
    meta_tokens = len((title + " " + meta).split())
    if body_chars < MIN_BODY_CHARS and meta_tokens < MIN_META_TOKENS:
        return False
    # Run every marker over the full scored document (title + meta + text): a
    # parked/interstitial/removed page can carry its tell in any field — e.g. the
    # challenge name in the title ("Just a moment..."), "is for sale" in meta.
    blob = title + " " + meta + " " + text
    if any(m in blob for m in _PARK_MARKERS):
        return False
    if any(m in blob for m in _INTERSTITIAL_MARKERS):
        return False
    if any(m in blob for m in _REMOVED_ERROR_MARKERS):
        return False
    return True
