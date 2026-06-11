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
