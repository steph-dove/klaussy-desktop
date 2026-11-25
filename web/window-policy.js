// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// The decisions web/helper.js makes about windows and the tabs that show them,
// kept free of server state so test/util/web-window-policy.test.js covers them.

// The renderer pages a window can load; each is served with the bridge injected.
const PAGES = new Set(['index.html', 'popout.html', 'pr-review.html', 'preferences.html']);

// The page a window shows: the one it loaded, or the main app for a window that
// hasn't loaded one. null for a page the helper doesn't serve, which must never
// be shown as the main app.
function pageFor(file) {
  if (file == null) return 'index.html';
  return PAGES.has(file) ? file : null;
}

const GRACE_MS = {
  closingPopout: 4000,     // a pop-out tab that's going away: the app should see it closed soon
  closingWindow: 15000,    // a full app window: covers a reload
  dropped: 10 * 60 * 1000, // the page didn't say it was leaving: sleep, a throttled tab, a blip
};

// How long a window waits for its tab to come back before it closes. Only a
// page that said it's unloading gets the short wait; a dropped socket keeps
// the window, so the tab rebinds to it rather than to a fresh one.
function graceFor(page, tabUnloading) {
  if (!tabUnloading) return GRACE_MS.dropped;
  return page === 'index.html' ? GRACE_MS.closingWindow : GRACE_MS.closingPopout;
}

// Whether the helper should ask a tab to open one for this window. Not for the
// main window, one a tab already shows, one a tab has just reserved through
// /__bind (it's that tab's), or a page the helper can't serve.
function needsTab({ hasTab, isMain, reserved, page }) {
  return !hasTab && !isMain && !reserved && page != null;
}

// Which tab opens it: the one in use, else the one most recently used. A tab
// that only polls in the background never counts as in use, since window.open
// there has no click to ride on and gets blocked.
function pickOpener(candidates, focusedId) {
  if (!candidates.length) return null;
  const focused = candidates.find((c) => c.id === focusedId);
  if (focused) return focused;
  return candidates.reduce((a, b) => ((b.lastActive || 0) > (a.lastActive || 0) ? b : a));
}

module.exports = { PAGES, pageFor, GRACE_MS, graceFor, needsTab, pickOpener };
