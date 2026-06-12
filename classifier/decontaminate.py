"""Find blocked-category sites hiding in the `clean` class.

`clean` is Tranco-popular domains minus our blocklists — but the blocklists are
incomplete (that's why this classifier exists), so popular casinos, porn, and
web-proxies that no list caught leak into `clean`. Training on them as `clean`
teaches the model to *allow* exactly what we want blocked, and inflates the
measured false-positive rate.

We flag a clean record as contaminated when its text carries >=2 distinct terms
from one blocked category (or an explicit age-gate). Two-hit minimum + word
boundaries keep a news article that mentions "casino" once from being dropped.
This is deliberately high-precision: we would rather leave a little
contamination than discard genuinely-clean pages."""
import json
import re
from collections import Counter
from pathlib import Path
from typing import Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parent

# Word-boundary single terms and (substring) multi-word phrases per category.
# Chosen to be distinctive — generic words like "game"/"play"/"bet" alone are
# avoided or boundary-anchored to prevent false hits (alphaBET, esSEX, SLOTHful).
_SIGNALS: Dict[str, Tuple[Tuple[str, ...], Tuple[str, ...]]] = {
    "gambling": (
        ("casino", "casinos", "slots", "betting", "sportsbook", "poker",
         "roulette", "baccarat", "jackpot", "togel", "bandar", "blackjack",
         "bookmaker", "wager", "gamble", "gambling", "bookie"),
        ("no deposit", "free spins", "live casino", "online casino",
         "sports betting", "welcome bonus", "deposit bonus"),
    ),
    # Explicit vocabulary only. Age signals ("18+", "must be 18", age-gate) are
    # deliberately excluded: alcohol, finance, and vaping sites age-gate too, so
    # they caused false drops (clearpay/Afterpay, a magazine) in testing.
    "adult": (
        ("porn", "xxx", "nude", "naked", "camgirl", "hentai", "milf", "anal",
         "blowjob", "creampie", "cumshot", "redtube", "xvideos", "pornhub"),
        ("adult content", "porn videos", "live sex", "sex cams", "xxx videos",
         "free porn", "sex videos"),
    ),
    "proxy-bypass": (
        ("unblock", "glype", "phproxy", "cgiproxy"),
        ("web proxy", "free proxy", "online proxy", "proxy site", "hide your ip",
         "browse anonymously", "anonymous browsing", "unblock websites",
         "unblock any site", "enter a url", "enter url", "bypass filters"),
    ),
    "games": (
        (),
        ("free online games", "play free games", "play games online",
         "browser games", "io games", "multiplayer games", "free flash games"),
    ),
}


def contamination_category(record: Dict) -> Optional[str]:
    """Return the blocked category this `clean` record really belongs to, or
    None if it looks genuinely clean. Counts distinct signals; needs >=2."""
    blob = ((record.get("title") or "") + " " + (record.get("meta") or "") +
            " " + (record.get("text") or "")).lower()
    if not blob.strip():
        return None
    best: Optional[str] = None
    best_hits = 1  # require strictly more than 1
    for cat, (words, phrases) in _SIGNALS.items():
        hits = sum(1 for w in words if re.search(rf"\b{re.escape(w)}\b", blob))
        hits += sum(1 for p in phrases if p in blob)
        if hits > best_hits:
            best_hits, best = hits, cat
    return best


def partition_clean(records: List[Dict], clean_label: str
                    ) -> Tuple[List[Dict], List[Dict]]:
    """Split records into (kept, quarantined). Only `clean` rows are examined;
    every other label passes through untouched."""
    kept, quarantined = [], []
    for r in records:
        if r.get("label") == clean_label:
            cat = contamination_category(r)
            if cat is not None:
                r = dict(r, contamination=cat)
                quarantined.append(r)
                continue
        kept.append(r)
    return kept, quarantined


def main() -> None:
    cfg = json.loads((ROOT / "poc.json").read_text(encoding="utf-8"))
    raw_path = ROOT / cfg["paths"]["raw"]
    records = [json.loads(l) for l in
               raw_path.read_text(encoding="utf-8").split("\n") if l.strip()]
    kept, quarantined = partition_clean(records, cfg["clean_label"])
    if not quarantined:
        print("no contamination found")
        return

    # Keep a backup and a reviewable quarantine of what we pulled from `clean`.
    backup = raw_path.with_suffix(".jsonl.pre-decontam")
    backup.write_text("\n".join(json.dumps(r, ensure_ascii=False)
                               for r in records) + "\n", encoding="utf-8")
    quarantine = raw_path.parent / "clean_quarantine.jsonl"
    quarantine.write_text("\n".join(json.dumps(r, ensure_ascii=False)
                                    for r in quarantined) + "\n", encoding="utf-8")
    raw_path.write_text("\n".join(json.dumps(r, ensure_ascii=False)
                                  for r in kept) + "\n", encoding="utf-8")

    by_cat = Counter(r["contamination"] for r in quarantined)
    print(f"removed {len(quarantined)} contaminated clean rows: {dict(by_cat)}")
    print(f"  backup     -> {backup}")
    print(f"  quarantine -> {quarantine}")


if __name__ == "__main__":
    main()
