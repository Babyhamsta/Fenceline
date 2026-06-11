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
