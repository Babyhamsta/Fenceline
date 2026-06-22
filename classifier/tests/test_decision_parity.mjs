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
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decide, _loadModelForTest } from "../../extension/lib/model.js";
import { isSearchEngineSerp } from "../../extension/lib/detect/search-engine.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const MODEL = join(REPO_ROOT, "extension", "model");

// Load the shipped artifacts into model.js exactly as the device would.
const meta = JSON.parse(readFileSync(join(MODEL, "model-meta.json"), "utf8"));
const fusion = JSON.parse(readFileSync(join(MODEL, "fusion.json"), "utf8"));
const binBuf = readFileSync(join(MODEL, "model.bin"));
const coef = binBuf.buffer.slice(binBuf.byteOffset, binBuf.byteOffset + binBuf.byteLength);
_loadModelForTest(coef, meta, fusion);

function resolvePython() {
  if (process.env.FENCELINE_PYTHON) return process.env.FENCELINE_PYTHON;
  const winVenv = join(REPO_ROOT, ".venv", "Scripts", "python.exe");
  const nixVenv = join(REPO_ROOT, ".venv", "bin", "python");
  if (existsSync(winVenv)) return winVenv;
  if (existsSync(nixVenv)) return nixVenv;
  return process.platform === "win32" ? "python" : "python3";
}
const PY = resolvePython();

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
    structural: { has_dominant_canvas: true, canvas_area_fraction: 0.7, paragraph_count: 1, link_density: 0 }
  },
  {
    name: "text-backstop: thin web proxy (url box, no prose)",
    url: "https://freeproxy.example/",
    text: "free web proxy unblock any site enter the url of the website to browse anonymously",
    structural: { has_url_like_input: true, paragraph_count: 1, link_density: 0 }
  },
  {
    // Prose structure + heavy proxy vocab. Whichever branch fires (fusion vs
    // text-backstop-then-prose-rescue), both sides must land on the SAME verdict —
    // that agreement is the point. The rescue->clean transition itself is unit-
    // tested in test/detect.mjs (proseRescue) and the clean prose templates.
    name: "proxy article (prose, no functional element)",
    url: "https://blog.example/what-is-a-proxy",
    text:
      "a proxy server is an intermediary between a client and the internet it forwards requests " +
      "organisations use proxies for caching access control and monitoring a reverse proxy balances load",
    structural: { link_density: 0.2, paragraph_count: 8, has_url_like_input: false, url_embeds_url: false, has_dominant_canvas: false }
  },
  {
    name: "fusion-block: adult video player + age gate",
    url: "https://tube.example/watch",
    text: "watch explicit adult videos nsfw porn you must be 18 or over adults only age verification",
    structural: { has_video_player: true, has_age_gate: true, paragraph_count: 2, link_density: 0 }
  },
  {
    name: "fusion-block: casino (license seal + payment)",
    url: "https://casino.example/play",
    text: "play real money slots blackjack roulette deposit now welcome bonus licensed curacao gaming",
    structural: { has_gambling_license_seal: true, has_payment_field: true, paragraph_count: 2, link_density: 0 }
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
  return r ? { category: r.category, blocked: true, confidence: r.confidence } : { category: "clean", blocked: false, confidence: 0 };
}

const pyOut = JSON.parse(
  execFileSync(
    PY,
    [
      "-c",
      [
        "import json,sys",
        "from classifier import fusion_ref as FR",
        "from classifier.fp_audit import hybrid_decide, CLEAN",
        "cases=json.loads(sys.argv[1])",
        "out=[]",
        "for c in cases:",
        "    rec={'title':'','meta':'','text':c['text'],'structural':c['structural'],'url':c['url']}",
        "    ts=FR.text_scores(rec)",
        "    fs=FR.fusion_scores(ts, c['structural'])",
        "    cat,conf,reason=hybrid_decide(c['url'], ts, fs, c['structural'])",
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
  const confOk = !js.blocked || Math.abs(js.confidence - py.confidence) < 1e-4;
  if (catOk && confOk) {
    console.log(`  ok    ${c.name} -> ${js.category}${js.blocked ? "@" + js.confidence.toFixed(3) : ""} [${py.reason}]`);
  } else {
    fail++;
    console.error(
      `  FAIL  ${c.name}\n        js=${JSON.stringify(js)}\n        py=${JSON.stringify(py)}`
    );
  }
});

console.log(fail ? `\n${fail} DECISION PARITY FAILURE(S)` : "\nAll decision parity checks passed.");
process.exit(fail ? 1 : 0);
