// FNV-1a 64-bit over ASCII (punycoded) domain strings.
// Shared by the extension and the compiler — DO NOT change without
// rebuilding all published artifacts (tail.bin is keyed on this hash).

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

export function fnv1a64(str) {
  let h = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i) & 0xff);
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

// For a hostname like "a.b.example.com", returns every suffix with >= 2
// labels: ["a.b.example.com", "b.example.com", "example.com"].
// Blocklist entries match themselves and all of their subdomains.
export function domainCandidates(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host.indexOf(".") === -1) return [];
  // Skip raw IPs — blocklists are domain-based.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) return [host];
  const labels = host.split(".");
  const out = [];
  for (let i = 0; i <= labels.length - 2; i++) {
    out.push(labels.slice(i).join("."));
  }
  return out;
}

// Binary search a sorted BigUint64Array. Returns index or -1.
export function lookupHash(sorted, h) {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = sorted[mid];
    if (v === h) return mid;
    if (v < h) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
