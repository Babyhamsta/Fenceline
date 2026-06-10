// Fills every .slats element with evenly distributed fence pickets.
// Count comes from data-slats (default 40). Using real elements with
// flex space-between (see brand.css) keeps pickets flush to both ends and
// perfectly even at any width — a tiled background gradient drifts and
// clips the last picket. Packaged local script: runs offline.
for (const el of document.querySelectorAll(".slats")) {
  const n = parseInt(el.dataset.slats || "40", 10);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) frag.appendChild(document.createElement("i"));
  el.replaceChildren(frag);
}
