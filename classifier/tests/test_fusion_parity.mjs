// Parity: the JS fusion interpreter (extension/lib/fusion.js) must walk the
// exported trees identically to the Python reference (classifier/fusion_ref.py),
// which itself is exact-equal to sklearn (export_fusion.py's parity assert). So
// this closes the chain sklearn == Python == JS for the on-device decision.
//
// We feed Python-computed text scores into BOTH sides so this isolates the new
// fusion tree-walk (the text vectorizer parity is covered by test_parity.mjs).
// Run from the REPO ROOT: node classifier/tests/test_fusion_parity.mjs
import { execFileSync } from "node:child_process";
import { readFileSync as readFile, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setFusion, fusionScores } from "../../extension/lib/fusion.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
// Validate the COMMITTED, shipped tree (the bundled baseline) — runs from a
// fresh checkout, no model-rebuild needed.
const FUSION = JSON.parse(readFile(join(REPO_ROOT, "extension", "model", "fusion.json"), "utf8"));
setFusion(FUSION);

function resolvePython() {
  if (process.env.FENCELINE_PYTHON) return process.env.FENCELINE_PYTHON;
  const winVenv = join(REPO_ROOT, ".venv", "Scripts", "python.exe");
  const nixVenv = join(REPO_ROOT, ".venv", "bin", "python");
  if (existsSync(winVenv)) return winVenv;
  if (existsSync(nixVenv)) return nixVenv;
  return process.platform === "win32" ? "python" : "python3";
}
const PY = resolvePython();

// A few records spanning class signals + varied structure, so the walk visits
// many distinct paths. Values are plausible but only need to exercise the trees.
const RECORDS = [
  {
    title: "Cool Math Games",
    meta: "free online games",
    text: "play free online games arcade racing puzzle multiplayer strategy",
    structural: { link_density: 0.78, paragraph_count: 55, tag_a: 244, tag_img: 72, internal_link_ratio: 0.9, dom_node_count: 4285, iframe_count: 3, iframe_cross_origin_count: 1, kw_url_games: 1, canvas_area_fraction: 0 }
  },
  {
    title: "Proxy server - Wikipedia",
    meta: "",
    text: "a proxy server is a server application that acts as an intermediary unblock vpn",
    structural: { link_density: 0.18, paragraph_count: 60, has_url_like_input: false, url_embeds_url: false, has_dominant_canvas: false, fp_proxy_marker_count: 3, dom_node_count: 5000, tag_a: 800 }
  },
  {
    title: "Online Casino Sportsbook",
    meta: "bet now",
    text: "casino sportsbook poker deposit bonus real money slots blackjack roulette",
    structural: { link_density: 0.28, paragraph_count: 5, has_gambling_license_seal: true, has_large_xorigin_iframe: false, fp_gambling_affiliate_count: 0, dom_node_count: 1200 }
  },
  {
    title: "BBC News",
    meta: "world news",
    text: "breaking world news politics business technology health science sports",
    structural: { link_density: 0.55, paragraph_count: 20, tag_a: 300, dom_node_count: 3000, internal_link_ratio: 0.8 }
  }
];

let fail = 0;
function close(a, b, msg) {
  if (Math.abs(a - b) < 1e-9) return;
  console.error(`  FAIL  ${msg} js=${a} py=${b}`);
  fail++;
}

for (const rec of RECORDS) {
  const out = JSON.parse(
    execFileSync(PY, ["-m", "classifier.fusion_ref", JSON.stringify(rec)], {
      cwd: REPO_ROOT,
      encoding: "utf8"
    })
  );
  const js = fusionScores(out.text, rec.structural);
  for (const c of Object.keys(out.fusion)) close(js[c], out.fusion[c], `${rec.title} :: ${c}`);
}

console.log(fail ? `\n${fail} FUSION PARITY FAILURE(S)` : "All fusion parity checks passed.");
process.exit(fail ? 1 : 0);
