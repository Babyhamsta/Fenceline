"""Live-site harness for the v3 fusion model: render a URL with the same
Playwright path the corpus used, then score it with BOTH the text-only model and
the fusion GBDT so we can see where structure changes the verdict. Used for the
real-site sanity pass and the adversarial "try to trick it" pass.

Usage:
  python -m classifier.classify_v3 https://example.com [https://...]
  python -m classifier.classify_v3 --suite        # built-in hard-negative + true-positive set

Prints, per URL: the text-only top class + prob, the fusion top class + prob, and
the final block decision at THR for each (block = top non-clean prob >= THR).
"""

import json
import pickle
import sys
from pathlib import Path

import numpy as np

from classifier.decision import is_search_engine_url, prose_rescue
from classifier.extract import build_record, doc
from classifier.render import render
from classifier.vectorize import DIMS, vectorize

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "dist_v3"
# Per-model operating points taken from the train_gbdt eval at the ~1.5% clean-FP
# budget: the LR and the GBDT have different calibration, so a single threshold
# would be unfair. Block = top non-clean prob >= the model's own threshold.
THR_TEXT = 0.89
THR_FUSION = 0.97

feat = json.loads((OUT / "features.json").read_text(encoding="utf-8"))
ENG, CLASSES, CLEAN = feat["engineered"], feat["classes"], feat["clean"]

tm = np.load(OUT / "text_model.npz", allow_pickle=True)
COEF, INTERCEPT = tm["coef"].astype(np.float32), tm["intercept"].astype(np.float32)
TEXT_CLASSES = list(tm["classes"])
with (OUT / "fusion_gbdt.pkl").open("rb") as fh:
    GBDT = pickle.load(fh)

# Hard negatives must stay CLEAN; true positives must BLOCK. Live URLs — some may
# be down or cloak; the harness reports a render failure rather than guessing.
SUITE = [
    ("https://en.wikipedia.org/wiki/Proxy_server", "clean", "wiki: proxy article (about, not is)"),
    ("https://en.wikipedia.org/wiki/Online_gambling", "clean", "wiki: gambling article"),
    ("https://en.wikipedia.org/wiki/Pornography", "clean", "wiki: adult-topic article"),
    ("https://www.plannedparenthood.org/learn/teens/sex", "clean", "sex-ed (adult vocab, clean)"),
    ("https://nordvpn.com/", "proxy-bypass", "VPN vendor (bypass tool -> block)"),
    ("https://www.google.com/search?q=unblocked+games+proxy", "clean", "SERP for blocked terms"),
    ("https://www.khanacademy.org/math/arithmetic", "clean", "interactive-but-clean edu"),
    ("https://www.espn.com/", "clean", "sports news (gambling-adjacent)"),
    ("https://www.croxyproxy.com/", "proxy-bypass", "live web proxy"),
    ("https://www.proxysite.com/", "proxy-bypass", "live web proxy"),
    ("https://www.coolmathgames.com/", "games", "games portal"),
    # --- held-out hard negatives (NOT in training seeds) -> must stay CLEAN -----
    ("https://www.vyprvpn.com/", "proxy-bypass", "held-out VPN vendor -> block"),
    ("https://www.strongvpn.com/", "proxy-bypass", "held-out VPN vendor -> block"),
    ("https://www.actionnetwork.com/", "clean", "held-out sports-betting NEWS"),
    ("https://www.gameinformer.com/", "clean", "held-out gaming news"),
    ("https://en.wikipedia.org/wiki/Online_casino", "clean", "held-out wiki gambling article"),
    ("https://en.wikipedia.org/wiki/Web_proxy_auto-discovery_protocol", "clean", "held-out wiki proxy article"),
    ("https://en.wikipedia.org/wiki/Sex_education", "clean", "held-out wiki adult-topic article"),
    # --- additional true positives -> must BLOCK -------------------------------
    ("https://www.4everproxy.com/", "proxy-bypass", "functional web proxy"),
    ("https://www.bovada.lv/", "gambling", "live casino/sportsbook"),
    ("https://www.hoodamath.com/", "games", "held-out prose-heavy math-games portal"),
    ("https://www.abcya.com/", "games", "held-out edu-games portal"),
    # --- adult: verify real adult/video sites block (not in any seed list) ------
    ("https://www.pornhub.com/", "adult", "mainstream adult tube"),
    ("https://www.xvideos.com/", "adult", "mainstream adult tube"),
    ("https://www.redtube.com/", "adult", "adult tube"),
    ("https://www.eporner.com/", "adult", "long-tail adult tube"),
    ("https://onlyfans.com/", "adult", "adult content platform"),
    # --- held-out clean (news/diverse NOT in diverse_clean seeds) -> stay CLEAN -
    ("https://slate.com/", "clean", "held-out news/opinion"),
    ("https://www.404media.co/", "clean", "held-out tech news"),
    ("https://www.snopes.com/", "clean", "held-out fact-check"),
    # --- held-out gambling operators (NOT in gambling_ops) -> BLOCK ------------
    ("https://stake.com/", "gambling", "held-out crypto casino"),
    ("https://www.betsson.com/", "gambling", "held-out sportsbook"),
]


def text_scores(rec):
    lg = INTERCEPT.copy()
    for idx, v in vectorize(doc(rec)).items():
        lg += v * COEF[:, idx]
    e = np.exp(lg - lg.max())
    p = e / e.sum()
    return {c: float(p[i]) for i, c in enumerate(TEXT_CLASSES)}


def eng_vec(rec):
    s = rec.get("structural") or {}
    return [float(s.get(k) or 0.0) for k in ENG]


def fusion_scores(rec, tscores):
    tvec = np.array([[tscores[c] for c in CLASSES]])
    x = np.hstack([tvec, np.array([eng_vec(rec)])])
    p = GBDT.predict_proba(x)[0]
    return {c: float(p[i]) for i, c in enumerate(GBDT.classes_)}


def decide(scores, thr):
    blocked = [(c, scores[c]) for c in scores if c != CLEAN]
    c, p = max(blocked, key=lambda x: x[1])
    return (c, p) if p >= thr else (CLEAN, p)


def hybrid_decide(ts, fs, structural, url):
    """The shipped decision: text + fusion together. Fusion (text+structure) is
    the primary nuanced call; text is a high-recall BACKSTOP for true positives
    fusion misses (operator landing pages etc.), suppressed only when the page is
    a clearly-clean ARTICLE by structure — so text's vocabulary false-positives
    (Wikipedia 'Proxy server') don't leak through. SERP exemption mirrors prod."""
    if is_search_engine_url(url):
        return (CLEAN, 0.0, "serp-exempt")
    f_dec = decide(fs, THR_FUSION)
    if f_dec[0] != CLEAN:
        return (f_dec[0], f_dec[1], "fusion")
    t_dec = decide(ts, THR_TEXT)
    if t_dec[0] != CLEAN and not prose_rescue(t_dec[0], structural):
        return (t_dec[0], t_dec[1], "text-backstop")
    return (CLEAN, max(f_dec[1], t_dec[1]), "-")


def run(url, expect=None, note=""):
    raw = render(url)
    if raw is None:
        print(f"  RENDER FAIL  {url}  ({note})")
        return
    rec = build_record(raw, url, expect or "clean")
    ts = text_scores(rec)
    fs = fusion_scores(rec, ts)
    t_dec = decide(ts, THR_TEXT)
    f_dec = decide(fs, THR_FUSION)
    h_dec = hybrid_decide(ts, fs, rec.get("structural") or {}, url)

    def fmt(dec):
        return f"{dec[0]}@{dec[1]:.2f}"

    flag = ""
    if expect:
        h_ok = (h_dec[0] == CLEAN) == (expect == CLEAN)
        flag = f"  HYBRID:{'ok' if h_ok else 'MISS'}"
    print(f"  {url}")
    print(
        f"     expect={expect or '?':12} text={fmt(t_dec):18} fusion={fmt(f_dec):18} "
        f"HYBRID={fmt(h_dec):18}({h_dec[2]}){flag}   {note}"
    )


def main():
    args = sys.argv[1:]
    if not args or args[0] == "--suite":
        print(f"THR_TEXT={THR_TEXT} THR_FUSION={THR_FUSION}\n=== suite ===")
        for url, expect, note in SUITE:
            run(url, expect, note)
    else:
        print(f"THR_TEXT={THR_TEXT} THR_FUSION={THR_FUSION}")
        for url in args:
            run(url)


if __name__ == "__main__":
    main()
