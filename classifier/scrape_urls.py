"""Render an explicit list of URLs (not domains) into labeled records, reusing
the same media-blocking Playwright context + shared structural extractor as the
main scraper, so the records are byte-identical in shape to the corpus. Built for
hard-negative mining: every URL is labeled CLEAN.

Each URL rendered once; kill-safe append; concurrent workers each own a browser.
A URL that fails to render or yields an unusable record is skipped (logged).

Usage:
  python -m classifier.scrape_urls --seeds hardneg_seeds.txt --label clean --out data/hardneg.jsonl
"""

import argparse
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
from classifier.frontier import sample_interior_links
from classifier.render import open_context, render_on_context

ROOT = Path(__file__).resolve().parent
WORKERS = int(os.environ.get("SCRAPE_WORKERS", "12"))
TIMEOUT_MS = int(os.environ.get("SCRAPE_TIMEOUT_MS", "15000"))
HARD_DEADLINE = TIMEOUT_MS / 1000 + 6
RECYCLE_EVERY = 200
FAIL_RECYCLE = 12
INTERIOR = 0  # set via --interior: sample N same-eTLD interior pages per seed


async def _new_session(p):
    try:
        browser = await p.chromium.launch(
            headless=True, args=["--disable-blink-features=AutomationControlled"]
        )
        ctx = await open_context(browser, TIMEOUT_MS)
        return browser, ctx
    except Exception as exc:
        print(f"  session launch failed: {exc}", flush=True)
        return None, None


async def _close_session(browser, ctx) -> None:
    for obj in (ctx, browser):
        if obj is None:
            continue
        try:
            await obj.close()
        except Exception:
            pass


async def _worker(p, work, label, out_fh, state) -> None:
    browser, ctx = await _new_session(p)
    if ctx is None:
        return
    served = 0
    consec_fail = 0
    try:
        while True:
            try:
                url = work.get_nowait()
            except asyncio.QueueEmpty:
                break
            raw = await render_on_context(ctx, url, TIMEOUT_MS, HARD_DEADLINE)
            state["tried"] += 1
            usable = False
            if raw is not None:
                rec = build_record(raw, url, label)
                if is_usable(rec):
                    out_fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    out_fh.flush()
                    state["kept"] += 1
                    usable = True
                consec_fail = 0
            else:
                consec_fail += 1
            # Interior sampling: from a usable seed, render N same-eTLD deeper
            # pages (e.g. a portal's actual game pages, which carry the canvas/
            # iframe game structure the homepage lacks). Same label.
            if usable and INTERIOR > 0:
                rng = random.Random(url)
                for link in sample_interior_links(
                    raw.get("links") or [], etld1(url), INTERIOR, rng
                ):
                    raw_i = await render_on_context(ctx, link, TIMEOUT_MS, HARD_DEADLINE)
                    state["tried"] += 1
                    if raw_i is None:
                        continue
                    rec_i = build_record(raw_i, link, label)
                    if is_usable(rec_i):
                        out_fh.write(json.dumps(rec_i, ensure_ascii=False) + "\n")
                        out_fh.flush()
                        state["kept"] += 1
            if state["tried"] % 50 == 0:
                rate = state["tried"] / max(1e-9, time.perf_counter() - state["t0"])
                print(f"  {state['kept']}/{state['tried']} usable ({rate:.1f}/s)", flush=True)
            served += 1
            if served % RECYCLE_EVERY == 0 or consec_fail >= FAIL_RECYCLE:
                await _close_session(browser, ctx)
                browser, ctx = await _new_session(p)
                consec_fail = 0
                if ctx is None:
                    break
    finally:
        await _close_session(browser, ctx)


async def _amain(seeds: Path, label: str, out: Path) -> None:
    urls = [u.strip() for u in seeds.read_text(encoding="utf-8").split("\n") if u.strip()]
    out.parent.mkdir(parents=True, exist_ok=True)
    work: asyncio.Queue = asyncio.Queue()
    for u in urls:
        work.put_nowait(u)
    state = {"kept": 0, "tried": 0, "t0": time.perf_counter()}
    print(f"rendering {len(urls)} URLs -> {out}  label={label} workers={WORKERS}", flush=True)
    with out.open("a", encoding="utf-8") as out_fh:
        async with async_playwright() as p:
            results = await asyncio.gather(
                *[_worker(p, work, label, out_fh, state) for _ in range(WORKERS)],
                return_exceptions=True,
            )
            for r in results:
                if isinstance(r, Exception):
                    print(f"  worker error: {r!r}", flush=True)
    print(f"done. {state['kept']}/{state['tried']} usable -> {out}", flush=True)


def main() -> None:
    global INTERIOR
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", required=True)
    ap.add_argument("--label", default="clean")
    ap.add_argument("--out", required=True)
    ap.add_argument(
        "--interior", type=int, default=0, help="sample N interior pages per usable seed"
    )
    args = ap.parse_args()
    INTERIOR = args.interior
    asyncio.run(_amain(ROOT / args.seeds, args.label, ROOT / args.out))


if __name__ == "__main__":
    main()
