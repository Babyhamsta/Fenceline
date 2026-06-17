// Content-classifier tier (Tier 3): a tiny logistic model over an FNV hashing
// vectorizer that scans a page's rendered text AFTER it loads and blocks sites
// the lists missed. The scoring here MUST stay byte-identical to
// classifier/vectorize.py and classifier/infer.mjs — same hash, same n-grams,
// same softmax — or the on-device decision won't match what we evaluated.
//
// The weights (model.bin, a float32 [n_classes x dims] matrix ~1.3 MB) and
// model-meta.json are pulled by sync.js when their version changes and cached
// in the same IndexedDB the tail engine uses. Classification runs in the
// service worker (one resident copy) — content scripts only send page text.

import { setFusion, isFusionReady, fusionScores } from "./fusion.js";
import { proseRescue } from "./detect/prose-rescue.js";

const DB_NAME = "fenceline";
const STORE = "artifacts";

let COEF = null; // Float32Array, row-major [classes x dims]
let META = null; // { version, dims, classes, intercept, clean_label, block_threshold, thr_* }
let loadPromise = null;

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbSet(db, key, val) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readwrite").objectStore(STORE).put(val, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function storeModel(coefBuf, meta, fusion) {
  const db = await idb();
  await idbSet(db, "model", coefBuf);
  await idbSet(db, "modelMeta", meta);
  if (fusion) await idbSet(db, "fusion", fusion);
  db.close();
  COEF = new Float32Array(coefBuf);
  META = meta;
  if (fusion) setFusion(fusion);
}

export async function getStoredModelVersion() {
  try {
    const db = await idb();
    const m = await idbGet(db, "modelMeta");
    db.close();
    return (m && m.version) || null;
  } catch {
    return null;
  }
}

// Load the baseline model bundled with the extension. Lets the content tier
// work the instant the extension is loaded (incl. load-unpacked testing),
// before the first sync — sync later swaps in a newer version from IndexedDB.
async function loadBundled() {
  try {
    const base = chrome.runtime.getURL("model/");
    const [binRes, metaRes] = await Promise.all([
      fetch(base + "model.bin"),
      fetch(base + "model-meta.json")
    ]);
    if (!binRes.ok || !metaRes.ok) return false;
    COEF = new Float32Array(await binRes.arrayBuffer());
    META = await metaRes.json();
    // Stage-2 fusion model travels alongside the text weights. Optional: if it's
    // absent or fails to parse, decide() degrades to text-only.
    if (META.fusion_file) {
      try {
        const fRes = await fetch(base + META.fusion_file);
        if (fRes.ok) setFusion(await fRes.json());
      } catch {
        /* text-only fallback */
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function ensureModelLoaded() {
  if (COEF) return Promise.resolve(true);
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const db = await idb();
        const [buf, meta, fusion] = await Promise.all([
          idbGet(db, "model"),
          idbGet(db, "modelMeta"),
          idbGet(db, "fusion")
        ]);
        db.close();
        if (buf && meta) {
          COEF = new Float32Array(buf);
          META = meta;
          if (fusion) setFusion(fusion);
          return true;
        }
        // No synced model yet — fall back to the bundled baseline.
        return await loadBundled();
      } catch (e) {
        console.error("[fenceline] model load failed", e);
        return await loadBundled();
      } finally {
        loadPromise = null;
      }
    })();
  }
  return loadPromise;
}

export function isModelReady() {
  return COEF !== null;
}

export function modelVersion() {
  return META ? META.version : null;
}

// ---- scoring (must match classifier/infer.mjs exactly) -----------------

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
  return scores;
}

// Top non-clean category and its probability from a {class: prob} map.
function topBlocked(scores, clean) {
  let best = null;
  for (const [cat, p] of Object.entries(scores)) {
    if (cat === clean) continue;
    if (!best || p > best.confidence) best = { category: cat, confidence: p };
  }
  return best;
}

// The deploy rule: the HYBRID of the text model and the Stage-2 fusion GBDT.
//
//   1. Fusion (text scores + page structure) is the primary call — it learned
//      the is-vs-about distinction, so it cleans articles a bag-of-words blocks.
//      Block when its top category clears thr_fusion.
//   2. Text is a high-recall BACKSTOP for true positives the fusion misses
//      (operator landing pages, atypical portals): block when text clears
//      thr_text, UNLESS the structural article-guard (proseRescue) says the page
//      is clearly prose about the topic with no functional element — that guard
//      is what stops the text model's vocabulary false-positives (Wikipedia
//      "Proxy server") from leaking through the backstop.
//
// ``structural`` is the live feature dict from the content script. The SERP
// exemption is applied upstream in sw.js (before this runs). If the fusion model
// isn't loaded, we degrade to text-only at block_threshold. thresholdOverride
// (managed policy) tightens the primary threshold and floors the backstop.
// Returns {category, confidence} or null.
export function decide(text, structural, thresholdOverride) {
  if (!COEF) return null;
  const clean = META.clean_label;
  const textScores = classify(text);

  // Text-only fallback when no fusion model is present.
  if (!isFusionReady()) {
    const threshold = thresholdOverride != null ? thresholdOverride : META.block_threshold;
    const best = topBlocked(textScores, clean);
    return best && best.confidence >= threshold ? best : null;
  }

  const thrFusion = thresholdOverride != null ? thresholdOverride : (META.thr_fusion ?? 0.97);
  const thrText =
    thresholdOverride != null ? Math.max(META.thr_text ?? 0.89, thresholdOverride) : (META.thr_text ?? 0.89);

  const fScores = fusionScores(textScores, structural);
  const fBest = topBlocked(fScores, clean);
  if (fBest && fBest.confidence >= thrFusion) return fBest;

  const tBest = topBlocked(textScores, clean);
  if (tBest && tBest.confidence >= thrText && !proseRescue(tBest.category, structural)) {
    return tBest;
  }
  return null;
}
