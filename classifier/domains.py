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
    # Sorted label order so the sampled sequence is reproducible across
    # processes (set iteration order varies with hash randomization).
    for label in sorted(buckets):
        domains = buckets[label]
        rng.shuffle(domains)
        out.extend((d, label) for d in domains[:per_class])
    return out
