// Configuration = built-in defaults, overridden by chrome.storage.managed
// (pushed from Google Admin console per-OU). Students cannot modify
// managed storage; it is the admin control channel.

export const DEFAULTS = {
  // Base URL of the published list artifacts (your GitHub Pages site).
  // Override per-district via managed policy.
  listBaseUrl: "https://babyhamsta.github.io/Fenceline/lists",

  // How often to check meta.json for a new list version (cheap: ~1 KB,
  // served with ETag so unchanged checks are 304s).
  checkIntervalHours: 12,

  // Even if the list version changed, don't re-download the full
  // artifacts (tens of MB at multi-million-domain scale) more often than
  // this. Keeps fleet bandwidth inside GitHub Pages' 100 GB/month soft cap.
  minDaysBetweenFullSync: 7,

  // Also block iframes from blocked domains embedded in allowed pages.
  blockSubframes: true,

  // Tier 3: the on-device content classifier. After a page loads, its rendered
  // text is scored and the page is blocked if a blocked category clears the
  // confidence threshold. Catches sites the lists miss. Admin can disable, or
  // override the model's built-in threshold (null = use the model's own).
  contentModelEnabled: true,
  contentModelThreshold: null,

  // District allow/deny overrides (domains, subdomains included).
  allowDomains: [],
  extraBlockDomains: [],

  // Extra block-the-page-never-pin-the-origin hosts, merged on top of the synced
  // baseline. For shared/path-multitenant hosts a district runs (an internal
  // archive, a CDN) that should be blocked per-page but never pinned/over-blocked.
  extraNoPinHosts: [],

  // Report page controls.
  allowClearLogs: false,
  allowExport: true,

  // Block page branding.
  schoolName: "",
  supportContact: "",
  blockMessage: ""
};

export async function getConfig() {
  let managed = {};
  try {
    managed = await chrome.storage.managed.get(null);
  } catch (e) {
    // Unmanaged device (dev/testing) — defaults apply.
  }
  const cfg = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    if (managed[k] !== undefined && managed[k] !== null) cfg[k] = managed[k];
  }
  // Normalize
  cfg.listBaseUrl = String(cfg.listBaseUrl).replace(/\/+$/, "");
  cfg.allowDomains = (cfg.allowDomains || []).map((d) => String(d).toLowerCase().trim()).filter(Boolean);
  cfg.extraBlockDomains = (cfg.extraBlockDomains || []).map((d) => String(d).toLowerCase().trim()).filter(Boolean);
  cfg.extraNoPinHosts = (cfg.extraNoPinHosts || []).map((d) => String(d).toLowerCase().trim()).filter(Boolean);
  return cfg;
}
