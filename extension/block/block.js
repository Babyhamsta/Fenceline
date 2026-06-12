// Block page logic. Edit freely — anything you can do in vanilla JS works
// here, but keep it offline-capable (no CDN scripts).

const params = new URLSearchParams(location.search);
const domain = params.get("d") || "unknown";
const category = params.get("c") || "uncategorized";
const source = params.get("s") || "list";
const conf = params.get("conf"); // present only for model blocks (0-100)

// Human-readable explanation of what blocked the page — so a parent or admin on
// a support call can say exactly why, and read back the reference code.
const SOURCE_LABEL = {
  list: "URL filter (known blocked site)",
  model: "Content model (page contents)",
  proxy: "Web-proxy detector (circumvention tool)",
  "district-policy": "District policy"
};

document.getElementById("domain").textContent = domain;
document.getElementById("category").textContent = category;
let srcText = SOURCE_LABEL[source] || source;
if (source === "model" && conf) srcText += ` — ${conf}% confidence`;
document.getElementById("source").textContent = srcText;

// A short, time-based reference the user can read out; helps support correlate
// with the device's block log without exposing browsing history.
const now = new Date();
const ref =
  `${category[0] || "x"}${source[0]}-` +
  now.toISOString().slice(0, 16).replace(/[-:T]/g, "");
document.getElementById("reference").textContent = ref.toUpperCase();
document.getElementById("reference").title = now.toLocaleString();

document.getElementById("back").addEventListener("click", () => {
  // The blocked navigation leaves its own entry in history right before this
  // block page, so a single back() lands on the blocked URL and re-triggers
  // the block (the "two clicks" problem). Skip both entries to reach the page
  // the user was actually on.
  if (history.length > 2) history.go(-2);
  else if (history.length > 1) history.back();
  else location.href = "https://www.google.com";
});

// District branding from managed policy (optional).
chrome.runtime.sendMessage({ type: "status" }, (res) => {
  if (!res || !res.config) return;
  const { schoolName, supportContact, blockMessage } = res.config;
  if (schoolName) document.getElementById("school").textContent = schoolName;
  if (supportContact) {
    document.getElementById("contact").textContent = "Think this is a mistake? Contact " + supportContact;
  }
  if (blockMessage) document.getElementById("message").textContent = blockMessage;
});
