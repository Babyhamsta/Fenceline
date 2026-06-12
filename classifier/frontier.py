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

from classifier.filtering import is_usable


def build_pools(tsv_path: Path, labels: List[str], seed: int = 0,
                denylist: tuple = (), popular_first: tuple = (),
                ranks: Dict[str, int] = None) -> Dict[str, List[str]]:
    """Bucket dist/domains.tsv by label into draw order.

    ``denylist`` drops any domain containing one of its substrings (blogspot's
    dead-blog tail, ad-tech/CDN noise, big general sites mis-listed as adult).
    Labels in ``popular_first`` are ordered by Tranco rank (popular/live sites
    first — representative, and far higher keep-rate) with the unranked tail
    shuffled after; every other label is shuffled deterministically."""
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
            ranked = sorted((d for d in pools[label] if d in ranks),
                            key=lambda d: ranks[d])
            unranked = [d for d in pools[label] if d not in ranks]
            rng.shuffle(unranked)
            pools[label] = ranked + unranked
        else:
            rng.shuffle(pools[label])
    return pools


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
