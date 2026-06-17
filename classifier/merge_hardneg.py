"""Inject hard-negative records into the TRAIN split only, idempotently.

Always rebuilds train from the pristine pre-hardneg backup, so re-running with a
larger hardneg set never double-injects. val/test stay untouched (pristine raw_v3)
so the held-out recall comparison is apples-to-apples and the live suite remains
the hard-negative measure. Records whose eTLD+1 already appears in val/test are
dropped (no train/test leak); near-duplicate hard negatives are collapsed.

Run: python -m classifier.merge_hardneg
"""

import collections
import json
from pathlib import Path

from classifier.dedup import dedup

ROOT = Path(__file__).resolve().parent
D = ROOT / "data"


def _load(p: Path):
    return [json.loads(l) for l in p.read_text(encoding="utf-8").split("\n") if l.strip()]


def main() -> None:
    backup = D / "train.jsonl.pre-hardneg"
    if not backup.exists():
        backup.write_text((D / "train.jsonl").read_text(encoding="utf-8"), encoding="utf-8")
        print("created pristine backup train.jsonl.pre-hardneg")

    train = _load(backup)  # always start from pristine
    val, test = _load(D / "val.jsonl"), _load(D / "test.jsonl")
    heldout = {r["etld1"] for r in val + test}

    # Clean hard negatives + extra BLOCK positives (VPN vendors->proxy-bypass,
    # game portals/edu-games->games), each carrying its own label. Both go into
    # train only; val/test stay pristine raw_v3.
    # Clean hard negatives (hardneg*.jsonl) + BLOCK positives (block_extra*.jsonl),
    # each record carrying its own label.
    extra = []
    for p in sorted(D.glob("hardneg*.jsonl")):
        extra += _load(p)
    for p in sorted(D.glob("block_extra*.jsonl")):
        extra += _load(p)

    before = len(extra)
    extra = [r for r in extra if r["etld1"] not in heldout]
    dropped = before - len(extra)
    extra = dedup(extra, max_distance=4)

    out = train + extra
    (D / "train.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in out) + "\n", encoding="utf-8"
    )
    by_label = collections.Counter(r["label"] for r in extra)
    print(f"extra: {before} -> dropped {dropped} (val/test leak) -> deduped to {len(extra)}")
    print(f"  injected by label: {dict(by_label)}")
    print(
        f"train: {len(train)} + {len(extra)} = {len(out)}  (val/test pristine: {len(val)}/{len(test)})"
    )


if __name__ == "__main__":
    main()
