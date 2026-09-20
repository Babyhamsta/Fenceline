import assert from "node:assert/strict";
import { createPinStore } from "../extension/lib/pins.js";
import { recordBlock, flushNow, resetCache, clearLogs } from "../extension/lib/log.js";

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Cold-start callers share hydration and persistence preserves insertion order.
{
  const read = deferred();
  const firstWrite = deferred();
  const writeStarted = deferred();
  let reads = 0;
  let writes = 0;
  let stored;
  const exclusions = new Set();
  const pins = createPinStore(
    {
      get() {
        reads++;
        return read.promise;
      },
      async set(value) {
        writes++;
        if (writes === 1) {
          writeStarted.resolve();
          await firstWrite.promise;
        }
        stored = structuredClone(value);
      }
    },
    () => exclusions
  );
  const a = pins.pin("a.example", "games", 1);
  const b = pins.pin("b.example", "games", 1);
  assert.equal(reads, 1);
  read.resolve({});
  await writeStarted.promise;
  assert.equal(writes, 1);
  firstWrite.resolve();
  await Promise.all([a, b]);
  assert.deepEqual(Object.keys(stored.modelPinned), ["a.example", "b.example"]);
  assert.equal(pins.hit("sub.a.example"), "a.example");
  exclusions.add("a.example");
  assert.equal(pins.hit("sub.a.example"), null);
  assert.equal(pins.hit("b.example"), "b.example");
  exclusions.add("sub.b.example");
  assert.equal(pins.hit("sub.b.example"), null);
  assert.equal(pins.hit("b.example"), "b.example");
}

// Failed hydration remains retryable.
{
  let attempts = 0;
  const pins = createPinStore({
    async get() {
      if (++attempts === 1) throw new Error("read failed");
      return {};
    },
    async set() {}
  });
  await assert.rejects(pins.load(), /read failed/);
  await pins.pin("retry.example", "games", 1);
  assert.equal(pins.hit("retry.example"), "retry.example");
}

let stored = {};
let reads = 0;
let readGate = null;
let writeGate = null;
let writeStarted = null;
globalThis.chrome = {
  storage: {
    local: {
      async get() {
        reads++;
        const snapshot = structuredClone(stored);
        if (readGate) await readGate.promise;
        return snapshot;
      },
      async set(value) {
        writeStarted?.resolve();
        if (writeGate) await writeGate.promise;
        Object.assign(stored, structuredClone(value));
      },
      async remove(keys) {
        for (const key of keys) delete stored[key];
      }
    }
  }
};

resetCache();
readGate = deferred();
const a = recordBlock("a.example", "games");
const b = recordBlock("b.example", "adult");
assert.equal(reads, 1);
readGate.resolve();
await Promise.all([a, b]);
readGate = null;
await flushNow();
assert.equal(stored.stats.total, 2);
assert.deepEqual(
  stored.events.map((e) => e.d),
  ["a.example", "b.example"]
);

// Clearing while a stale read is outstanding must not resurrect counters.
resetCache();
readGate = deferred();
const oldRecord = recordBlock("old.example", "games");
await clearLogs();
readGate.resolve();
await oldRecord;
readGate = null;
await recordBlock("new.example", "games");
await flushNow();
assert.equal(stored.stats.total, 1);
assert.deepEqual(
  stored.events.map((e) => e.d),
  ["new.example"]
);

// An in-flight write completes before removal; post-clear events start fresh.
await recordBlock("before.example", "games");
writeGate = deferred();
writeStarted = deferred();
const flush = flushNow();
await writeStarted.promise;
const clear = clearLogs();
const after = recordBlock("after.example", "games");
writeGate.resolve();
await Promise.all([flush, clear, after]);
writeGate = null;
await flushNow();
assert.equal(stored.stats.total, 1);
assert.deepEqual(
  stored.events.map((e) => e.d),
  ["after.example"]
);
resetCache();
console.log("Storage concurrency and clear regressions passed.");
