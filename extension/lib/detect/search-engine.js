// Search-engine Layer-3 exemption: don't run the CONTENT MODEL on a real search
// engine's results/home page. A SERP and a malicious link-hub are structurally
// identical — both high link-density, thin prose, carrying whatever vocabulary
// the user typed — so they are provably unseparable by our other signals, and a
// real SERP renders as a bot wall when fetched headless, so it can't be learned
// offline. Enumeration is the only reliable cut, and the set is bounded (it
// never grows). Google "unblocked games proxy" scoring proxy-bypass 0.96 is the
// motivating false positive.
//
// This exempts the content model ONLY. Layers 1/2 (lists/tail) and Layer 4 (the
// behavioural proxy-URL detector) still fire — so translate.google.com/?u=<proxy>
// and any URL-embedding link are still blocked. Two guards keep the hole small:
//   - exact host match (no suffix), so translate./cache./webcache subdomains are
//     NOT exempt — only the search hosts themselves, and
//   - path-scoped to the SERP/home paths, so a path-based proxy mounted on a
//     search host wouldn't be covered.
//
// Mirrored in classifier/decision.py:is_search_engine_serp.

const ENGINES = [
  { hosts: ["google.com", "www.google.com"], serp: ["/", "/search"] },
  { hosts: ["bing.com", "www.bing.com"], serp: ["/", "/search"] },
  { hosts: ["duckduckgo.com"], serp: ["/", "/html", "/lite"] },
  { hosts: ["search.brave.com"], serp: ["/", "/search"] },
  {
    hosts: ["startpage.com", "www.startpage.com"],
    serp: ["/", "/sp/search", "/do/search", "/do/dsearch"]
  },
  { hosts: ["ecosia.org", "www.ecosia.org"], serp: ["/", "/search"] },
  { hosts: ["search.yahoo.com"], serp: ["/", "/search"] },
  { hosts: ["yandex.com", "www.yandex.com"], serp: ["/", "/search"] }
];

export function isSearchEngineSerp(hostname, pathname) {
  const h = (hostname || "").toLowerCase();
  const p = (pathname || "/").toLowerCase();
  for (const e of ENGINES) {
    if (!e.hosts.includes(h)) continue;
    // "/" matches the homepage exactly; a prefix matches the path itself or any
    // sub-path under it (/search, /search/...), never a longer sibling.
    return e.serp.some((s) => (s === "/" ? p === "/" : p === s || p.startsWith(s + "/")));
  }
  return false;
}
