// STATUS: NOT wired into the deploy rule. Measured net-harmful as a hard rule on
// the held-out set — it rescued genuine gambling marketing pages (prose + no
// cross-origin iframe) and proxy landing pages (prose + no URL box on that page),
// dropping gambling recall 0.74->0.15 and proxy 0.59->0.25 for only a 0.005
// clean-FP gain. The premise ("low link-density + paragraphs + no functional
// element = article") does not generalize past the Wikipedia case. Retained as a
// candidate SOFT feature for the Stage-2 fusion model (which can weigh it against
// the text score instead of hard-overriding), and unit-tested below as a pure
// function. Do not re-wire it as a hard block without far stronger article
// evidence (e.g. paragraph_count >> 3) and fresh validation.
//
// Generalized prose-rescue: a hard rule that overturns a content-model block
// when the page is clearly an ARTICLE about a topic rather than an instance of
// it. The lexical model scores on topic vocabulary, so a Wikipedia "Proxy
// server" article scores proxy-bypass ~0.99 — same words as a real proxy. The
// thing an article never has is the topic's FUNCTIONAL ELEMENT: a proxy's URL
// box / embedded-URL path, an adult site's video player, a casino's game frame.
//
// Rescue to clean only when ALL hold:
//   - the blocked category is one whose vocabulary collides with prose
//     (proxy/adult/gambling — NOT games: a game is thin-text + canvas, never
//     an "article", so it has no prose form to confuse),
//   - the page reads as prose: low link-density (Kohlschütter < 0.33) AND
//     several real paragraphs,
//   - it is not a full-canvas app (cherrion-style proxies render in <canvas>
//     with near-zero prose — this guard blocks that evasion), and
//   - the category's functional element is ABSENT.
//
// Mirrored in classifier/decision.py:prose_rescue so offline evaluation and the
// device agree. Load-bearing regression: croxyproxy passes both prose tests but
// has has_url_like_input → must NOT be rescued. Keep that case in the tests.

const RESCUABLE = new Set(["proxy-bypass", "adult", "gambling"]);

export function proseRescue(category, s) {
  if (!RESCUABLE.has(category) || !s) return false;
  // structural may arrive from an older content script without the new fields;
  // a missing field reads as 0/false, which fails the prose tests → no rescue
  // (fail safe: we under-rescue, i.e. keep blocking, rather than over-rescue).
  if (!(Number(s.link_density) < 0.33)) return false;
  if (!(Number(s.paragraph_count) >= 3)) return false;
  if (s.has_dominant_canvas) return false;
  // per-category functional element present ⇒ it IS the thing, never rescue
  if (category === "proxy-bypass" && (s.url_embeds_url || s.has_url_like_input)) return false;
  if (category === "adult" && s.has_video_player) return false;
  if (category === "gambling" && (s.has_large_xorigin_iframe || s.has_gambling_license_seal))
    return false;
  return true;
}
