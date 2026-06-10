// Block page logic. Edit freely — anything you can do in vanilla JS works
// here, but keep it offline-capable (no CDN scripts).

const params = new URLSearchParams(location.search);
const domain = params.get("d") || "unknown";
const category = params.get("c") || "uncategorized";

document.getElementById("domain").textContent = domain;
document.getElementById("category").textContent = category;

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
