import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../extension/content/scan.js", import.meta.url), "utf8");

function harness({ body = "", title = "Play online puzzle games in your browser", send } = {}) {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  const messages = [];
  const observations = [];
  const state = { title, body, meta: "", lang: "en", structural: { has_dominant_canvas: false } };
  let observer;
  let disconnected = false;
  const root = { getAttribute: () => state.lang };
  const win = { innerWidth: 1200, innerHeight: 900 };
  win.top = win;
  const location = { protocol: "https:", href: "https://example.test/" };
  vm.runInNewContext(source, {
    window: win,
    location,
    document: {
      documentElement: root,
      body: {
        get innerText() {
          return state.body;
        }
      },
      get title() {
        return state.title;
      },
      querySelector: () => ({ getAttribute: () => state.meta }),
      querySelectorAll: () => []
    },
    fencelineExtractStructural: () => state.structural,
    chrome: {
      runtime: {
        sendMessage: (record) => {
          messages.push({ at: now, record: JSON.parse(JSON.stringify(record)) });
          return send ? send(record) : Promise.resolve();
        }
      }
    },
    Date: { now: () => now },
    setTimeout: (fn, delay) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    MutationObserver: class {
      constructor(fn) {
        observer = fn;
      }
      observe(target, options) {
        observations.push({ target, options });
      }
      disconnect() {
        disconnected = true;
      }
    },
    addEventListener() {}
  });
  return {
    state,
    messages,
    observations,
    root,
    location,
    get disconnected() {
      return disconnected;
    },
    get pending() {
      return timers.size;
    },
    mutate() {
      if (!disconnected) observer();
    },
    async advance(ms) {
      // VM await adopts promises from this realm before resuming its callback.
      for (let i = 0; i < 4; i++) await Promise.resolve();
      const end = now + ms;
      for (;;) {
        const entry = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry || entry[1].at > end) break;
        now = entry[1].at;
        timers.delete(entry[0]);
        entry[1].fn();
        for (let i = 0; i < 4; i++) await Promise.resolve();
      }
      now = end;
      await Promise.resolve();
    }
  };
}

const page = harness();
await page.advance(1200);
assert.equal(page.messages.length, 1, "metadata-rich empty body is eligible");
assert.equal(page.messages[0].record.text, "");
assert.equal(page.observations[0].target, page.root, "watch head and body together");
for (const name of ["content", "lang", "src", "style", "type"]) {
  assert.ok(page.observations[0].options.attributeFilter.includes(name));
}
page.mutate();
await page.advance(4000);
assert.equal(page.messages.length, 1, "unchanged complete record suppressed");
for (const [field, value] of [
  ["title", "A different browser game title with words"],
  ["meta", "New description"],
  ["structural", { has_dominant_canvas: true }],
  ["lang", "es"]
]) {
  const count = page.messages.length;
  page.state[field] = value;
  page.mutate();
  await page.advance(4000);
  assert.equal(page.messages.length, count + 1, `${field} change scanned`);
}
page.location.href += "next";
page.mutate();
await page.advance(4000);
assert.equal(page.messages.at(-1).record.url, page.location.href);

const thin = harness({ title: "Home" });
await thin.advance(1200);
assert.equal(thin.messages.length, 0, "thin page still skipped");
thin.state.meta = "A complete useful description with enough words";
thin.mutate();
await thin.advance(4000);
assert.equal(thin.messages.length, 1, "later metadata can make thin page eligible");

const active = harness();
await active.advance(1200);
for (let i = 0; i < 120; i++) {
  active.state.meta = `Live update ${i}`;
  active.mutate();
  await active.advance(500);
}
assert.equal(active.messages.length, 12, "continuous mutations scan until cap");
for (let i = 1; i < active.messages.length; i++) {
  assert.ok(active.messages[i].at - active.messages[i - 1].at >= 4000, "cooldown preserved");
}
assert.equal(active.messages[1].at, 5200, "mutations do not postpone pending deadline");
assert.equal(active.messages[1].record.meta, "Live update 7", "scan sees latest content");
assert.ok(active.disconnected, "cap disconnects observer");
assert.equal(active.pending, 0, "cap clears pending timer");

let release;
const busy = harness({
  send: () =>
    new Promise((resolve) => {
      release = resolve;
    })
});
await busy.advance(1200);
busy.state.meta = "Change while sending";
busy.mutate();
await busy.advance(5000);
assert.equal(busy.messages.length, 1, "no concurrent sends");
release();
await busy.advance(1200);
assert.equal(busy.messages.length, 2, "pending work resumes after send");
release();
await busy.advance(0);

const gone = harness({ send: () => Promise.reject(new Error("context invalidated")) });
await gone.advance(1200);
assert.ok(gone.disconnected, "send failure disconnects observer");
gone.mutate();
await gone.advance(20000);
assert.equal(gone.messages.length, 1, "stopped scanner stays stopped");
assert.equal(gone.pending, 0);

console.log("Content scanner lifecycle checks passed.");
