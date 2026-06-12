#!/usr/bin/env node
// Unit tests for the behaviour-based evasion detectors extracted from sw.js.
// Each fixture encodes a documented adversarial finding (the stress-test history
// that used to live only in code comments), so a refactor that silently regresses
// a threshold fails here instead of in the field.
//
// Run: node test/detect.mjs

import { looksLikeProxyUrl, _decodesToUrl } from "../extension/lib/detect/proxy-url.js";
import { detectGlyphCipher } from "../extension/lib/detect/glyph-cipher.js";
import { svgHasForeignObject, svgHasExecutableContent } from "../extension/lib/detect/svg-app.js";
import {
  isNoPinHost,
  pinnedHit,
  capPins,
  createPinStore,
  buildNoPinHosts,
  NO_PIN_HOSTS,
  PIN_CAP
} from "../extension/lib/pins.js";

let failures = 0;
function ok(cond, msg) {
  if (cond) {
    console.log(`  ok    ${msg}`);
  } else {
    failures++;
    console.log(`  FAIL  ${msg}`);
  }
}
function section(name) {
  console.log(`\n${name}`);
}

// ---- proxy-url --------------------------------------------------------
section("detect/proxy-url");
{
  // Scramjet percent-encoded target in the path → proxy.
  ok(
    looksLikeProxyUrl("https://cherrion.top/scramjet/https%3A%2F%2Fgamesito.com/play"),
    "Scramjet percent-encoded path → true"
  );
  // Ultraviolet / Bare base64 service path → proxy.
  const uvSeg = btoa("https://gamesito.com/index.html?play=1");
  ok(looksLikeProxyUrl(`https://prox.example/service/${uvSeg}`), "Ultraviolet base64 path → true");
  // Legit archival service embeds the target URL PLAINLY — a documented 7/7 FP.
  ok(
    !looksLikeProxyUrl("https://web.archive.org/web/2024/https://target.com/game"),
    "plain web.archive.org/.../https://target → false"
  );
  // Reader service, plain target in path.
  ok(
    !looksLikeProxyUrl("https://r.jina.ai/https://example.com/article"),
    "r.jina.ai/https://… → false"
  );
  // A long base64-ish segment that does NOT decode to a parseable URL.
  const notUrl = btoa("this is just some long opaque token not a url at all");
  ok(
    !looksLikeProxyUrl(`https://site.com/assets/${notUrl}`),
    "base64 segment that isn't a URL → false"
  );
  // Direct _decodesToUrl contract.
  ok(
    _decodesToUrl(btoa("https://gamesito.example/play/index.html")),
    "_decodesToUrl(full url) → true"
  );
  ok(!_decodesToUrl(btoa("not-a-url-payload-long-enough")), "_decodesToUrl(non-url) → false");
  ok(!_decodesToUrl("short"), "_decodesToUrl(too short) → false");
}

// ---- glyph-cipher -----------------------------------------------------
section("detect/glyph-cipher");
{
  const rep = (cps, len) => {
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCodePoint(cps[i % cps.length]);
    return s;
  };
  const range = (start, n) => Array.from({ length: n }, (_, i) => start + i);

  // Synthetic Han cipher: long text drawn from a fixed ~90-char alphabet →
  // distinct saturates, ratio guard fires.
  const hanAlphabet = range(0x4e00, 90);
  ok(detectGlyphCipher(rep(hanAlphabet, 400), "zh"), "saturated Han cipher → true");

  // Real Chinese prose: distinct count stays high relative to length.
  const hanProse = rep(range(0x4e00, 150), 200); // 150 distinct > 100 cap
  ok(!detectGlyphCipher(hanProse, "zh"), "high-distinct Han prose → false");

  // PUA icon font: many distinct glyphs, each used roughly once.
  const puaIcons = range(0xe000, 200)
    .map((cp) => String.fromCodePoint(cp))
    .join("");
  ok(!detectGlyphCipher(puaIcons, "en"), "PUA icon-font page → false");

  // Latin lang declared, body rendered entirely in Cyrillic, no ASCII/digits.
  const cyr = rep(range(0x0410, 32), 100);
  ok(detectGlyphCipher(cyr, "en"), "lang=en rendered in Cyrillic, no ASCII/digit → true");
  // One digit present → conservative Layer-B contract declines.
  ok(!detectGlyphCipher(cyr + "1", "en"), "…same with one digit present → false");

  // Too little text to judge.
  ok(!detectGlyphCipher(rep(hanAlphabet, 40), "zh"), "below 80-char floor → false");
}

// ---- svg-app ----------------------------------------------------------
section("detect/svg-app");
{
  const fo = "<svg><foreignObject></foreignObject>";
  ok(
    svgHasForeignObject(fo + "<script>alert(1)</script></svg>") &&
      svgHasExecutableContent(fo + "<script>alert(1)</script></svg>"),
    "foreignObject + bare <script> → true"
  );
  ok(
    !svgHasExecutableContent("<svg><foreignObject><div>label</div></foreignObject></svg>"),
    "Mermaid-style foreignObject, no script → not executable"
  );
  ok(
    !svgHasExecutableContent('<svg><script type="application/json">{}</script></svg>'),
    "data <script type=application/json> only → not executable"
  );
  const nsIframe = '<svg:foreignObject></svg:foreignObject><iframe src="x"></iframe>';
  ok(
    svgHasForeignObject(nsIframe) && svgHasExecutableContent(nsIframe),
    "namespaced foreignObject + <iframe> → true"
  );
  ok(
    !svgHasForeignObject("<svg><rect/><path/></svg>"),
    "plain vector art (no foreignObject) → false"
  );
}

// ---- pins -------------------------------------------------------------
section("lib/pins");
{
  // P0.4 regression: cap eviction trims the Map itself, FIFO insertion order.
  const m = new Map([
    ["a", 1],
    ["b", 2],
    ["c", 3],
    ["d", 4],
    ["e", 5]
  ]);
  capPins(m, 3);
  ok(m.size === 3, "capPins trims Map to cap");
  ok(!m.has("a") && !m.has("b") && m.has("c") && m.has("e"), "capPins evicts oldest first (FIFO)");

  // isNoPinHost suffix matching.
  ok(isNoPinHost("archive.org"), "isNoPinHost exact match");
  ok(isNoPinHost("sub.deep.archive.org"), "isNoPinHost subdomain suffix match");
  ok(!isNoPinHost("notarchive.org"), "isNoPinHost non-suffix → false");
  ok(!isNoPinHost("evil.com"), "isNoPinHost unrelated → false");

  // pinnedHit longest-suffix-first walk.
  const p1 = new Map([["example.com", { category: "games" }]]);
  ok(pinnedHit("a.b.example.com", p1) === "example.com", "pinnedHit finds registrable suffix");
  const p2 = new Map([
    ["b.example.com", {}],
    ["example.com", {}]
  ]);
  ok(
    pinnedHit("a.b.example.com", p2) === "b.example.com",
    "pinnedHit prefers most-specific suffix"
  );
  ok(pinnedHit("nothing.here", p1) === null, "pinnedHit miss → null");

  // createPinStore against a fake storage area: write-through, dedupe, no-pin skip.
  function fakeStorage(initial = {}) {
    let data = { ...initial };
    let writes = 0;
    return {
      async get() {
        return { modelPinned: data.modelPinned };
      },
      async set(obj) {
        writes++;
        Object.assign(data, obj);
      },
      current: () => data.modelPinned || {},
      writes: () => writes
    };
  }
  const fs1 = fakeStorage();
  const store = createPinStore(fs1);
  await store.pin("bad.com", "games", 0.9);
  ok(fs1.current()["bad.com"]?.category === "games", "store.pin writes through to storage");
  await store.pin("bad.com", "games", 0.9);
  ok(fs1.writes() === 1, "store.pin dedupes — no second write for same domain");
  await store.pin("sites.google.com", "games", 0.9);
  ok(!("sites.google.com" in fs1.current()), "store.pin skips NO_PIN host");

  // Cap is enforced through the store too (uses PIN_CAP).
  const fs2 = fakeStorage();
  const store2 = createPinStore(fs2);
  for (let i = 0; i < PIN_CAP + 5; i++) await store2.pin(`d${i}.com`, "games", 1);
  ok(Object.keys(fs2.current()).length === PIN_CAP, "store enforces PIN_CAP");
  ok(
    !("d0.com" in fs2.current()) && `d${PIN_CAP + 4}.com` in fs2.current(),
    "store evicts oldest, keeps newest"
  );

  // The store consults its no-pin getter live (P2.2 dynamic set).
  const fs3 = fakeStorage();
  const store3 = createPinStore(fs3, () => new Set(["internal.example"]));
  await store3.pin("internal.example", "games", 1);
  ok(!("internal.example" in fs3.current()), "store honors injected no-pin getter");
  await store3.pin("sites.google.com", "games", 1);
  ok("sites.google.com" in fs3.current(), "injected getter replaces the bundled set");
}

// ---- pins: buildNoPinHosts (P2.2 baseline + extras merge) -------------
section("lib/pins buildNoPinHosts");
{
  const fallback = buildNoPinHosts(undefined, []);
  ok(isNoPinHost("archive.org", fallback), "no synced baseline → bundled fallback");
  ok(fallback.size === NO_PIN_HOSTS.size, "fallback equals bundled set size");

  const merged = buildNoPinHosts(["foo.example"], ["bar.example"]);
  ok(merged.has("foo.example") && merged.has("bar.example"), "synced baseline ∪ extras");
  ok(!merged.has("archive.org"), "non-empty synced baseline replaces the bundled set");

  const emptyBaseline = buildNoPinHosts([], ["bar.example"]);
  ok(
    isNoPinHost("archive.org", emptyBaseline) && emptyBaseline.has("bar.example"),
    "empty baseline falls back, extras still merged"
  );

  ok(buildNoPinHosts(["UPPER.example"]).has("upper.example"), "entries lowercased");
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
