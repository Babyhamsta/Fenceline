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

  // Threat: the page runs AFTER this guard, so a plain `window.__fenceline_suppress`
  // property was page-defeatable — the page could
  //   Object.defineProperty(window, "__fenceline_suppress", {get:()=>false, set:()=>{}})
  // to silently re-arm its beforeunload trap and veto force-blocks. We run first
  // (MAIN world, document_start), so we win the race: back the flag with a
  // closure variable and pin the property non-configurable. The SW's
  // executeScript setter (forceReplaceTab) still writes via the setter below;
  // the page can no longer redefine the property or shadow its value.
  let suppressed = false;
  Object.defineProperty(window, "__fenceline_suppress", {
    configurable: false,
    get: () => suppressed,
    set: (v) => {
      suppressed = !!v;
    }
  });

  window.addEventListener(
    "beforeunload",
    (e) => {
      if (suppressed) {
        e.stopImmediatePropagation();
        try {
          delete e.returnValue;
        } catch (x) {}
      }
    },
    true
  );
})();
