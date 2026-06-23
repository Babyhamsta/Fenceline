// Decision-rule parity + shipped-vs-harness sync guard.
//
// Runs the ACTUAL on-device decision (extension/lib/model.js:decide, loaded with
// the shipped extension/model artifacts via the _loadModelForTest seam, plus the
// SERP exemption that sw.js applies upstream) against the Python harness path
// (classifier.fusion_ref text+fusion scores -> classifier.fp_audit.hybrid_decide).
// Same text + structural in, identical (blocked category) out — across every
// branch of the rule: serp-exempt, fusion-block, text-backstop, prose-rescued,
// and clean. Because both sides load extension/model, this also guards that the
// Python harness (template_test) scores the SAME model the device ships: if the
// exported artifacts drift from each other, or someone repoints a side at a
// different model, these stop agreeing.
//
// Run from the REPO ROOT: node classifier/tests/test_decision_parity.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decide, _loadModelForTest } from "../../extension/lib/model.js";
import { isSearchEngineSerp } from "../../extension/lib/detect/search-engine.js";
import { PY } from "./_py.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const MODEL = join(REPO_ROOT, "extension", "model");

// Load the shipped artifacts into model.js exactly as the device would.
const meta = JSON.parse(readFileSync(join(MODEL, "model-meta.json"), "utf8"));
const fusion = JSON.parse(readFileSync(join(MODEL, "fusion.json"), "utf8"));
const binBuf = readFileSync(join(MODEL, "model.bin"));
const coef = binBuf.buffer.slice(binBuf.byteOffset, binBuf.byteOffset + binBuf.byteLength);
_loadModelForTest(coef, meta, fusion);

// Cases span every rule branch and mirror the template structural vectors so this
// doubles as the device-vs-harness sync check on the shapes the corpus probes.
const CASES = [
  {
    name: "serp: google /search with proxy query",
    url: "https://www.google.com/search?q=unblocked+proxy+vpn",
    text: "free web proxy unblock youtube vpn bypass school filter",
    structural: { paragraph_count: 0, link_density: 1.4 }
  },
  {
    name: "fusion-block: playable game (dominant canvas)",
    url: "https://gamesite.example/play",
    text: "play free online arcade racing puzzle game click to start",
    structural: {
      has_dominant_canvas: true,
      canvas_area_fraction: 0.7,
      paragraph_count: 1,
      link_density: 0
    }
  },
  {
    // Strong proxy vocab + a URL box on a thin page; fusion clears thr here.
    name: "fusion-block: thin web proxy (url box)",
    url: "https://freeproxy.example/",
    text: "free web proxy unblock any site enter the url of the website to browse anonymously",
    structural: { has_url_like_input: true, paragraph_count: 1, link_density: 0 }
  },
  {
    // Gambling-heavy vocab but PROSE structure (low link density, many paragraphs,
    // no functional element): fusion stays below thr_fusion, text clears thr_text,
    // and prose_rescue overturns the text-backstop -> clean. Exercises the
    // rescue->clean branch (the core is-vs-about defense) end-to-end across JS/Py.
    name: "prose-rescue->clean: casino review article",
    url: "https://reviews.example/red-dog-casino-review",
    text:
      "red dog casino review play online slots blackjack roulette poker free no deposit " +
      "bonus codes best online casinos mobile casino games we review the welcome bonus and " +
      "wagering requirements for new players and explain how the games work in plain language",
    structural: { link_density: 0.11, paragraph_count: 14 }
  },
  {
    name: "fusion-block: adult video player + age gate",
    url: "https://tube.example/watch",
    text: "watch explicit adult videos nsfw porn you must be 18 or over adults only age verification",
    structural: { has_video_player: true, has_age_gate: true, paragraph_count: 2, link_density: 0 }
  },
  {
    // License seal + payment, but thin gambling text -> fusion sits just under thr
    // and the block comes from the text-backstop (the [reason] column confirms it).
    name: "text-backstop: casino (license seal + payment)",
    url: "https://casino.example/play",
    text: "play real money slots blackjack roulette deposit now welcome bonus licensed curacao gaming",
    structural: {
      has_gambling_license_seal: true,
      has_payment_field: true,
      paragraph_count: 2,
      link_density: 0
    }
  },
  {
    name: "clean: neutral article",
    url: "https://news.example/weather",
    text: "the forecast calls for rain across the region with cooler temperatures and gusty winds",
    structural: { paragraph_count: 10, link_density: 0.18 }
  }
];

// JS device decision: SERP exemption first (as sw.js does), then model.js:decide.
function jsDecide(c) {
  let host = "";
  let path = "/";
  try {
    const u = new URL(c.url);
    host = u.hostname;
    path = u.pathname;
  } catch {
    /* keep defaults */
  }
  if (isSearchEngineSerp(host, path)) return { category: "clean", blocked: false, confidence: 0 };
  const r = decide(c.text, c.structural);
  return r
    ? { category: r.category, blocked: true, confidence: r.confidence }
    : { category: "clean", blocked: false, confidence: 0 };
}

const pyOut = JSON.parse(
  execFileSync(
    PY,
    [
      "-c",
      [
        "import json,sys",
        "from classifier import fusion_ref as FR",
        "from classifier.decision import hybrid_decide",
        "CLEAN=FR.META.get('clean_label','clean')",
        "TF=float(FR.META.get('thr_fusion') or 0.97); TT=float(FR.META.get('thr_text') or 0.89)",
        "cases=json.loads(sys.argv[1])",
        "out=[]",
        "for c in cases:",
        "    rec={'title':'','meta':'','text':c['text'],'structural':c['structural'],'url':c['url']}",
        "    ts=FR.text_scores(rec)",
        "    fs=FR.fusion_scores(ts, c['structural'])",
        "    cat,conf,reason=hybrid_decide(c['url'], ts, fs, c['structural'], CLEAN, TF, TT)",
        "    out.append({'category': cat if cat!=CLEAN else 'clean','blocked': cat!=CLEAN,'reason':reason,'confidence':conf})",
        "print(json.dumps(out))"
      ].join("\n"),
      JSON.stringify(CASES.map((c) => ({ url: c.url, text: c.text, structural: c.structural })))
    ],
    { cwd: REPO_ROOT, encoding: "utf8" }
  )
);

let fail = 0;
CASES.forEach((c, i) => {
  const js = jsDecide(c);
  const py = pyOut[i];
  const catOk = js.category === py.category && js.blocked === py.blocked;
  // 1e-4 (looser than fusion_parity's 1e-9) because this is a FULL-pipeline test:
  // each side computes text scores independently (JS classify vs Python
  // text_scores), so a ~1e-6 vectorizer delta can propagate into the fusion
  // confidence. fusion_parity feeds identical text scores to both sides, so it
  // can demand 1e-9. The category decision is unaffected by this margin.
  const confOk = !js.blocked || Math.abs(js.confidence - py.confidence) < 1e-4;
  if (catOk && confOk) {
    console.log(
      `  ok    ${c.name} -> ${js.category}${js.blocked ? "@" + js.confidence.toFixed(3) : ""} [${py.reason}]`
    );
  } else {
    fail++;
    console.error(
      `  FAIL  ${c.name}\n        js=${JSON.stringify(js)}\n        py=${JSON.stringify(py)}`
    );
  }
});

console.log(fail ? `\n${fail} DECISION PARITY FAILURE(S)` : "\nAll decision parity checks passed.");
process.exit(fail ? 1 : 0);
