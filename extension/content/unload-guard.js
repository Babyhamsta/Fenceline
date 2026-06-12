// Runs in the page's MAIN world at document_start — BEFORE any page script — so
// this capturing beforeunload listener is registered first. Normally it does
// nothing (legit "unsaved changes" prompts work everywhere). But when the
// service worker is force-blocking this page, it sets __fenceline_suppress, and
// because we run first, stopImmediatePropagation prevents the page's own
// beforeunload handlers from running — so a proxy can't pop a "Leave site?"
// trap to veto the block.
(() => {
  if (window.__fenceline_unload_guard) return;
  window.__fenceline_unload_guard = true;
  window.__fenceline_suppress = false;
  window.addEventListener(
    "beforeunload",
    (e) => {
      if (window.__fenceline_suppress) {
        e.stopImmediatePropagation();
        try {
          delete e.returnValue;
        } catch (x) {}
      }
    },
    true
  );
})();
