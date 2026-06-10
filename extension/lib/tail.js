// Tail engine: the full blocklist as a sorted BigUint64Array of FNV-1a
// hashes (8 bytes/domain) plus a parallel Uint8Array of category indices
// (1 byte/domain). 4.5M domains ≈ ~40 MB resident — fine on 4 GB
// Chromebooks, unlike a Set of strings (300+ MB).
//
// Persisted in IndexedDB as raw ArrayBuffers; reloaded on service worker
// cold start. While loading, navigation checks await the load promise.

import { fnv1a64, domainCandidates, lookupHash } from "./hash.js";

const DB_NAME = "fenceline";
const STORE = "artifacts";

let hashes = null; // BigUint64Array
let cats = null; // Uint8Array
let catNames = []; // index -> category name
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

export async function storeArtifacts(tailBuf, catsBuf, categoryNames, version) {
  const db = await idb();
  await idbSet(db, "tail", tailBuf);
  await idbSet(db, "cats", catsBuf);
  await idbSet(db, "catNames", categoryNames);
  await idbSet(db, "version", version);
  db.close();
  // Swap in-memory immediately.
  hashes = new BigUint64Array(tailBuf);
  cats = new Uint8Array(catsBuf);
  catNames = categoryNames;
}

export function ensureLoaded() {
  if (hashes) return Promise.resolve(true);
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const db = await idb();
        const [t, c, n] = await Promise.all([
          idbGet(db, "tail"),
          idbGet(db, "cats"),
          idbGet(db, "catNames")
        ]);
        db.close();
        if (t && c) {
          hashes = new BigUint64Array(t);
          cats = new Uint8Array(c);
          catNames = n || [];
          return true;
        }
        return false;
      } catch (e) {
        console.error("[fenceline] tail load failed", e);
        return false;
      } finally {
        loadPromise = null;
      }
    })();
  }
  return loadPromise;
}

export async function getStoredVersion() {
  try {
    const db = await idb();
    const v = await idbGet(db, "version");
    db.close();
    return v || null;
  } catch {
    return null;
  }
}

export function isReady() {
  return hashes !== null;
}

export function listSize() {
  return hashes ? hashes.length : 0;
}

// Returns { domain, category } if any suffix of hostname is blocked, else null.
export function check(hostname) {
  if (!hashes || hashes.length === 0) return null;
  for (const cand of domainCandidates(hostname)) {
    const idx = lookupHash(hashes, fnv1a64(cand));
    if (idx !== -1) {
      return { domain: cand, category: catNames[cats[idx]] || "uncategorized" };
    }
  }
  return null;
}
