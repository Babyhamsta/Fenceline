// Fusion GBDT interpreter — the Stage-2 model that weighs the page's STRUCTURE
// (what it IS and DOES) alongside the text score, so an article ABOUT a topic
// isn't blocked like an instance of it. Walks the tree array exported by
// classifier/export_fusion.py; the traversal MUST stay byte-identical to that
// file's Python `walk` (the parity test in classifier/tests/test_parity.mjs
// proves it on real records — a divergence means the device disagrees with what
// we evaluated).
//
// Input vector X = [text prob per class (model class order)]
//                  ++ [engineered structural scalars (fusion.engineered order)].
// raw[k] = baseline[k] + sum over every tree of its leaf for X; proba = softmax.

let FUSION = null; // { classes, baseline, n_text, engineered[], thr_fusion, thr_text, trees }

export function setFusion(obj) {
  FUSION = obj;
}

export function isFusionReady() {
  return FUSION !== null;
}

export function fusionParams() {
  return FUSION ? { thrFusion: FUSION.thr_fusion, thrText: FUSION.thr_text } : null;
}

// One tree: nodes are [feature_idx, threshold, left, right, value, is_leaf,
// missing_go_to_left]. Split rule: X[feat] <= threshold -> left, else right; a
// NaN feature follows the trained missing direction (our features default to 0,
// so this is only a safety mirror of the Python path).
function walk(nodes, x) {
  let i = 0;
  for (;;) {
    const n = nodes[i];
    if (n[5]) return n[4]; // is_leaf -> value
    const xv = x[n[0]];
    if (xv !== xv) i = n[6] ? n[2] : n[3];
    else i = xv <= n[1] ? n[2] : n[3];
  }
}

// textScores: { className: prob } from the text model. structural: the live dict
// from the content script. Returns { className: prob } from the fusion model.
export function fusionScores(textScores, structural) {
  const nText = FUSION.n_text;
  const eng = FUSION.engineered;
  const x = new Array(nText + eng.length);
  for (let k = 0; k < FUSION.classes.length; k++) x[k] = textScores[FUSION.classes[k]] || 0;
  const s = structural || {};
  for (let i = 0; i < eng.length; i++) {
    const v = Number(s[eng[i]]);
    x[nText + i] = Number.isFinite(v) ? v : 0;
  }
  const raw = FUSION.baseline.slice();
  for (const trees of FUSION.trees) {
    for (let k = 0; k < trees.length; k++) raw[k] += walk(trees[k], x);
  }
  let m = -Infinity;
  for (const v of raw) if (v > m) m = v;
  let z = 0;
  const exps = raw.map((v) => {
    const e = Math.exp(v - m);
    z += e;
    return e;
  });
  const out = {};
  FUSION.classes.forEach((c, i) => (out[c] = exps[i] / z));
  return out;
}
