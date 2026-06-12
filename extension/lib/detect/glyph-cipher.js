// Tier 3b: glyph-cipher (font-substitution) obfuscation -------------------
// Some proxies (e.g. DaydreamX's font obfuscator) defeat the content model by
// replacing every character in the DOM with a mapped character from a DIFFERENT
// Unicode script, then rendering it back to the original glyphs with a custom
// webfont. The page looks normal, but innerText is gibberish in the wrong
// script, so the model has nothing to score. We turn that against them by
// BEHAVIOUR, not names: a page that renders its text in a script contradicting
// its declared language — or in the Private Use Area, which is never legitimate
// body text — is running such a cipher. Robust because the cipher codepoints
// MUST be present in the DOM for the page to render, so a content script always
// sees them regardless of how the font/script files are named or obfuscated.
const LATIN_LANGS = new Set([
  "en",
  "es",
  "fr",
  "de",
  "pt",
  "it",
  "nl",
  "sv",
  "da",
  "no",
  "nb",
  "nn",
  "fi",
  "is",
  "pl",
  "cs",
  "sk",
  "sl",
  "hr",
  "ro",
  "hu",
  "tr",
  "et",
  "lv",
  "lt",
  "ga",
  "cy",
  "ca",
  "gl",
  "eu",
  "af",
  "sw",
  "id",
  "ms",
  "tl",
  "vi",
  "lb",
  "mt"
]);

export function langIsLatinScript(lang) {
  if (!lang) return false;
  const p = String(lang).toLowerCase().split(/[-_]/)[0];
  return LATIN_LANGS.has(p); // validated against a real list, not "anything not non-Latin"
}

export function classifyCp(cp) {
  if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return "ascii";
  if (cp >= 0x30 && cp <= 0x39) return "digit";
  if (cp < 0x80) return null; // ASCII punctuation / whitespace / control
  // Large-alphabet scripts: legit prose uses hundreds+ of distinct codepoints.
  if (
    (cp >= 0x3400 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x20000 && cp <= 0x2fa1f)
  )
    return "han";
  if (cp >= 0xac00 && cp <= 0xd7a3) return "hangul";
  // Private Use Area (icon fonts and PUA ciphers).
  if (
    (cp >= 0xe000 && cp <= 0xf8ff) ||
    (cp >= 0xf0000 && cp <= 0xffffd) ||
    (cp >= 0x100000 && cp <= 0x10fffd)
  )
    return "pua";
  if (cp >= 0x2000 && cp <= 0x206f) return null; // general punctuation
  if (cp >= 0x2190 && cp <= 0x2bff) return null; // arrows / symbols / dingbats
  if (cp >= 0x1f000 && cp <= 0x1ffff) return null; // emoji
  if (cp >= 0xfe00 && cp <= 0xfe0f) return null; // variation selectors
  return "small"; // any other non-ASCII letter (Cyrillic/Greek/Latin-Ext/Arabic/…)
}

// True if `text` is glyph-substitution-cipher obfuscation. The robust invariant
// is statistical, not script-specific: a cipher draws a long body of text from a
// fixed ≤~95-char source alphabet, so its DISTINCT codepoint count saturates
// while real prose keeps introducing new characters. `distinct*2 < count` =
// heavy repetition of a tiny alphabet — which real Han/Hangul/PUA content never
// shows. Lang-agnostic, so it can't be evaded by spoofing the lang attribute.
export function detectGlyphCipher(text, lang) {
  if (!text) return false;
  let ascii = 0,
    digit = 0,
    han = 0,
    hangul = 0,
    small = 0,
    pua = 0;
  const dHan = new Set(),
    dHangul = new Set(),
    dPua = new Set();
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    switch (classifyCp(cp)) {
      case "ascii":
        ascii++;
        break;
      case "digit":
        digit++;
        break;
      case "han":
        han++;
        dHan.add(cp);
        break;
      case "hangul":
        hangul++;
        dHangul.add(cp);
        break;
      case "pua":
        pua++;
        dPua.add(cp);
        break;
      case "small":
        small++;
        break;
    }
  }
  const nonAscii = han + hangul + small + pua;
  const total = ascii + nonAscii;
  if (total < 80) return false; // too little text to judge

  // Layer A — large-alphabet substitution (CJK ideographs / Hangul / PUA). The
  // ratio guard separates a cipher (distinct saturates ~94) from real prose
  // (distinct grows with length) at any length, and from icon fonts (each glyph
  // used ~once → fails the ratio; too few distinct → fails the >=15 floor).
  if (han >= 180 && dHan.size <= 100 && dHan.size * 2 < han && han >= 0.6 * total) return true;
  if (hangul >= 180 && dHangul.size <= 100 && dHangul.size * 2 < hangul && hangul >= 0.6 * total)
    return true;
  if (
    pua >= 150 &&
    dPua.size >= 15 &&
    dPua.size <= 100 &&
    dPua.size * 2 < pua &&
    pua >= 0.6 * total
  )
    return true;

  // Layer B — SMALL-alphabet scripts only (Cyrillic/Greek/Latin-Ext/…), where
  // distinct-count can't separate cipher from prose. Conservative lang mismatch:
  // declares a Latin-script language but renders almost entirely in a small
  // non-Latin script with no ASCII letters or digits (real foreign pages
  // sprinkle numerals and brand names). Han/Hangul/PUA are Layer A's job, so a
  // mislabeled-lang Chinese/Korean/icon page is NOT caught here.
  if (langIsLatinScript(lang) && small >= 80 && small > 0.9 * total && ascii === 0 && digit === 0)
    return true;

  return false;
}
