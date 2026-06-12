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
import time
from pathlib import Path

from playwright.async_api import async_playwright

from classifier.extract import build_record
from classifier.filtering import is_usable
from classifier.frontier import (attempted_path, build_pools, kept_by_label,
                                  kept_domains, load_attempted, load_ranks,
                                  remaining)
from classifier.render import open_context, render_on_context

ROOT = Path(__file__).resolve().parent
CFG = json.loads((ROOT / "poc.json").read_text(encoding="utf-8"))

WORKERS = int(os.environ.get("SCRAPE_WORKERS", "16"))
TIMEOUT_MS = int(os.environ.get("SCRAPE_TIMEOUT_MS", "15000"))
HARD_DEADLINE = TIMEOUT_MS / 1000 + 6  # wall-clock cap per render
TARGET = int(os.environ.get("SCRAPE_TARGET", str(CFG["per_class_target"])))
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
            # No await between here and the next render, so these sync writes /
            # counter bumps can't interleave with another worker — no lock.
            att_fh.write(domain + "\n")
            att_fh.flush()
            state["attempts"] += 1
            if raw is not None:
                rec = build_record(raw, url, label)
                if is_usable(rec):
                    raw_fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    raw_fh.flush()
                    state["kept"] += 1
            a = state["attempts"]
            if a % 100 == 0:
                rate = a / max(1e-9, time.perf_counter() - state["t0"])
                print(f"  [{label}] {state['kept']}/{state['target']} usable  "
                      f"({a} tried, {rate:.1f}/s)", flush=True)
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
    pools = build_pools(tsv, labels, seed=0, denylist=denylist,
                        popular_first=popular_first, ranks=ranks)
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
        print(f"[{label}] {have}/{TARGET} usable, pool_remaining={len(rem)}",
              flush=True)
        if not rem:
            print(f"[{label}] pool exhausted — leaving short at {have}", flush=True)
            continue

        work: asyncio.Queue = asyncio.Queue()
        for d in rem:
            work.put_nowait(d)
        state = {"kept": have, "target": TARGET, "attempts": 0,
                 "t0": time.perf_counter()}
        with raw_path.open("a", encoding="utf-8") as raw_fh, \
                attempted_path(state_dir, label).open("a", encoding="utf-8") as att_fh:
            async with async_playwright() as p:
                await asyncio.gather(*[
                    _worker(p, label, work, raw_fh, att_fh, state)
                    for _ in range(WORKERS)])
        outcome = "met" if state["kept"] >= TARGET else "short (pool drained)"
        print(f"[{label}] -> {state['kept']}/{TARGET} usable, "
              f"{state['attempts']} tried this run [{outcome}]", flush=True)

    print(f"done. corpus -> {raw_path}", flush=True)


def main() -> None:
    asyncio.run(_amain())


if __name__ == "__main__":
    main()
