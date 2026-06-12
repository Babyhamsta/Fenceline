function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

function fmtDate(ts) {
  return ts ? new Date(ts).toLocaleString() : "never";
}

function esc(s) {
  const d = document.createElement("span");
  d.textContent = s;
  return d.innerHTML;
}

const SRC_LABEL = {
  list: "URL filter",
  model: "Content model",
  "district-policy": "District policy"
};
const srcLabel = (s) => SRC_LABEL[s] || s || "URL filter";

let statsCache = { total: 0, byCategory: {}, byDomain: {}, byDay: {} };
let eventsCache = [];
let cfgCache = {};

async function render() {
  const status = await send({ type: "status" });
  const st = await chrome.storage.local.get(["stats", "events"]);
  statsCache = st.stats || statsCache;
  eventsCache = st.events || [];
  cfgCache = (status && status.config) || {};

  // Status panel
  document.getElementById("st-version").textContent = (status.listVersion || "—").slice(0, 12);
  document.getElementById("st-domains").textContent = status.listTotal
    ? status.listTotal.toLocaleString()
    : "no list yet";
  document.getElementById("st-generated").textContent = status.listGenerated
    ? new Date(status.listGenerated).toLocaleDateString()
    : "—";
  document.getElementById("st-sync").textContent = fmtDate(status.lastFullSync);
  document.getElementById("st-engine").textContent = status.ready ? "active" : "not loaded";
  document.getElementById("st-model").textContent = !status.modelEnabled
    ? "disabled by policy"
    : status.modelReady
      ? "active · v" + String(status.modelVersion || "—").slice(0, 8)
      : "not loaded";
  document.getElementById("st-total").textContent = (statsCache.total || 0).toLocaleString();

  // Policy-gated controls
  document.getElementById("clear").hidden = !cfgCache.allowClearLogs;
  const exportAllowed = cfgCache.allowExport !== false;
  document.getElementById("export-csv").disabled = !exportAllowed;
  document.getElementById("export-json").disabled = !exportAllowed;

  // Category bars
  const cats = Object.entries(statsCache.byCategory || {}).sort((a, b) => b[1] - a[1]);
  const barWrap = document.getElementById("cat-bars");
  if (!cats.length) {
    barWrap.innerHTML = '<p class="empty">No blocks recorded yet.</p>';
  } else {
    const max = cats[0][1];
    barWrap.innerHTML = cats
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

  // Blocks by source (URL filter vs content model vs policy)
  const srcs = Object.entries(statsCache.bySource || {}).sort((a, b) => b[1] - a[1]);
  const srcWrap = document.getElementById("src-bars");
  if (!srcs.length) {
    srcWrap.innerHTML = '<p class="empty">No blocks recorded yet.</p>';
  } else {
    const smax = srcs[0][1];
    srcWrap.innerHTML = srcs
      .map(
        ([name, n]) => `
      <div class="bar-row">
        <span class="bar-label">${esc(srcLabel(name))}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${(n / smax) * 100}%"></span></span>
        <span class="bar-count">${n.toLocaleString()}</span>
      </div>`
      )
      .join("");
  }

  // Daily activity (last 30 days)
  const daily = document.getElementById("daily");
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const byCat = (statsCache.byDay || {})[d] || {};
    days.push({ d, n: Object.values(byCat).reduce((a, b) => a + b, 0) });
  }
  const dmax = Math.max(1, ...days.map((x) => x.n));
  daily.innerHTML = days
    .map(
      (x) =>
        `<div class="day" style="height:${Math.max(2, (x.n / dmax) * 100)}%" data-tip="${x.d}: ${x.n}"></div>`
    )
    .join("");

  // Top domains
  const top = Object.entries(statsCache.byDomain || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25);
  document.querySelector("#top-domains tbody").innerHTML = top.length
    ? top
        .map(([d, n]) => `<tr><td class="mono">${esc(d)}</td><td class="count">${n.toLocaleString()}</td></tr>`)
        .join("")
    : '<tr><td colspan="2" class="empty">Nothing yet.</td></tr>';

  // Recent events
  const recent = eventsCache.slice(-50).reverse();
  document.querySelector("#recent tbody").innerHTML = recent.length
    ? recent
        .map(
          (e) =>
            `<tr><td>${new Date(e.t).toLocaleString()}</td><td class="mono">${esc(e.d)}</td><td>${esc(e.c)}</td><td>${esc(srcLabel(e.s))}</td></tr>`
        )
        .join("")
    : '<tr><td colspan="4" class="empty">Nothing yet.</td></tr>';
}

function download(name, mime, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

document.getElementById("export-csv").addEventListener("click", () => {
  const lines = ["timestamp,domain,category,blocked_by"];
  for (const e of eventsCache) {
    lines.push(
      `${new Date(e.t).toISOString()},"${e.d.replace(/"/g, '""')}","${e.c.replace(/"/g, '""')}","${srcLabel(e.s)}"`
    );
  }
  lines.push("", "blocked_by,total_blocks");
  for (const [s, n] of Object.entries(statsCache.bySource || {}).sort((a, b) => b[1] - a[1])) {
    lines.push(`"${srcLabel(s)}",${n}`);
  }
  lines.push("", "domain,total_blocks");
  for (const [d, n] of Object.entries(statsCache.byDomain || {}).sort((a, b) => b[1] - a[1])) {
    lines.push(`"${d.replace(/"/g, '""')}",${n}`);
  }
  lines.push("", "category,total_blocks");
  for (const [c, n] of Object.entries(statsCache.byCategory || {}).sort((a, b) => b[1] - a[1])) {
    lines.push(`"${c.replace(/"/g, '""')}",${n}`);
  }
  download(`fenceline-report-${new Date().toISOString().slice(0, 10)}.csv`, "text/csv", lines.join("\n"));
});

document.getElementById("export-json").addEventListener("click", () => {
  download(
    `fenceline-report-${new Date().toISOString().slice(0, 10)}.json`,
    "application/json",
    JSON.stringify({ exported: new Date().toISOString(), stats: statsCache, recentEvents: eventsCache }, null, 2)
  );
});

document.getElementById("clear").addEventListener("click", async () => {
  if (!confirm("Clear all block logs on this device?")) return;
  const res = await send({ type: "clearLogs" });
  if (!res.ok) alert(res.error);
  render();
});

document.getElementById("force-sync").addEventListener("click", async () => {
  const btn = document.getElementById("force-sync");
  const msgEl = document.getElementById("sync-msg");
  btn.disabled = true;
  msgEl.textContent = "Checking…";
  try {
    const res = await send({ type: "forceSync" });
    msgEl.textContent = res.synced
      ? `Updated to ${String(res.version).slice(0, 12)} (${res.total.toLocaleString()} domains).`
      : res.reason === "cooldown"
        ? `Just checked — try again in ${res.retryInSec}s.`
        : res.error
          ? `Failed: ${res.error}`
          : `No update applied (${res.reason}).`;
    render();
  } finally {
    btn.disabled = false;
  }
});

render();
