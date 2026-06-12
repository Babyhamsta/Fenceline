# Content Classifier — POC Implementation Plan

**Goal:** Build a runnable proof-of-concept that scrapes rendered page text for `games` + `gambling` + `proxy-bypass` + `clean`, trains a tiny FNV-hashed-n-gram linear classifier, and prints a precision / false-positive / size / latency table so we can make a go/no-go call before the full crawl.

**Architecture:** Offline Python pipeline (Playwright render → filter → dedup → eTLD+1 split → train sklearn LogisticRegression on a *self-defined* FNV-1a hashing vectorizer) plus a plain-JS inference path that reads the exported weights and reproduces the Python scores exactly. The self-defined hashing (vs sklearn's `HashingVectorizer`) is what makes Python↔JS parity exact and reuses the repo's existing FNV-1a idiom. The labeled domain universe comes from the existing compiler via a new `--dump-domains` flag (single source of truth for labels).

**Tech Stack:** Node 18+ (existing compiler), Python 3 (`playwright`, `scikit-learn`, `tldextract`, `pytest`), plain JS (on-device inference). Per the repo: no npm deps; Python lives in `.venv/Scripts/` (Git Bash on Windows), executable is `python`.

---

## Scope (POC only)

In: `classifier/` folder, the 3-category + `clean` scrape→train→eval loop, the v1 model (FNV-hashed n-grams + linear), JS-inference parity, and the eval table.
Out (later plans): the other categories, the static-embedding / transformer bake-off candidates, on-device content-script integration, `sync.js` model deployment, managed-policy switch, and the open-source release packaging.

## Conventions

- Python: type hints on signatures, `pathlib` over `os.path`, terse technical comments matching the repo. Tests with `pytest`.
- The shared canonical training record (used by every later model too):
  ```json
  { "etld1": "poki.com", "url": "https://poki.com/", "label": "games",
    "text": "<rendered innerText, normalized>", "title": "...", "meta": "...",
    "structural": { "script_hosts": ["..."], "iframe_count": 3, "has_age_gate": false } }
  ```
- v1 vectorizer config (frozen, identical in Python and JS): lowercase; word tokens `[a-z0-9]+` as 1- and 2-grams; char 3- and 4-grams inside each word; FNV-1a 32-bit hash → `index = h & (DIMS-1)`, `sign = (h >> 31 ? -1 : +1)`; `DIMS = 65536`; accumulate `sign` per token; L2-normalize the vector.

## File structure

```
classifier/
  README.md                 what it is, how to reproduce, open-source scope
  requirements.txt          playwright, scikit-learn, tldextract, pytest
  poc.json                  POC config (categories, per-class target, paths)
  fnv.py                    FNV-1a 32-bit (mirrors extension/lib/hash.js idiom)
  vectorize.py              text -> sparse hashed vector (the frozen config)
  etld.py                   registrable-domain (eTLD+1) helper
  extract.py                build_record(): normalize raw render into the record
  filtering.py              is_usable(): drop dead/parked/thin pages
  dedup.py                  simhash + near-duplicate collapse
  splitting.py              split_by_etld1(): leak-free train/val/test
  metrics.py                precision/recall + fp_rate_on_clean
  domains.py                read compiler dist/domains.tsv -> sampled scrape list
  render.py                 Playwright render -> raw {text,title,meta,structural}
  scrape.py                 orchestrate render over the domain list -> raw.jsonl
  build_dataset.py          filter -> dedup -> split -> balance -> {train,val,test}.jsonl
  train.py                  fit LogisticRegression, save model.npz
  export_model.py           model.npz -> dist/model.bin + dist/model-meta.json
  evaluate.py               load model, score test set, print the table
  learning_curve.py         retrain at 1k/3k/10k, print the curve
  infer.mjs                 plain-JS inference from dist/model.* (parity target)
  tests/
    test_fnv.py  test_vectorize.py  test_etld.py  test_extract.py
    test_filtering.py  test_dedup.py  test_splitting.py  test_metrics.py
    test_parity.mjs         JS scores == Python scores
compiler/compile.mjs        + `--dump-domains` flag (Modify)
```

---

## Task 1: Scaffold the classifier folder

**Files:**
- Create: `classifier/README.md`, `classifier/requirements.txt`, `classifier/poc.json`

- [ ] **Step 1: Create `classifier/requirements.txt`**

```
playwright==1.49.1
scikit-learn==1.5.2
tldextract==5.1.3
pytest==8.3.4
```

- [ ] **Step 2: Create `classifier/poc.json`**

```json
{
  "categories": ["games", "gambling", "proxy-bypass"],
  "clean_label": "clean",
  "per_class_target": 5000,
  "scrape_multiplier": 3,
  "dims": 65536,
  "paths": {
    "domains_tsv": "../dist/domains.tsv",
    "raw": "data/raw.jsonl",
    "train": "data/train.jsonl",
    "val": "data/val.jsonl",
    "test": "data/test.jsonl",
    "model": "data/model.npz",
    "dist": "dist"
  }
}
```

- [ ] **Step 3: Create `classifier/README.md`**

```markdown
# Fenceline content classifier

A tiny on-device classifier that inspects a page's rendered text after it loads
and blocks it if it confidently matches a filtered category the blocklists
missed. Defense in depth — the lists stay primary, this is the async backstop.

See `docs/design/specs/2026-06-11-content-classifier-design.md` for the full
design.

## Open-source scope

We publish the **scraper, training/eval scripts, and the model weights**. We do
**not** publish the scraped dataset itself (it is third-party site content).
Reproduce it by running the scraper against the public blocklist domains:

    node ../compiler/compile.mjs --dump-domains   # writes dist/domains.tsv
    python -m playwright install chromium
    python scrape.py && python build_dataset.py && python train.py

## Reproduce (POC)

    source .venv/Scripts/activate
    pip install -r requirements.txt
    pytest                       # unit tests
    python scrape.py             # render the sampled domains
    python build_dataset.py      # filter, dedup, split
    python train.py              # fit the model
    python export_model.py       # emit dist/model.bin + model-meta.json
    python evaluate.py           # the go/no-go table
    node infer.mjs --selftest    # JS inference parity
```

- [ ] **Step 4: Commit**

```bash
git add classifier/README.md classifier/requirements.txt classifier/poc.json
git commit -m "feat(classifier): scaffold POC folder, config, readme"
```

---

## Task 2: FNV-1a 32-bit (Python, mirrors the repo idiom)

**Files:**
- Create: `classifier/fnv.py`, `classifier/tests/test_fnv.py`

- [ ] **Step 1: Write the failing test — `classifier/tests/test_fnv.py`**

```python
from classifier.fnv import fnv1a32


def test_known_vectors():
    # FNV-1a 32-bit reference values.
    assert fnv1a32("") == 0x811C9DC5
    assert fnv1a32("a") == 0xE40C292C
    assert fnv1a32("foobar") == 0xBF9CF968


def test_is_uint32():
    h = fnv1a32("anything")
    assert 0 <= h <= 0xFFFFFFFF
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd classifier && python -m pytest tests/test_fnv.py -q`
Expected: FAIL — `ModuleNotFoundError: classifier.fnv` (or import error).

- [ ] **Step 3: Implement `classifier/fnv.py`**

```python
"""FNV-1a 32-bit hash — same family as extension/lib/hash.js, used by the
hashing vectorizer so Python and JS produce identical feature indices."""

_OFFSET = 0x811C9DC5
_PRIME = 0x01000193
_MASK = 0xFFFFFFFF


def fnv1a32(s: str) -> int:
    h = _OFFSET
    for byte in s.encode("utf-8"):
        h ^= byte
        h = (h * _PRIME) & _MASK
    return h
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd classifier && python -m pytest tests/test_fnv.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add classifier/fnv.py classifier/tests/test_fnv.py
git commit -m "feat(classifier): FNV-1a 32-bit hash"
```

---

## Task 3: Hashing vectorizer (the frozen v1 config)

**Files:**
- Create: `classifier/vectorize.py`, `classifier/tests/test_vectorize.py`

- [ ] **Step 1: Write the failing test — `classifier/tests/test_vectorize.py`**

```python
import math

from classifier.vectorize import tokens, vectorize, DIMS


def test_tokens_word_and_char_ngrams():
    t = set(tokens("ab cd"))
    # word 1-grams
    assert "ab" in t and "cd" in t
    # word 2-gram
    assert "ab cd" in t
    # char 3-gram inside a word boundary-padded token (^ab$ style)
    assert any(tok.startswith("#") for tok in t)  # char n-grams are prefixed


def test_vector_is_l2_normalized():
    v = vectorize("hello world hello")
    norm = math.sqrt(sum(x * x for x in v.values()))
    assert abs(norm - 1.0) < 1e-9
    assert all(0 <= i < DIMS for i in v)


def test_empty_text_is_empty_vector():
    assert vectorize("") == {}
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd classifier && python -m pytest tests/test_vectorize.py -q`
Expected: FAIL — module/function missing.

- [ ] **Step 3: Implement `classifier/vectorize.py`**

```python
"""Frozen v1 hashing vectorizer. MUST stay byte-identical to infer.mjs.
Config: lowercase; word 1-2 grams; char 3-4 grams within each word (prefixed
'#' and boundary-padded with '^'/'$'); FNV-1a 32-bit -> index & (DIMS-1);
sign from the top bit; L2-normalized term vector."""
import math
import re
from typing import Dict, Iterator, List

from classifier.fnv import fnv1a32

DIMS = 65536  # 2**16
_WORD_RE = re.compile(r"[a-z0-9]+")


def _char_ngrams(word: str) -> Iterator[str]:
    padded = f"^{word}$"
    for n in (3, 4):
        for i in range(len(padded) - n + 1):
            yield "#" + padded[i : i + n]


def tokens(text: str) -> List[str]:
    words = _WORD_RE.findall(text.lower())
    out: List[str] = []
    for i, w in enumerate(words):
        out.append(w)
        if i + 1 < len(words):
            out.append(w + " " + words[i + 1])
        out.extend(_char_ngrams(w))
    return out


def vectorize(text: str) -> Dict[int, float]:
    acc: Dict[int, float] = {}
    for tok in tokens(text):
        h = fnv1a32(tok)
        idx = h & (DIMS - 1)
        sign = -1.0 if (h >> 31) & 1 else 1.0
        acc[idx] = acc.get(idx, 0.0) + sign
    norm = math.sqrt(sum(x * x for x in acc.values()))
    if norm == 0.0:
        return {}
    return {i: x / norm for i, x in acc.items()}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd classifier && python -m pytest tests/test_vectorize.py -q`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add classifier/vectorize.py classifier/tests/test_vectorize.py
git commit -m "feat(classifier): frozen FNV hashing vectorizer"
```

---

## Task 4: eTLD+1 helper

**Files:**
- Create: `classifier/etld.py`, `classifier/tests/test_etld.py`

- [ ] **Step 1: Write the failing test — `classifier/tests/test_etld.py`**

```python
from classifier.etld import etld1


def test_basic():
    assert etld1("https://www.poki.com/en/g") == "poki.com"
    assert etld1("http://sub.deep.example.co.uk/x") == "example.co.uk"
    assert etld1("crazygames.com") == "crazygames.com"


def test_invalid_returns_empty():
    assert etld1("not a url at all") == ""
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd classifier && python -m pytest tests/test_etld.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `classifier/etld.py`**

```python
"""Registrable-domain (eTLD+1) extraction. Used to split train/test so a site's
subdomains never straddle the split (which would inflate accuracy)."""
import tldextract

_extract = tldextract.TLDExtract(suffix_list_urls=())  # offline, bundled snapshot


def etld1(url_or_host: str) -> str:
    ext = _extract(url_or_host)
    if not ext.domain or not ext.suffix:
        return ""
    return f"{ext.domain}.{ext.suffix}"
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd classifier && python -m pytest tests/test_etld.py -q`
Expected: PASS (2 passed). (First run may download the suffix snapshot once.)

- [ ] **Step 5: Commit**

```bash
git add classifier/etld.py classifier/tests/test_etld.py
git commit -m "feat(classifier): eTLD+1 helper"
```

---

## Task 5: Record builder (normalize a raw render)

**Files:**
- Create: `classifier/extract.py`, `classifier/tests/test_extract.py`

- [ ] **Step 1: Write the failing test — `classifier/tests/test_extract.py`**

```python
from classifier.extract import build_record, TEXT_TOKEN_CAP


def test_assembles_and_caps():
    raw = {
        "text": "  Free   ONLINE games  " + "x " * 5000,
        "title": "Poki",
        "meta": "Play free games",
        "structural": {"script_hosts": ["g.poki.com"], "iframe_count": 2,
                       "has_age_gate": False},
    }
    rec = build_record(raw, "https://www.poki.com/en", "games")
    assert rec["label"] == "games"
    assert rec["etld1"] == "poki.com"
    assert rec["title"] == "Poki"
    # text is whitespace-collapsed and token-capped
    assert "  " not in rec["text"]
    assert len(rec["text"].split()) <= TEXT_TOKEN_CAP
    assert rec["structural"]["iframe_count"] == 2


def test_missing_fields_default_safely():
    rec = build_record({"text": "hi"}, "https://x.example", "clean")
    assert rec["title"] == "" and rec["meta"] == ""
    assert rec["structural"] == {"script_hosts": [], "iframe_count": 0,
                                 "has_age_gate": False}
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd classifier && python -m pytest tests/test_extract.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `classifier/extract.py`**

```python
"""Normalize a raw Playwright render into the canonical training record.
Pure function so it is unit-testable and identical offline vs (later) on-device."""
from typing import Dict

from classifier.etld import etld1

TEXT_TOKEN_CAP = 400  # lead tokens kept; short input keeps the model tiny/fast


def _norm_text(text: str) -> str:
    return " ".join(text.split())[: TEXT_TOKEN_CAP * 16]  # char guard


def build_record(raw: Dict, url: str, label: str) -> Dict:
    text = " ".join(_norm_text(raw.get("text", "")).split()[:TEXT_TOKEN_CAP])
    s = raw.get("structural") or {}
    return {
        "etld1": etld1(url),
        "url": url,
        "label": label,
        "text": text,
        "title": (raw.get("title") or "").strip(),
        "meta": (raw.get("meta") or "").strip(),
        "structural": {
            "script_hosts": list(s.get("script_hosts") or []),
            "iframe_count": int(s.get("iframe_count") or 0),
            "has_age_gate": bool(s.get("has_age_gate") or False),
        },
    }
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd classifier && python -m pytest tests/test_extract.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add classifier/extract.py classifier/tests/test_extract.py
git commit -m "feat(classifier): canonical record builder"
```

---

## Task 6: Liveness / park filter

**Files:**
- Create: `classifier/filtering.py`, `classifier/tests/test_filtering.py`

- [ ] **Step 1: Write the failing test — `classifier/tests/test_filtering.py`**

```python
from classifier.filtering import is_usable


def _rec(text, title="t"):
    return {"text": text, "title": title, "meta": "", "label": "games",
            "etld1": "x.com", "url": "https://x.com", "structural": {}}


def test_rejects_thin_text():
    assert not is_usable(_rec("too short"))


def test_rejects_parked_fingerprint():
    assert not is_usable(_rec("this domain is for sale buy this domain now "
                              "parked free " * 5))


def test_accepts_real_page():
    assert is_usable(_rec("play hundreds of free online games puzzles racing "
                          "shooting arcade multiplayer fun for everyone " * 4))
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd classifier && python -m pytest tests/test_filtering.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `classifier/filtering.py`**

```python
"""Drop pages that would poison training: dead/thin shells and parked domains.
Also doubles as a blocklist liveness audit downstream."""
from typing import Dict

MIN_TOKENS = 20
_PARK_MARKERS = (
    "domain is for sale", "buy this domain", "this domain is parked",
    "domain parking", "is for sale", "purchase this domain",
    "godaddy", "sedo", "hugedomains",
)


def is_usable(record: Dict) -> bool:
    text = (record.get("text") or "").lower()
    if len(text.split()) < MIN_TOKENS:
        return False
    if any(m in text for m in _PARK_MARKERS):
        return False
    return True
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd classifier && python -m pytest tests/test_filtering.py -q`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add classifier/filtering.py classifier/tests/test_filtering.py
git commit -m "feat(classifier): liveness/park filter"
```

---

## Task 7: Simhash near-duplicate dedup

**Files:**
- Create: `classifier/dedup.py`, `classifier/tests/test_dedup.py`

- [ ] **Step 1: Write the failing test — `classifier/tests/test_dedup.py`**

```python
from classifier.dedup import simhash, hamming, dedup


def test_identical_text_same_hash():
    assert simhash("free online games play now") == simhash("free online games play now")


def test_near_duplicate_low_distance():
    a = simhash("play free online games puzzles racing arcade fun")
    b = simhash("play free online games puzzles racing arcade fun today")
    assert hamming(a, b) <= 6


def test_dedup_collapses_template_farm():
    base = "play free online games puzzles racing arcade multiplayer fun"
    recs = [{"text": base + f" mirror {i}", "etld1": f"site{i}.com"} for i in range(5)]
    recs.append({"text": "online casino real money blackjack roulette slots bet",
                 "etld1": "casino.com"})
    kept = dedup(recs, max_distance=4)
    # the 5 near-identical game mirrors collapse to 1; casino stays
    assert len(kept) == 2
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd classifier && python -m pytest tests/test_dedup.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `classifier/dedup.py`**

```python
"""64-bit simhash over word tokens + Hamming-distance near-duplicate collapse.
Template/affiliate farms render near-identical pages across thousands of
domains; without this the model trains on the same page thousands of times."""
import re
from typing import Dict, List

from classifier.fnv import fnv1a32

_WORD_RE = re.compile(r"[a-z0-9]+")
_BITS = 64


def simhash(text: str) -> int:
    v = [0] * _BITS
    for tok in _WORD_RE.findall(text.lower()):
        # widen the 32-bit FNV to 64 by hashing the token and its reverse
        h = (fnv1a32(tok) << 32) | fnv1a32(tok[::-1])
        for b in range(_BITS):
            v[b] += 1 if (h >> b) & 1 else -1
    out = 0
    for b in range(_BITS):
        if v[b] > 0:
            out |= 1 << b
    return out


def hamming(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


def dedup(records: List[Dict], max_distance: int = 4) -> List[Dict]:
    kept: List[Dict] = []
    seen: List[int] = []
    for rec in records:
        h = simhash(rec.get("text", ""))
        if any(hamming(h, s) <= max_distance for s in seen):
            continue
        seen.append(h)
        kept.append(rec)
    return kept
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd classifier && python -m pytest tests/test_dedup.py -q`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add classifier/dedup.py classifier/tests/test_dedup.py
git commit -m "feat(classifier): simhash near-duplicate dedup"
```

---

## Task 8: Leak-free eTLD+1 split

**Files:**
- Create: `classifier/splitting.py`, `classifier/tests/test_splitting.py`

- [ ] **Step 1: Write the failing test — `classifier/tests/test_splitting.py`**

```python
from classifier.splitting import split_by_etld1


def test_no_etld1_leak_across_splits():
    recs = [{"etld1": f"site{i}.com", "label": "games"} for i in range(100)]
    # add subdomains that share an eTLD+1 with an existing record
    recs += [{"etld1": "site1.com", "label": "games"} for _ in range(5)]
    train, val, test = split_by_etld1(recs, (0.7, 0.15, 0.15), seed=1)
    sets = [{r["etld1"] for r in s} for s in (train, val, test)]
    assert sets[0].isdisjoint(sets[1])
    assert sets[0].isdisjoint(sets[2])
    assert sets[1].isdisjoint(sets[2])
    assert len(train) + len(val) + len(test) == len(recs)


def test_deterministic_with_seed():
    recs = [{"etld1": f"s{i}.com", "label": "x"} for i in range(50)]
    a = split_by_etld1(recs, (0.7, 0.15, 0.15), seed=7)
    b = split_by_etld1(recs, (0.7, 0.15, 0.15), seed=7)
    assert [r["etld1"] for r in a[0]] == [r["etld1"] for r in b[0]]
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd classifier && python -m pytest tests/test_splitting.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `classifier/splitting.py`**

```python
"""Split records into train/val/test by registrable domain, so every record
sharing an eTLD+1 lands in exactly one split. Deterministic given a seed."""
import random
from typing import Dict, List, Tuple


def split_by_etld1(
    records: List[Dict], ratios: Tuple[float, float, float], seed: int = 0
) -> Tuple[List[Dict], List[Dict], List[Dict]]:
    by_domain: Dict[str, List[Dict]] = {}
    for r in records:
        by_domain.setdefault(r["etld1"], []).append(r)
    domains = sorted(by_domain)
    random.Random(seed).shuffle(domains)

    n = len(domains)
    n_train = int(n * ratios[0])
    n_val = int(n * ratios[1])
    buckets = (domains[:n_train], domains[n_train : n_train + n_val],
               domains[n_train + n_val :])
    out: List[List[Dict]] = []
    for bucket in buckets:
        rows: List[Dict] = []
        for d in bucket:
            rows.extend(by_domain[d])
        out.append(rows)
    return out[0], out[1], out[2]
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd classifier && python -m pytest tests/test_splitting.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add classifier/splitting.py classifier/tests/test_splitting.py
git commit -m "feat(classifier): leak-free eTLD+1 split"
```

---

## Task 9: Metrics (precision/recall + FP-on-clean)

**Files:**
- Create: `classifier/metrics.py`, `classifier/tests/test_metrics.py`

- [ ] **Step 1: Write the failing test — `classifier/tests/test_metrics.py`**

```python
from classifier.metrics import per_class, fp_rate_on_clean


def test_per_class_precision_recall():
    y_true = ["games", "games", "clean", "gambling"]
    y_pred = ["games", "clean", "clean", "gambling"]
    pc = per_class(y_true, y_pred, ["games", "gambling", "clean"])
    assert pc["games"]["precision"] == 1.0          # 1 predicted games, correct
    assert pc["games"]["recall"] == 0.5             # 2 true games, 1 found
    assert pc["gambling"]["recall"] == 1.0


def test_fp_rate_on_clean():
    # 4 clean items; 1 wrongly flagged as a blocked category
    y_true = ["clean", "clean", "clean", "clean"]
    y_pred = ["clean", "games", "clean", "clean"]
    assert fp_rate_on_clean(y_true, y_pred, "clean") == 0.25
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd classifier && python -m pytest tests/test_metrics.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `classifier/metrics.py`**

```python
"""Eval metrics. fp_rate_on_clean is the number that governs shippability:
how often a legitimate (clean) page gets flagged as a blocked category."""
from typing import Dict, List


def per_class(y_true: List[str], y_pred: List[str], labels: List[str]) -> Dict:
    out: Dict[str, Dict[str, float]] = {}
    for lab in labels:
        tp = sum(1 for t, p in zip(y_true, y_pred) if p == lab and t == lab)
        fp = sum(1 for t, p in zip(y_true, y_pred) if p == lab and t != lab)
        fn = sum(1 for t, p in zip(y_true, y_pred) if p != lab and t == lab)
        prec = tp / (tp + fp) if (tp + fp) else 0.0
        rec = tp / (tp + fn) if (tp + fn) else 0.0
        out[lab] = {"precision": prec, "recall": rec, "support": tp + fn}
    return out


def fp_rate_on_clean(y_true: List[str], y_pred: List[str], clean_label: str) -> float:
    clean = [(t, p) for t, p in zip(y_true, y_pred) if t == clean_label]
    if not clean:
        return 0.0
    flagged = sum(1 for _t, p in clean if p != clean_label)
    return flagged / len(clean)
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd classifier && python -m pytest tests/test_metrics.py -q`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add classifier/metrics.py classifier/tests/test_metrics.py
git commit -m "feat(classifier): eval metrics incl fp-on-clean"
```

---

## Task 10: Compiler `--dump-domains` (label source of truth)

**Files:**
- Modify: `compiler/compile.mjs` (add a `--dump-domains` early-exit path)

- [ ] **Step 1: Add the flag handler near the top of `main()` in `compiler/compile.mjs`**

Find the start of `async function main() {` and insert, as the first statements inside it:

```javascript
  if (process.argv.includes("--dump-domains")) {
    await dumpDomains();
    return;
  }
```

- [ ] **Step 2: Add the `dumpDomains` function above `main()` in `compiler/compile.mjs`**

```javascript
// Emit dist/domains.tsv ("<domain>\t<label>") for the content classifier.
// Reuses the same fetch/normalize path as the build so labels are consistent.
// "clean" = Tranco-ranked domains that are NOT in any blocked category.
async function dumpDomains() {
  const domainCat = new Map();
  for (let ci = 0; ci < SRC.categories.length; ci++) {
    const cat = SRC.categories[ci];
    for (const src of cat.sources) {
      const { buf } = await fetchSource(src);
      if (!buf) continue;
      const found = [];
      if (src.format === "ut1") parseUt1TarGz(buf, found);
      else parsePlain(buf.toString("utf8"), found);
      for (const d of found) if (!domainCat.has(d)) domainCat.set(d, cat.name);
    }
  }
  const lines = [];
  for (const [d, label] of domainCat) lines.push(`${d}\t${label}`);
  const ranks = loadTrancoRanks();
  if (ranks) {
    let cleanCount = 0;
    for (const d of ranks.keys()) {
      if (cleanCount >= 50000) break;
      if (!domainCat.has(d)) {
        lines.push(`${d}\tclean`);
        cleanCount++;
      }
    }
  }
  mkdirSync(DIST, { recursive: true });
  writeFileSync(join(DIST, "domains.tsv"), lines.join("\n") + "\n");
  console.log(`Wrote dist/domains.tsv: ${lines.length.toLocaleString()} rows`);
}
```

- [ ] **Step 3: Verify it runs (smoke)**

Run: `node compiler/compile.mjs --dump-domains 2>&1 | tail -2 && head -3 dist/domains.tsv`
Expected: prints "Wrote dist/domains.tsv: N rows" and the first lines look like `somedomain.com<TAB>games`. (Downloads upstream lists; takes a few minutes. Without `data/tranco.csv` there will simply be no `clean` rows — fine for now.)

- [ ] **Step 4: Confirm existing tests still pass**

Run: `node test/selftest.mjs >/dev/null 2>&1 && echo OK ; rm -rf test/.tmp`
Expected: `OK` (the flag path doesn't touch the normal build).

- [ ] **Step 5: Commit**

```bash
git add compiler/compile.mjs
git commit -m "feat(compiler): --dump-domains for classifier labels"
```

---

## Task 11: Domain sampler

**Files:**
- Create: `classifier/domains.py`, `classifier/tests/test_domains.py`

- [ ] **Step 1: Write the failing test — `classifier/tests/test_domains.py`**

```python
from classifier.domains import sample_domains


def test_filters_to_requested_labels_and_caps(tmp_path):
    tsv = tmp_path / "domains.tsv"
    rows = ["a.com\tgames", "b.com\tgames", "c.com\tgambling",
            "d.com\tadult", "e.com\tclean", "f.com\tclean"]
    tsv.write_text("\n".join(rows) + "\n", encoding="utf-8")
    out = sample_domains(tsv, ["games", "gambling"], "clean",
                         per_class=1, seed=0)
    labels = sorted({lab for _d, lab in out})
    assert labels == ["clean", "gambling", "games"]   # adult excluded
    # capped at per_class each
    assert sum(1 for _d, lab in out if lab == "games") == 1
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd classifier && python -m pytest tests/test_domains.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `classifier/domains.py`**

```python
"""Read the compiler's dist/domains.tsv and sample a capped, per-label list of
domains to scrape for the POC."""
import random
from pathlib import Path
from typing import Dict, List, Tuple


def sample_domains(
    tsv_path: Path, categories: List[str], clean_label: str,
    per_class: int, seed: int = 0,
) -> List[Tuple[str, str]]:
    wanted = set(categories) | {clean_label}
    buckets: Dict[str, List[str]] = {lab: [] for lab in wanted}
    for line in Path(tsv_path).read_text(encoding="utf-8").splitlines():
        if "\t" not in line:
            continue
        domain, label = line.split("\t", 1)
        if label in wanted:
            buckets[label].append(domain)
    rng = random.Random(seed)
    out: List[Tuple[str, str]] = []
    for label, domains in buckets.items():
        rng.shuffle(domains)
        out.extend((d, label) for d in domains[:per_class])
    return out
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd classifier && python -m pytest tests/test_domains.py -q`
Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
git add classifier/domains.py classifier/tests/test_domains.py
git commit -m "feat(classifier): per-label domain sampler"
```

---

## Task 12: Playwright renderer + scrape orchestrator

**Files:**
- Create: `classifier/render.py`, `classifier/scrape.py`

- [ ] **Step 1: Implement `classifier/render.py`**

```python
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
```

- [ ] **Step 2: Implement `classifier/scrape.py`**

```python
"""Render every sampled domain and append canonical records to raw.jsonl.
Skips dead/unreachable domains. Resumable: skips URLs already in the output."""
import json
from pathlib import Path

from classifier.domains import sample_domains
from classifier.extract import build_record
from classifier.render import render

ROOT = Path(__file__).resolve().parent
CFG = json.loads((ROOT / "poc.json").read_text(encoding="utf-8"))


def main() -> None:
    tsv = ROOT / CFG["paths"]["domains_tsv"]
    out_path = ROOT / CFG["paths"]["raw"]
    out_path.parent.mkdir(parents=True, exist_ok=True)

    done = set()
    if out_path.exists():
        for line in out_path.read_text(encoding="utf-8").splitlines():
            try:
                done.add(json.loads(line)["url"])
            except Exception:
                pass

    targets = sample_domains(tsv, CFG["categories"], CFG["clean_label"],
                             CFG["per_class_target"] * CFG["scrape_multiplier"])
    with out_path.open("a", encoding="utf-8") as fh:
        for i, (domain, label) in enumerate(targets, 1):
            url = f"https://{domain}/"
            if url in done:
                continue
            raw = render(url)
            if raw is None:
                continue
            rec = build_record(raw, url, label)
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            if i % 100 == 0:
                print(f"  {i}/{len(targets)} rendered")
    print(f"raw -> {out_path}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Install the browser and smoke-test one render**

Run:
```bash
cd classifier && python -m playwright install chromium
python -c "from classifier.render import render; r=render('https://example.com/'); print(bool(r) and 'example' in (r['text'].lower()+r['title'].lower()))"
```
Expected: `True` (example.com renders and yields text).

- [ ] **Step 4: Commit**

```bash
git add classifier/render.py classifier/scrape.py
git commit -m "feat(classifier): playwright renderer + scrape orchestrator"
```

---

## Task 13: Dataset builder (filter → dedup → split → balance)

**Files:**
- Create: `classifier/build_dataset.py`, `classifier/tests/test_build_dataset.py`

- [ ] **Step 1: Write the failing test — `classifier/tests/test_build_dataset.py`**

```python
import json
from pathlib import Path

from classifier.build_dataset import prepare


def test_prepare_filters_dedups_and_splits(tmp_path):
    recs = []
    # 12 distinct usable games pages
    for i in range(12):
        recs.append({"etld1": f"g{i}.com", "url": f"https://g{i}.com", "label": "games",
                     "text": f"play free online games arcade racing puzzle number {i} " * 3,
                     "title": "g", "meta": "", "structural": {}})
    # a thin page (filtered out) and a near-dup of g0 (deduped)
    recs.append({"etld1": "thin.com", "url": "https://thin.com", "label": "games",
                 "text": "hi", "title": "", "meta": "", "structural": {}})
    recs.append({"etld1": "dup.com", "url": "https://dup.com", "label": "games",
                 "text": "play free online games arcade racing puzzle number 0 " * 3,
                 "title": "g", "meta": "", "structural": {}})
    raw = tmp_path / "raw.jsonl"
    raw.write_text("\n".join(json.dumps(r) for r in recs) + "\n", encoding="utf-8")

    train, val, test = prepare(raw, ratios=(0.7, 0.15, 0.15), seed=0)
    kept = train + val + test
    assert all(len(r["text"].split()) >= 20 for r in kept)   # thin removed
    assert len(kept) == 12                                    # dup removed
    etlds = [{r["etld1"] for r in s} for s in (train, val, test)]
    assert etlds[0].isdisjoint(etlds[2])                      # no leak
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd classifier && python -m pytest tests/test_build_dataset.py -q`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `classifier/build_dataset.py`**

```python
"""filter -> dedup -> eTLD+1 split. Writes train/val/test JSONL when run as a
script; `prepare()` is the unit-testable core."""
import json
from pathlib import Path
from typing import Dict, List, Tuple

from classifier.dedup import dedup
from classifier.filtering import is_usable
from classifier.splitting import split_by_etld1

ROOT = Path(__file__).resolve().parent


def prepare(raw_path: Path, ratios: Tuple[float, float, float], seed: int
            ) -> Tuple[List[Dict], List[Dict], List[Dict]]:
    records: List[Dict] = []
    for line in Path(raw_path).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        records.append(json.loads(line))
    records = [r for r in records if is_usable(r)]
    # dedup within each label so cross-category near-collisions are kept
    by_label: Dict[str, List[Dict]] = {}
    for r in records:
        by_label.setdefault(r["label"], []).append(r)
    deduped: List[Dict] = []
    for rows in by_label.values():
        deduped.extend(dedup(rows, max_distance=4))
    return split_by_etld1(deduped, ratios, seed)


def main() -> None:
    cfg = json.loads((ROOT / "poc.json").read_text(encoding="utf-8"))
    paths = cfg["paths"]
    train, val, test = prepare(ROOT / paths["raw"], (0.7, 0.15, 0.15), seed=0)
    for name, rows in (("train", train), ("val", val), ("test", test)):
        out = ROOT / paths[name]
        out.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows)
                       + "\n", encoding="utf-8")
        print(f"{name}: {len(rows)} rows -> {out}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd classifier && python -m pytest tests/test_build_dataset.py -q`
Expected: PASS (1 passed).

- [ ] **Step 5: Commit**

```bash
git add classifier/build_dataset.py classifier/tests/test_build_dataset.py
git commit -m "feat(classifier): dataset builder (filter/dedup/split)"
```

---

## Task 14: Train + export the model

**Files:**
- Create: `classifier/train.py`, `classifier/export_model.py`

- [ ] **Step 1: Implement `classifier/train.py`**

```python
"""Fit a multinomial LogisticRegression over the frozen FNV hashing vectorizer.
Concatenates title+meta+text (title/meta are high-signal) before vectorizing.
Saves coef/intercept/classes to model.npz."""
import json
from pathlib import Path
from typing import List, Tuple

import numpy as np
from scipy.sparse import csr_matrix
from sklearn.linear_model import LogisticRegression

from classifier.vectorize import DIMS, vectorize

ROOT = Path(__file__).resolve().parent


def _doc(rec: dict) -> str:
    return f"{rec.get('title','')} {rec.get('meta','')} {rec.get('text','')}"


def _matrix(records: List[dict]) -> Tuple[csr_matrix, List[str]]:
    rows, cols, data, labels = [], [], [], []
    for i, rec in enumerate(records):
        for idx, val in vectorize(_doc(rec)).items():
            rows.append(i); cols.append(idx); data.append(val)
        labels.append(rec["label"])
    X = csr_matrix((data, (rows, cols)), shape=(len(records), DIMS))
    return X, labels


def main() -> None:
    cfg = json.loads((ROOT / "poc.json").read_text(encoding="utf-8"))
    train = [json.loads(l) for l in
             (ROOT / cfg["paths"]["train"]).read_text(encoding="utf-8").splitlines() if l.strip()]
    X, y = _matrix(train)
    clf = LogisticRegression(max_iter=1000, class_weight="balanced", C=1.0)
    clf.fit(X, y)
    np.savez(ROOT / cfg["paths"]["model"], coef=clf.coef_.astype(np.float32),
             intercept=clf.intercept_.astype(np.float32),
             classes=np.array(clf.classes_))
    print(f"trained on {len(train)} docs, classes={list(clf.classes_)}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Implement `classifier/export_model.py`**

```python
"""Export model.npz to the shippable artifact the JS path reads:
  dist/model.bin        float32 coef, row-major [n_classes x DIMS]
  dist/model-meta.json  classes, dims, intercepts, vectorizer id, version hash"""
import hashlib
import json
from pathlib import Path

import numpy as np

from classifier.vectorize import DIMS

ROOT = Path(__file__).resolve().parent


def main() -> None:
    cfg = json.loads((ROOT / "poc.json").read_text(encoding="utf-8"))
    data = np.load(ROOT / cfg["paths"]["model"], allow_pickle=True)
    coef = data["coef"].astype(np.float32)
    dist = ROOT / cfg["paths"]["dist"]
    dist.mkdir(parents=True, exist_ok=True)
    blob = coef.tobytes()
    (dist / "model.bin").write_bytes(blob)
    version = hashlib.sha256(blob).hexdigest()[:16]
    meta = {
        "version": version,
        "vectorizer": "fnv-hash-v1",
        "dims": DIMS,
        "classes": [str(c) for c in data["classes"]],
        "intercept": [float(x) for x in data["intercept"]],
    }
    (dist / "model-meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"exported model.bin ({len(blob)} bytes), version {version}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Smoke-test train+export on a tiny synthetic set**

Run:
```bash
cd classifier && python - <<'PY'
import json, pathlib
recs=[]
for i in range(30):
    recs.append({"etld1":f"g{i}.com","url":f"https://g{i}.com","label":"games",
                 "text":"play free online games arcade racing puzzle "+str(i),"title":"games","meta":""})
    recs.append({"etld1":f"c{i}.com","url":f"https://c{i}.com","label":"clean",
                 "text":"weather news recipes encyclopedia article "+str(i),"title":"news","meta":""})
p=pathlib.Path("data"); p.mkdir(exist_ok=True)
(p/"train.jsonl").write_text("\n".join(json.dumps(r) for r in recs),encoding="utf-8")
PY
python train.py && python export_model.py && cat dist/model-meta.json
```
Expected: "trained on 60 docs", then "exported model.bin", and a meta JSON with `classes` `["clean","games"]` and a `version`.

- [ ] **Step 4: Commit**

```bash
git add classifier/train.py classifier/export_model.py
git commit -m "feat(classifier): train + export linear model"
```

---

## Task 15: JS inference + Python↔JS parity

**Files:**
- Create: `classifier/infer.mjs`, `classifier/tests/test_parity.mjs`

- [ ] **Step 1: Write the failing parity test — `classifier/tests/test_parity.mjs`**

```javascript
// Parity: the JS scorer must match the Python scorer on the same input.
// Run: node classifier/tests/test_parity.mjs
import { classify } from "../infer.mjs";
import { execFileSync } from "node:child_process";

const text = "play free online games arcade racing puzzle multiplayer";
const js = classify(text);

const py = JSON.parse(execFileSync("python", ["-c", `
import json
from classifier.infer_ref import classify_ref
print(json.dumps(classify_ref(${JSON.stringify(text)})))
`], { cwd: "..", encoding: "utf8" }));

let fail = 0;
function close(a, b, msg) {
  if (Math.abs(a - b) < 1e-5) console.log("  ok    " + msg);
  else { console.error(`  FAIL  ${msg} js=${a} py=${b}`); fail++; }
}
close(js.scores[js.label], py.scores[py.label], "top score matches");
if (js.label !== py.label) { console.error("  FAIL  label mismatch"); fail++; }
else console.log("  ok    label matches: " + js.label);
console.log(fail ? `\n${fail} FAILURE(S)` : "\nAll checks passed.");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Implement the Python reference scorer — `classifier/infer_ref.py`**

```python
"""Python reference scorer over the exported artifact — exists only so the JS
parity test has something to compare against (same math as infer.mjs)."""
import json
import math
from pathlib import Path

import numpy as np

from classifier.vectorize import vectorize

ROOT = Path(__file__).resolve().parent


def classify_ref(text: str) -> dict:
    meta = json.loads((ROOT / "dist" / "model-meta.json").read_text(encoding="utf-8"))
    classes = meta["classes"]
    dims = meta["dims"]
    intercept = meta["intercept"]
    coef = np.frombuffer((ROOT / "dist" / "model.bin").read_bytes(),
                         dtype=np.float32).reshape(len(classes), dims)
    vec = vectorize(text)
    logits = []
    for ci in range(len(classes)):
        s = intercept[ci] + sum(v * float(coef[ci, idx]) for idx, v in vec.items())
        logits.append(s)
    m = max(logits)
    exps = [math.exp(x - m) for x in logits]
    z = sum(exps)
    scores = {classes[i]: exps[i] / z for i in range(len(classes))}
    label = max(scores, key=scores.get)
    return {"label": label, "scores": scores}
```

- [ ] **Step 3: Implement `classifier/infer.mjs`**

```javascript
// Plain-JS inference from dist/model.bin + model-meta.json. MUST match
// classifier/vectorize.py and infer_ref.py exactly. This is the on-device path.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const META = JSON.parse(readFileSync(join(ROOT, "dist", "model-meta.json"), "utf8"));
const COEF = new Float32Array(
  readFileSync(join(ROOT, "dist", "model.bin")).buffer
);

function fnv1a32(s) {
  let h = 0x811c9dc5;
  const bytes = new TextEncoder().encode(s);
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function* charNgrams(word) {
  const padded = "^" + word + "$";
  for (const n of [3, 4])
    for (let i = 0; i + n <= padded.length; i++) yield "#" + padded.slice(i, i + n);
}

function tokens(text) {
  const words = (text.toLowerCase().match(/[a-z0-9]+/g)) || [];
  const out = [];
  for (let i = 0; i < words.length; i++) {
    out.push(words[i]);
    if (i + 1 < words.length) out.push(words[i] + " " + words[i + 1]);
    for (const g of charNgrams(words[i])) out.push(g);
  }
  return out;
}

function vectorize(text) {
  const acc = new Map();
  for (const tok of tokens(text)) {
    const h = fnv1a32(tok);
    const idx = h & (META.dims - 1);
    const sign = (h >>> 31) & 1 ? -1 : 1;
    acc.set(idx, (acc.get(idx) || 0) + sign);
  }
  let norm = 0;
  for (const v of acc.values()) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return acc;
  for (const [k, v] of acc) acc.set(k, v / norm);
  return acc;
}

export function classify(text) {
  const C = META.classes.length;
  const vec = vectorize(text);
  const logits = META.intercept.slice();
  for (let ci = 0; ci < C; ci++) {
    const base = ci * META.dims;
    let s = logits[ci];
    for (const [idx, v] of vec) s += v * COEF[base + idx];
    logits[ci] = s;
  }
  const m = Math.max(...logits);
  const exps = logits.map((x) => Math.exp(x - m));
  const z = exps.reduce((a, b) => a + b, 0);
  const scores = {};
  META.classes.forEach((c, i) => (scores[c] = exps[i] / z));
  const label = META.classes[logits.indexOf(Math.max(...logits))];
  return { label, scores };
}

if (process.argv.includes("--selftest")) {
  console.log(classify("play free online games arcade racing puzzle"));
}
```

- [ ] **Step 4: Run the parity test — expect PASS**

Run: `cd classifier && node tests/test_parity.mjs`
Expected: ends with `All checks passed.` (uses the tiny synthetic model from Task 14 Step 3; if `dist/` was cleared, re-run that smoke-train first).

- [ ] **Step 5: Commit**

```bash
git add classifier/infer.mjs classifier/infer_ref.py classifier/tests/test_parity.mjs
git commit -m "feat(classifier): JS inference + python parity"
```

---

## Task 16: Eval table + learning curve

**Files:**
- Create: `classifier/evaluate.py`, `classifier/learning_curve.py`

- [ ] **Step 1: Implement `classifier/evaluate.py`**

```python
"""Score the held-out test set with the trained model and print the go/no-go
table: per-class precision/recall, the clean false-positive rate, model size,
and Python inference latency (a proxy; on-device JS latency is measured later)."""
import json
import time
from pathlib import Path

import numpy as np

from classifier.metrics import fp_rate_on_clean, per_class
from classifier.vectorize import DIMS, vectorize

ROOT = Path(__file__).resolve().parent


def _doc(rec): return f"{rec.get('title','')} {rec.get('meta','')} {rec.get('text','')}"


def main() -> None:
    cfg = json.loads((ROOT / "poc.json").read_text(encoding="utf-8"))
    meta = json.loads((ROOT / cfg["paths"]["dist"] / "model-meta.json").read_text("utf-8"))
    classes = meta["classes"]
    coef = np.frombuffer((ROOT / cfg["paths"]["dist"] / "model.bin").read_bytes(),
                         dtype=np.float32).reshape(len(classes), DIMS)
    intercept = np.array(meta["intercept"], dtype=np.float32)

    test = [json.loads(l) for l in
            (ROOT / cfg["paths"]["test"]).read_text("utf-8").splitlines() if l.strip()]
    y_true, y_pred, t0 = [], [], time.perf_counter()
    for rec in test:
        vec = vectorize(_doc(rec))
        logits = intercept.copy()
        for idx, v in vec.items():
            logits += v * coef[:, idx]
        y_pred.append(classes[int(np.argmax(logits))])
        y_true.append(rec["label"])
    dt = (time.perf_counter() - t0) / max(1, len(test)) * 1000

    pc = per_class(y_true, y_pred, classes)
    print(f"\n{'category':<14}{'precision':>10}{'recall':>9}{'support':>9}")
    for lab in classes:
        print(f"{lab:<14}{pc[lab]['precision']:>10.3f}{pc[lab]['recall']:>9.3f}"
              f"{pc[lab]['support']:>9}")
    size_mb = (ROOT / cfg["paths"]["dist"] / "model.bin").stat().st_size / 1e6
    print(f"\nclean FP-rate:        {fp_rate_on_clean(y_true, y_pred, cfg['clean_label']):.3f}")
    print(f"model size:           {size_mb:.2f} MB")
    print(f"py inference latency:  {dt:.2f} ms/doc (proxy)")
    print(f"test docs:            {len(test)}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Implement `classifier/learning_curve.py`**

```python
"""Retrain on increasing slices and print macro-precision so we can see where it
plateaus — the 'how much data is enough' signal."""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main() -> None:
    cfg = json.loads((ROOT / "poc.json").read_text(encoding="utf-8"))
    full = (ROOT / cfg["paths"]["train"]).read_text("utf-8").splitlines()
    train_path = ROOT / cfg["paths"]["train"]
    backup = full[:]
    try:
        for n in (1000, 3000, 10000):
            train_path.write_text("\n".join(full[:n]) + "\n", encoding="utf-8")
            subprocess.run([sys.executable, "train.py"], cwd=ROOT, check=True)
            subprocess.run([sys.executable, "export_model.py"], cwd=ROOT, check=True)
            print(f"\n=== n={n} ===")
            subprocess.run([sys.executable, "evaluate.py"], cwd=ROOT, check=True)
    finally:
        train_path.write_text("\n".join(backup) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Smoke-test evaluate on the synthetic model**

Run: `cd classifier && python build_dataset.py 2>/dev/null; python evaluate.py || echo "needs real data"`
Expected: either a printed table, or the "needs real data" note if `data/test.jsonl` isn't populated yet — both acceptable; the real run happens in Task 17.

- [ ] **Step 4: Commit**

```bash
git add classifier/evaluate.py classifier/learning_curve.py
git commit -m "feat(classifier): eval table + learning curve"
```

---

## Task 17: Full POC run + go/no-go

**Files:** none (operational)

- [ ] **Step 1: Generate the label universe**

Run: `node compiler/compile.mjs --dump-domains`
Expected: `dist/domains.tsv` exists with `games`/`gambling`/`proxy-bypass` rows (and `clean` rows if `data/tranco.csv` is present — optional for the POC).

- [ ] **Step 2: Scrape (long-running)**

Run: `cd classifier && python scrape.py`
Expected: `data/raw.jsonl` grows; progress every 100 renders. Resumable if interrupted.

- [ ] **Step 3: Build, train, export**

Run: `cd classifier && python build_dataset.py && python train.py && python export_model.py`
Expected: train/val/test JSONL written; "trained on N docs"; "exported model.bin".

- [ ] **Step 4: Read the go/no-go table**

Run: `cd classifier && python evaluate.py && python learning_curve.py`
Expected: per-class precision/recall, **clean FP-rate**, model size, latency, and the learning curve across 1k/3k/10k.

- [ ] **Step 5: Verify JS parity on the real model**

Run: `cd classifier && node tests/test_parity.mjs`
Expected: `All checks passed.` (JS on-device path matches Python on the real weights).

- [ ] **Step 6: Record the verdict**

Append a short results note to `classifier/README.md` (the table + a go/no-go call: does clean FP-rate clear bar at a usable precision, and is the model small/fast enough). Commit:

```bash
git add classifier/README.md
git commit -m "docs(classifier): POC results + go/no-go"
```

---

## Self-review

**Spec coverage:** scrape→filter→dedup→split→balance (T12,13), model bake-off candidate #1 + JS path + parity (T2,3,14,15), eval incl FP-on-clean + learning curve (T9,16,17), labels from the compiler (T10), guardrails — sub-resource block + no raw/media storage (T12 render.py), malware excluded (POC categories exclude it). Later-phase items (other bake-off models, on-device content-script integration, `sync.js` deploy, managed-policy switch, open-source packaging) are explicitly out of POC scope and deferred to follow-on plans.

**Placeholders:** none — every code step is complete.

**Type/name consistency:** `vectorize()`/`DIMS`/`fnv1a32` shared across vectorize/train/eval/infer; `build_record` shape matches `prepare`/`is_usable`/`split_by_etld1` consumers; `classes`/`dims`/`intercept` keys consistent across export_model, infer_ref, infer.mjs, evaluate; `sample_domains`/`prepare`/`classify` signatures stable across tasks.
