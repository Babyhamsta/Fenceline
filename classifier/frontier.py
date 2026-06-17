"""Per-label domain frontier for target-driven scraping.

We draw from a shuffled pool and persist what we've already attempted in an
append-only log (kill-safe), so re-runs never re-hit the same domain and the
kept corpus grows monotonically toward the per-class target. The pool order is
deterministic given a seed; it is the persisted attempt log — not the shuffle —
that guarantees fresh draws across runs. The dataset does not expire, so a class
that falls short today can be topped up by simply running again later."""

import json
import random
from pathlib import Path
from typing import Dict, List, Set
from urllib.parse import urlsplit

from classifier.etld import etld1
from classifier.filtering import is_usable


def build_pools(
    tsv_path: Path,
    labels: List[str],
    seed: int = 0,
    denylist: tuple = (),
    popular_first: tuple = (),
    ranks: Dict[str, int] = None,
    force_label: Dict[str, List[str]] = None,
) -> Dict[str, List[str]]:
    """Bucket dist/domains.tsv by label into draw order.

    ``denylist`` drops any domain containing one of its substrings (blogspot's
    dead-blog tail, ad-tech/CDN noise, big general sites mis-listed as adult).
    Labels in ``popular_first`` are ordered by Tranco rank (popular/live sites
    first — representative, and far higher keep-rate) with the unranked tail
    shuffled after; every other label is shuffled deterministically.

    ``force_label`` maps a label to domains that must be drawn under that label
    regardless of how the blocklists categorized them (e.g. web proxies that sit
    under ``adult`` by precedence). Forced domains are removed from every other
    pool and prepended to their label's pool so they're scraped first."""
    deny = tuple(denylist)
    ranks = ranks or {}
    pools: Dict[str, List[str]] = {lab: [] for lab in labels}
    for line in Path(tsv_path).read_text(encoding="utf-8").splitlines():
        if "\t" not in line:
            continue
        domain, label = line.split("\t", 1)
        if label not in pools:
            continue
        if deny and any(token in domain for token in deny):
            continue
        pools[label].append(domain)
    rng = random.Random(seed)
    for label in sorted(pools):
        if label in popular_first and ranks:
            ranked = sorted((d for d in pools[label] if d in ranks), key=lambda d: ranks[d])
            unranked = [d for d in pools[label] if d not in ranks]
            rng.shuffle(unranked)
            pools[label] = ranked + unranked
        else:
            rng.shuffle(pools[label])
    if force_label:
        forced = {d for doms in force_label.values() for d in doms}
        for lab in pools:
            pools[lab] = [d for d in pools[lab] if d not in forced]
        for lab, doms in force_label.items():
            if lab not in pools:
                continue
            seen: Set[str] = set()
            uniq = [d for d in doms if not (d in seen or seen.add(d))]
            pools[lab] = uniq + pools[lab]
    return pools


def load_seed(path: Path) -> List[str]:
    """Read a seed list (one bare domain per line; ``#`` comments and blanks
    skipped) — e.g. proxy_seed.txt, force-labeled proxy-bypass at scrape time."""
    p = Path(path)
    if not p.exists():
        return []
    out: List[str] = []
    for line in p.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s and not s.startswith("#"):
            out.append(s)
    return out


def sample_interior_links(
    links: List[str], base_etld1: str, k: int, rng: random.Random
) -> List[str]:
    """Pick up to ``k`` random same-eTLD+1 interior URLs from a homepage's links.

    Random (not pattern-matched) keeps selection behavior-based — on a game/proxy
    portal a random interior link is overwhelmingly a game/proxy page. Root-path
    links (the homepage itself) and off-site links are dropped; the rest are
    deduped, then a random subset is returned."""
    if k <= 0 or not base_etld1:
        return []
    seen: Set[str] = set()
    candidates: List[str] = []
    for href in links:
        try:
            parts = urlsplit(href)
        except ValueError:
            continue
        if parts.path.strip("/") == "" and not parts.query:
            continue  # homepage root, not an interior page
        if href in seen or etld1(href) != base_etld1:
            continue
        seen.add(href)
        candidates.append(href)
    if len(candidates) <= k:
        return candidates
    return rng.sample(candidates, k)


def load_ranks(tranco_path: Path) -> Dict[str, int]:
    """Read `rank,domain` rows from a Tranco CSV into {domain: rank}."""
    ranks: Dict[str, int] = {}
    p = Path(tranco_path)
    if not p.exists():
        return ranks
    for line in p.read_text(encoding="utf-8").splitlines():
        if "," not in line:
            continue
        r, d = line.split(",", 1)
        try:
            ranks[d] = int(r)
        except ValueError:
            continue
    return ranks


def domain_of_url(url: str) -> str:
    """`https://poki.com/` -> `poki.com` (mirror of the scraper's url scheme)."""
    return url.removeprefix("https://").removeprefix("http://").rstrip("/")


def kept_by_label(raw_path: Path) -> Dict[str, int]:
    """Count usable records already in the corpus, per label — our progress."""
    counts: Dict[str, int] = {}
    for rec in _iter_records(raw_path):
        if is_usable(rec):
            counts[rec["label"]] = counts.get(rec["label"], 0) + 1
    return counts


def kept_domains(raw_path: Path) -> Set[str]:
    """Every domain already in the corpus (any label), to skip re-rendering."""
    out: Set[str] = set()
    for rec in _iter_records(raw_path):
        url = rec.get("url")
        if url:
            out.add(domain_of_url(url))
    return out


def attempted_path(state_dir: Path, label: str) -> Path:
    return Path(state_dir) / f"{label}.attempted"


def load_attempted(state_dir: Path, label: str) -> Set[str]:
    p = attempted_path(state_dir, label)
    if not p.exists():
        return set()
    return set(p.read_text(encoding="utf-8").split())


def remaining(pool: List[str], attempted: Set[str], kept: Set[str]) -> List[str]:
    """Pool minus anything already tried or already in the corpus, order kept."""
    skip = attempted | kept
    return [d for d in pool if d not in skip]


def _iter_records(raw_path: Path):
    p = Path(raw_path)
    if not p.exists():
        return
    # split on "\n" only: page text may contain unicode line separators that
    # str.splitlines() would split on, tearing a JSON record in two.
    for line in p.read_text(encoding="utf-8").split("\n"):
        if not line.strip():
            continue
        try:
            yield json.loads(line)
        except Exception:
            continue
