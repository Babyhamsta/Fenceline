// Plain-JS inference from dist/model.bin + model-meta.json. MUST match
// classifier/vectorize.py and infer_ref.py exactly. This is the on-device path.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const META = JSON.parse(readFileSync(join(ROOT, "dist", "model-meta.json"), "utf8"));
const _bin = readFileSync(join(ROOT, "dist", "model.bin"));
const COEF = new Float32Array(_bin.buffer, _bin.byteOffset, _bin.byteLength / 4);

function fnv1a32(s) {
  let h = 0x811c9dc5;
  const bytes = new TextEncoder().encode(s);
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function* charNgrams(word) {
  const padded = "^" + word + "$";
  for (const n of [3, 4])
    for (let i = 0; i + n <= padded.length; i++) yield "#" + padded.slice(i, i + n);
}

function tokens(text) {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  const out = [];
  for (let i = 0; i < words.length; i++) {
    out.push(words[i]);
    if (i + 1 < words.length) out.push(words[i] + " " + words[i + 1]);
    for (const g of charNgrams(words[i])) out.push(g);
  }
  return out;
}

function vectorize(text) {
  const acc = new Map();
  for (const tok of tokens(text)) {
    const h = fnv1a32(tok);
    const idx = h & (META.dims - 1);
    const sign = (h >>> 31) & 1 ? -1 : 1;
    acc.set(idx, (acc.get(idx) || 0) + sign);
  }
  let norm = 0;
  for (const v of acc.values()) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return acc;
  for (const [k, v] of acc) acc.set(k, v / norm);
  return acc;
}

export function classify(text) {
  const C = META.classes.length;
  const vec = vectorize(text);
  const logits = META.intercept.slice();
  for (let ci = 0; ci < C; ci++) {
    const base = ci * META.dims;
    let s = logits[ci];
    for (const [idx, v] of vec) s += v * COEF[base + idx];
    logits[ci] = s;
  }
  const m = Math.max(...logits);
  const exps = logits.map((x) => Math.exp(x - m));
  const z = exps.reduce((a, b) => a + b, 0);
  const scores = {};
  META.classes.forEach((c, i) => (scores[c] = exps[i] / z));
  const label = META.classes[logits.indexOf(Math.max(...logits))];
  return { label, scores };
}

if (process.argv.includes("--selftest")) {
  console.log(classify("play free online games arcade racing puzzle"));
}
