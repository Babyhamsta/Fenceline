"""Target-driven scraper: draw domains per label until we have ``per_class_target``
usable records (or the label's pool is exhausted), then move on.

Each attempted domain is logged append-only (kill-safe) so re-runs never re-hit
the same domain — the corpus grows monotonically and a class that fell short can
be topped up by simply running again. Async: ``SCRAPE_WORKERS`` concurrent
workers per label, each owning its own Chromium (crash isolation) and reusing it
across pages; every render is bounded by a hard deadline (see render.py) so no
hostile page can stall the run. Records are byte-identical to the single-shot
``render`` path.

Env knobs: ``SCRAPE_WORKERS`` (default 16), ``SCRAPE_TIMEOUT_MS`` (default
15000), ``SCRAPE_TARGET`` (override per-class usable target)."""

import asyncio
import json
import os
import random
import time
from pathlib import Path

from playwright.async_api import async_playwright

from classifier.etld import etld1
from classifier.extract import build_record
from classifier.filtering import is_usable
from classifier.frontier import (
    attempted_path,
    build_pools,
    kept_by_label,
    kept_domains,
    load_attempted,
    load_ranks,
    load_seed,
    remaining,
    sample_interior_links,
)
from classifier.render import open_context, render_on_context

ROOT = Path(__file__).resolve().parent
CFG = json.loads((ROOT / "poc.json").read_text(encoding="utf-8"))

WORKERS = int(os.environ.get("SCRAPE_WORKERS", "16"))
TIMEOUT_MS = int(os.environ.get("SCRAPE_TIMEOUT_MS", "15000"))
HARD_DEADLINE = TIMEOUT_MS / 1000 + 6  # wall-clock cap per render
TARGET = int(os.environ.get("SCRAPE_TARGET", str(CFG["per_class_target"])))
# Interior pages sampled per usable homepage (same eTLD+1, label-inherited) so
# the model also trains on interior content, not just portal homepages. 0 = off.
INTERIOR_LINKS = int(os.environ.get("INTERIOR_LINKS", str(CFG.get("interior_links", 4))))
RECYCLE_EVERY = 200  # reopen each worker's context to bound memory growth


async def _worker(p, label, work, raw_fh, att_fh, state) -> None:
    try:
        browser = await p.chromium.launch(headless=True)
    except Exception as exc:
        print(f"  worker launch failed: {exc}", flush=True)
        return
    ctx = await open_context(browser, TIMEOUT_MS)
    served = 0
    try:
        while state["kept"] < state["target"]:
            try:
                domain = work.get_nowait()
            except asyncio.QueueEmpty:
                break
            url = f"https://{domain}/"
            raw = await render_on_context(ctx, url, TIMEOUT_MS, HARD_DEADLINE)
            # Each sync write/counter block below runs without an await inside it,
            # so under asyncio's single thread it can't interleave with another
            # worker — no lock. (Awaits happen only at render points.)
            att_fh.write(domain + "\n")
            att_fh.flush()
            state["attempts"] += 1
            homepage_usable = False
            if raw is not None:
                rec = build_record(raw, url, label)
                if is_usable(rec):
                    raw_fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    raw_fh.flush()
                    state["kept"] += 1
                    homepage_usable = True
            # Interior pages: only from a live homepage that itself yielded usable
            # text — a dead/blocked homepage's links aren't worth chasing. Sampled
            # records inherit the label and share the homepage's eTLD+1, so the
            # registrable-domain split keeps them on one side of train/test.
            if homepage_usable and INTERIOR_LINKS > 0:
                rng = random.Random(domain)
                interior = sample_interior_links(
                    raw.get("links") or [], etld1(url), INTERIOR_LINKS, rng
                )
                for link in interior:
                    if state["kept"] >= state["target"]:
                        break
                    raw_i = await render_on_context(ctx, link, TIMEOUT_MS, HARD_DEADLINE)
                    if raw_i is None:
                        continue
                    rec_i = build_record(raw_i, link, label)
                    if is_usable(rec_i):
                        raw_fh.write(json.dumps(rec_i, ensure_ascii=False) + "\n")
                        raw_fh.flush()
                        state["kept"] += 1
            a = state["attempts"]
            if a % 100 == 0:
                rate = a / max(1e-9, time.perf_counter() - state["t0"])
                print(
                    f"  [{label}] {state['kept']}/{state['target']} usable  "
                    f"({a} tried, {rate:.1f}/s)",
                    flush=True,
                )
            served += 1
            if served % RECYCLE_EVERY == 0:
                try:
                    await ctx.close()
                except Exception:
                    pass
                ctx = await open_context(browser, TIMEOUT_MS)
    finally:
        try:
            await browser.close()
        except Exception:
            pass


async def _amain() -> None:
    tsv = ROOT / CFG["paths"]["domains_tsv"]
    raw_path = ROOT / CFG["paths"]["raw"]
    state_dir = ROOT / CFG["paths"]["state_dir"]
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    state_dir.mkdir(parents=True, exist_ok=True)

    labels = [CFG["clean_label"]] + CFG["categories"]
    popular_first = tuple(CFG.get("popular_first", []))
    denylist = tuple(CFG.get("denylist", []))
    ranks = load_ranks(ROOT / CFG["paths"]["tranco"]) if popular_first else {}
    # Force-label seed lists (e.g. proxy_seed.txt -> proxy-bypass) so curated
    # domains are drawn under the right label regardless of upstream category.
    force_label = {label: load_seed(ROOT / rel) for label, rel in CFG.get("seed_lists", {}).items()}
    pools = build_pools(
        tsv,
        labels,
        seed=0,
        denylist=denylist,
        popular_first=popular_first,
        ranks=ranks,
        force_label=force_label,
    )
    kept = kept_by_label(raw_path)
    kept_doms = kept_domains(raw_path)

    print(f"target={TARGET} usable/class  workers={WORKERS}", flush=True)
    for label in labels:
        have = kept.get(label, 0)
        if have >= TARGET:
            print(f"[{label}] {have}/{TARGET} — already met, skipping", flush=True)
            continue
        attempted = load_attempted(state_dir, label)
        rem = remaining(pools[label], attempted, kept_doms)
        print(f"[{label}] {have}/{TARGET} usable, pool_remaining={len(rem)}", flush=True)
        if not rem:
            print(f"[{label}] pool exhausted — leaving short at {have}", flush=True)
            continue

        work: asyncio.Queue = asyncio.Queue()
        for d in rem:
            work.put_nowait(d)
        state = {"kept": have, "target": TARGET, "attempts": 0, "t0": time.perf_counter()}
        with (
            raw_path.open("a", encoding="utf-8") as raw_fh,
            attempted_path(state_dir, label).open("a", encoding="utf-8") as att_fh,
        ):
            async with async_playwright() as p:
                await asyncio.gather(
                    *[_worker(p, label, work, raw_fh, att_fh, state) for _ in range(WORKERS)]
                )
        outcome = "met" if state["kept"] >= TARGET else "short (pool drained)"
        print(
            f"[{label}] -> {state['kept']}/{TARGET} usable, "
            f"{state['attempts']} tried this run [{outcome}]",
            flush=True,
        )

    print(f"done. corpus -> {raw_path}", flush=True)


def main() -> None:
    asyncio.run(_amain())


if __name__ == "__main__":
    main()
