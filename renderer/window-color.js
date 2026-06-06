// Applies this window's accent color (set via Preferences → Window). The color
// shows as a thin top strip plus a subtle sidebar-header tint, so multiple
// windows are easy to tell apart. Source of truth lives in main; we just fetch
// our own on load and react to live changes.
(function () {
  function apply(color) {
    var root = document.documentElement;
    if (color) {
      root.style.setProperty('--window-color', color);
      document.body.classList.add('has-window-color');
    } else {
      root.style.removeProperty('--window-color');
      document.body.classList.remove('has-window-color');
    }
  }

  if (!window.klaus || !window.klaus.ui || !window.klaus.ui.getWindowColor) return;

  // macOS uses a hidden-inset native title bar (set in main/state/windows.js),
  // so the app paints its own full-width top bar. Reserve space + enable the
  // draggable bar via this class; non-mac keeps the native frame + thin strip.
  if (window.klaus.ui.platform === 'darwin') {
    document.body.classList.add('custom-titlebar');
  }

  window.klaus.ui.getWindowColor().then(apply).catch(function () {});
  window.klaus.ui.onWindowColorChanged(apply);
})();
