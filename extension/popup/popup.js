import { relTime, todayCount } from "./format.js";

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

function esc(s) {
  const d = document.createElement("span");
  d.textContent = s;
  return d.innerHTML;
}

async function render() {
  const status = (await send({ type: "status" })) || {};
  const { stats = {} } = await chrome.storage.local.get(["stats"]);
  const now = Date.now();

  // Engine status dot
  const engine = document.getElementById("engine");
  engine.className = status.ready ? "dot ok" : "dot";
  engine.textContent = status.ready ? "active" : "not loaded";

  // Big numbers
  const today = todayCount(stats, new Date().toISOString().slice(0, 10));
  document.getElementById("today").textContent = today.toLocaleString();
  document.getElementById("total").textContent = (stats.total || 0).toLocaleString();

  // Top 3 categories
  const cats = Object.entries(stats.byCategory || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  const wrap = document.getElementById("cat-bars");
  if (!cats.length) {
    wrap.innerHTML = '<p class="empty">No blocks yet.</p>';
  } else {
    const max = cats[0][1];
    wrap.innerHTML = cats
      .map(
        ([name, n]) => `
      <div class="bar-row">
        <span class="bar-label">${esc(name)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${(n / max) * 100}%"></span></span>
        <span class="bar-count">${n.toLocaleString()}</span>
      </div>`
      )
      .join("");
  }

  // Sync block
  document.getElementById("version").textContent = status.listVersion
    ? String(status.listVersion).slice(0, 12)
    : "—";
  document.getElementById("domains").textContent = status.listTotal
    ? status.listTotal.toLocaleString()
    : "no list yet";

  const ls = document.getElementById("lastsync");
  ls.textContent = relTime(status.lastFullSync, now);
  ls.title = status.lastFullSync ? new Date(status.lastFullSync).toLocaleString() : "";

  const lc = document.getElementById("lastcheck");
  lc.textContent = relTime(status.lastCheck, now);
  lc.title = status.lastCheck ? new Date(status.lastCheck).toLocaleString() : "";
}

document.getElementById("report").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

render();
