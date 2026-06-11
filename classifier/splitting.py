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
