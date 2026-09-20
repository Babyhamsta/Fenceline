import assert from "node:assert/strict";
import { storeArtifacts, getStoredVersion } from "../extension/lib/tail.js";
import { storeModel, getStoredModelVersion, modelVersion } from "../extension/lib/model.js";
import { isFusionReady, setFusion } from "../extension/lib/fusion.js";
import { checkAndSync, applyPolicyRules } from "../extension/lib/sync.js";

// A transaction fake stages writes until commit, including a late abort after
// all request success events. Production modules use their real public APIs.
const persisted = new Map();
let abortNextWrite = false;
let reads = 0;
globalThis.indexedDB = {
  open() {
    const request = {};
    queueMicrotask(() => {
      request.result = {
        close() {},
        transaction(_name, mode) {
          const operations = [];
          const tx = {
            objectStore: () => ({
              get(key) {
                const req = {};
                operations.push({ key, req });
                return req;
              },
              put(value, key) {
                const req = {};
                operations.push({ key, value, req });
                return req;
              }
            }),
            abort() {
              tx.error = new Error("aborted");
              tx.onabort?.();
            }
          };
          setTimeout(() => {
            const snapshot = new Map(persisted);
            for (const op of operations) {
              if (mode === "readwrite") snapshot.set(op.key, structuredClone(op.value));
              else {
                reads++;
                op.req.result = structuredClone(snapshot.get(op.key));
              }
              op.req.onsuccess?.();
            }
            if (mode === "readwrite" && abortNextWrite) {
              abortNextWrite = false;
              tx.abort();
              return;
            }
            if (mode === "readwrite") {
              persisted.clear();
              for (const [key, value] of snapshot) persisted.set(key, value);
            }
            tx.oncomplete?.();
          }, 0);
          return tx;
        }
      };
      request.onsuccess();
    });
    return request;
  }
};

const tailA = new BigUint64Array([1n]).buffer;
const tailB = new BigUint64Array([2n]).buffer;
const cats = new Uint8Array([0]).buffer;
await storeArtifacts(tailA, cats, ["old"], "old");
abortNextWrite = true;
await assert.rejects(storeArtifacts(tailB, cats, ["new"], "new"), /aborted/);
assert.equal(await getStoredVersion(), "old");
assert.equal(new BigUint64Array(persisted.get("tail"))[0], 1n);
assert.deepEqual(persisted.get("catNames"), ["old"]);

await storeModel(new Float32Array([1]).buffer, { version: "model-a" }, { classes: [] });
assert.equal(isFusionReady(), true);
abortNextWrite = true;
await assert.rejects(
  storeModel(new Float32Array([2]).buffer, { version: "model-b" }, null),
  /aborted/
);
assert.equal(modelVersion(), "model-a");
assert.equal(await getStoredModelVersion(), "model-a");
assert.equal(isFusionReady(), true);
await storeModel(new Float32Array([2]).buffer, { version: "model-b" }, null);
assert.equal(isFusionReady(), false);
assert.equal(persisted.get("fusion"), null);
setFusion({ classes: [] });
const coldModel = await import("../extension/lib/model.js?cold-test");
assert.equal(await coldModel.ensureModelLoaded(), true);
assert.equal(coldModel.modelVersion(), "model-b");
assert.equal(isFusionReady(), false, "cold load clears fusion absent from persisted bundle");

const local = { listVersion: "old", lastFullSync: Date.now() };
const managed = { blockSubframes: true, minDaysBetweenFullSync: 7 };
let rules = [];
let failDnr = true;
let dnrWrites = 0;
globalThis.chrome = {
  storage: {
    managed: { get: async () => managed },
    local: {
      get: async () => structuredClone(local),
      set: async (value) => Object.assign(local, structuredClone(value))
    }
  },
  declarativeNetRequest: {
    getDynamicRules: async () => structuredClone(rules),
    updateDynamicRules: async ({ removeRuleIds = [], addRules = [] }) => {
      dnrWrites++;
      if (failDnr) {
        failDnr = false;
        throw new Error("DNR failure");
      }
      rules = rules.filter((r) => !removeRuleIds.includes(r.id)).concat(structuredClone(addRules));
    }
  }
};
const chunk = [
  {
    id: 1,
    priority: 1,
    action: { type: "block" },
    condition: {
      requestDomains: ["blocked.example"],
      resourceTypes: ["main_frame", "sub_frame"]
    }
  }
];
const meta = {
  version: "new",
  categories: ["new"],
  tail: { count: 1, file: "tail.bin" },
  cats: { file: "cats.bin" },
  chunks: [{ file: "000.json", ruleIdStart: 1, maxRules: 1, sha256: null }]
};
let activeFetches = 0;
let maxActiveFetches = 0;
globalThis.fetch = async (url) => {
  activeFetches++;
  maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
  await new Promise((resolve) => setTimeout(resolve, 1));
  activeFetches--;
  return {
    ok: true,
    json: async () => structuredClone(meta),
    arrayBuffer: async () =>
      url.endsWith("tail.bin")
        ? tailB
        : url.endsWith("cats.bin")
          ? cats
          : new TextEncoder().encode(JSON.stringify(chunk)).buffer
  };
};
await assert.rejects(checkAndSync(true), /DNR failure/);
assert.equal(await getStoredVersion(), "new");
assert.equal(local.listVersion, "old");
assert.equal((await checkAndSync(false)).synced, true);
assert.equal(local.listVersion, "new");
assert.equal(rules.length, 1);

maxActiveFetches = 0;
const before = dnrWrites;
const concurrent = await Promise.all([checkAndSync(true), checkAndSync(false)]);
assert.ok(concurrent.every((r) => r.reason === "up-to-date"));
assert.equal(maxActiveFetches, 1, "overlapping checks run serially");
assert.equal(dnrWrites, before);

managed.blockSubframes = false;
await applyPolicyRules();
assert.deepEqual(rules[0].condition.resourceTypes, ["main_frame"]);
const unchangedWrites = dnrWrites;
await applyPolicyRules();
assert.equal(dnrWrites, unchangedWrites);
managed.blockSubframes = true;
await applyPolicyRules();
assert.deepEqual(rules[0].condition.resourceTypes, ["main_frame", "sub_frame"]);
assert.ok(reads > 0);
console.log(
  "artifact transactions, interrupted sync, queue, fusion reset, and policy refresh: passed"
);
