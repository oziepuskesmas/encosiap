/**
 * ENCO Mobile - Viewport, Frame Initializer & Safe Storage Polyfill
 * Dynamically adapts the extension popup frame to the user's mobile screen size.
 * In Chromium (Titanium/Kiwi/Lemur/Chrome), handles popup dimensions and full-tab mode.
 */
(function () {
  // ── 0. Storage Session Polyfill (for Titanium, Kiwi, Lemur, and older Chromium) ──
  try {
    if (typeof chrome !== "undefined" && chrome.storage) {
      if (!chrome.storage.session) {
        chrome.storage.session = chrome.storage.local;
      }
    }
  } catch (err) {
    console.warn("[ENCO] Storage session fallback polyfill warning:", err);
  }

  // ── 1. Full Tab & Side Panel Mode Detection ────────────────────
  var isPanelMode = window.location.search.indexOf("panel=true") !== -1;
  var isTabUrl = window.location.search.indexOf("tab=true") !== -1;
  var isWideScreen = window.innerWidth > 500 && window.innerHeight > 650;
  var isFullLayout = isPanelMode || isTabUrl || isWideScreen;

  if (isFullLayout) {
    var root = document.documentElement;
    if (isPanelMode) {
      root.classList.add("side-panel-mode");
      root.style.width = "100%";
      root.style.height = "100%";
      root.style.overflow = "hidden";
      function applyBodyPanel() {
        if (document.body) {
          document.body.style.width = "100%";
          document.body.style.height = "100%";
          document.body.style.overflow = "hidden";
        }
      }
      if (document.body) applyBodyPanel();
      else document.addEventListener("DOMContentLoaded", applyBodyPanel);
      return;
    } else {
      root.classList.add("full-tab-mode");
      root.style.width = "100%";
      root.style.height = "100%";
      root.style.overflow = "auto";
      function applyBodyFull() {
        if (document.body) {
          document.body.style.width = "100%";
          document.body.style.height = "100%";
          document.body.style.overflow = "auto";
        }
      }
      if (document.body) applyBodyFull();
      else document.addEventListener("DOMContentLoaded", applyBodyFull);
      return;
    }
  }

  // ── 2. Standard Popup Frame Adaptation ──────────────────────────
  try {
    var sw = (window.screen && (window.screen.availWidth || window.screen.width)) || 380;
    var sh = (window.screen && (window.screen.availHeight || window.screen.height)) || 640;

    var targetW = 390;
    if (sw > 0) {
      if (sw <= 480) {
        targetW = Math.max(Math.min(sw - 6, 430), 340);
      } else {
        targetW = 395;
      }
    }

    var targetH = 595;
    if (sh > 0) {
      if (sh <= 720) {
        targetH = Math.max(Math.min(sh - 60, 595), 520);
      } else {
        targetH = 595;
      }
    }

    var rootEl = document.documentElement;
    rootEl.style.setProperty('--popup-width', targetW + 'px');
    rootEl.style.setProperty('--popup-height', targetH + 'px');
    rootEl.style.width = targetW + 'px';
    rootEl.style.height = targetH + 'px';
    rootEl.style.overflow = 'hidden';
    rootEl.style.scrollbarWidth = 'none';

    function applyBody() {
      if (document.body) {
        document.body.style.width = '100%';
        document.body.style.height = '100%';
        document.body.style.overflow = 'hidden';
        document.body.style.scrollbarWidth = 'none';
      }
    }

    if (document.body) {
      applyBody();
    } else {
      document.addEventListener('DOMContentLoaded', applyBody);
    }
  } catch (err) {
    console.warn('[ENCO] Viewport init error:', err);
  }
})();
