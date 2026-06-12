// Parity: the JS scorer must match the Python scorer on the same input.
// Run from the REPO ROOT: node classifier/tests/test_parity.mjs
import { classify } from "../infer.mjs";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Resolve the Python interpreter cross-platform so this runs locally (Windows or
// POSIX venv) and in CI (no venv — deps installed into the runner's python).
// FENCELINE_PYTHON overrides everything.
function resolvePython() {
  if (process.env.FENCELINE_PYTHON) return process.env.FENCELINE_PYTHON;
  const winVenv = join(REPO_ROOT, ".venv", "Scripts", "python.exe");
  const nixVenv = join(REPO_ROOT, ".venv", "bin", "python");
  if (existsSync(winVenv)) return winVenv;
  if (existsSync(nixVenv)) return nixVenv;
  return process.platform === "win32" ? "python" : "python3";
}
const PY = resolvePython();
const text = "play free online games arcade racing puzzle multiplayer";
const js = classify(text);
const py = JSON.parse(
  execFileSync(
    PY,
    ["-c",
     "import json\nfrom classifier.infer_ref import classify_ref\nprint(json.dumps(classify_ref(" +
       JSON.stringify(text) + ")))"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  )
);

let fail = 0;
function close(a, b, msg) {
  if (Math.abs(a - b) < 1e-5) console.log("  ok    " + msg);
  else { console.error(`  FAIL  ${msg} js=${a} py=${b}`); fail++; }
}
if (js.label !== py.label) { console.error(`  FAIL  label js=${js.label} py=${py.label}`); fail++; }
else console.log("  ok    label matches: " + js.label);
for (const c of Object.keys(js.scores)) close(js.scores[c], py.scores[c], "score[" + c + "]");
console.log(fail ? `\n${fail} FAILURE(S)` : "\nAll checks passed.");
process.exit(fail ? 1 : 0);
