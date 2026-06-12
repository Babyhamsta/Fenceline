"""Drop pages that would poison training: dead/thin shells, parked domains, and
bot-challenge/security interstitials (Cloudflare et al.). An interstitial shows
the same "verify you are human" text regardless of the site's real category, so
keeping them teaches the model that boilerplate maps to whatever label the page
sat behind — e.g. a gambling site stuck behind Cloudflare would push "ray id"
toward `clean`, causing under-blocking. Also doubles as a blocklist liveness
audit downstream."""

from typing import Dict

MIN_TOKENS = 20
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
    if len(text.split()) < MIN_TOKENS:
        return False
    if any(m in text for m in _PARK_MARKERS):
        return False
    # Title carries the challenge name (e.g. "Just a moment...") on some walls.
    blob = (record.get("title") or "").lower() + " " + text
    if any(m in blob for m in _INTERSTITIAL_MARKERS):
        return False
    if any(m in blob for m in _REMOVED_ERROR_MARKERS):
        return False
    return True
