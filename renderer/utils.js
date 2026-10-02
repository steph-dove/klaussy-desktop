window.AppUtils = (function () {
  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Stricter escape for values interpolated into HTML attributes. Same rules
  // as escHtml for now; kept distinct so callers can signal intent and so we
  // can harden attribute-only rules (e.g. backtick) without touching text.
  function escAttr(s) {
    return escHtml(s);
  }

  function formatAge(isoString) {
    if (!isoString) return '';
    var ms = Date.now() - new Date(isoString).getTime();
    var mins = Math.floor(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    var days = Math.floor(hrs / 24);
    return days + 'd ago';
  }

  var _iconColors = [
    '#2f6eeb', '#d04720', '#38853b', '#ab47bc',
    '#bf5600', '#008476', '#d81b60', '#5c6bc0'
  ];
  function iconColor(name) {
    var hash = 0;
    for (var i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    return _iconColors[Math.abs(hash) % _iconColors.length];
  }

  // ---- AI provider labels (single source: preload's static provider list) ----
  // mode is a provider id ('claude' | 'codex' | 'gemini' | 'copilot') or
  // 'shell'. Falls back gracefully if the preload bridge isn't ready.
  function _providers() {
    return (window.klaus && window.klaus.ui && window.klaus.ui.providers) || [];
  }
  function modeShortLabel(mode) {
    if (mode === 'shell') return 'sh';
    var p = _providers().find(function (x) { return x.id === mode; });
    return p ? p.shortLabel : 'cc';
  }
  function modeDisplayName(mode) {
    if (mode === 'shell') return 'Shell';
    var p = _providers().find(function (x) { return x.id === mode; });
    return p ? p.displayName : (mode || 'Agent');
  }

  // No default-provider fallback here, unlike the sidebar's Resume target: that
  // would label a deliberately-opened shell with an agent that never ran.
  function exitedAgent(task) {
    if (!task || task.mode !== 'shell') return null;
    var prior = task.resumeAgent;
    return (prior && prior !== 'shell') ? prior : null;
  }

  function isMac() {
    var p = window.klaus && window.klaus.ui && window.klaus.ui.platform;
    return p ? p === 'darwin' : /Mac/.test(navigator.platform);
  }

  // Mac matches e.key so layouts where the key moves still work; elsewhere Shift rewrites e.key, so match the physical code.
  var KEY_CHARS = { Slash: ['/'], Equal: ['=', '+'], Minus: ['-'], Digit0: ['0'] };

  // Ctrl+Shift off macOS because plain Ctrl+<letter> belongs to the shell, so opts.shift only matters on macOS.
  function isAppShortcut(e, key, opts) {
    if (e.altKey) return false;
    var mac = isMac();
    var mod = mac ? (e.metaKey && !e.ctrlKey) : (e.ctrlKey && e.shiftKey && !e.metaKey);
    if (!mod) return false;
    if (mac && opts && typeof opts.shift === 'boolean' && !!e.shiftKey !== opts.shift) return false;
    if (key.length > 1) return mac ? KEY_CHARS[key].indexOf(e.key) !== -1 : e.code === key;
    return (e.key || '').toLowerCase() === key;
  }

  var CODE_LABELS = { Slash: '/', Equal: '=', Minus: '\u2212', Digit0: '0' };
  function shortcutLabel(key) {
    var k = CODE_LABELS[key] || key.toUpperCase();
    return isMac() ? '\u2318' + k : 'Ctrl+Shift+' + k;
  }

  // Handled in app.js; terminals must not forward these to the shell.
  var APP_SHORTCUTS = {
    palette: { key: 'k', shift: false },
    quickOpen: { key: 'p', shift: false },
    slash: { key: 'Slash' },
    diff: { key: 'g' },
  };

  function isNamedShortcut(e, name) {
    var s = APP_SHORTCUTS[name];
    return isAppShortcut(e, s.key, s);
  }

  function isAnyAppShortcut(e) {
    return Object.keys(APP_SHORTCUTS).some(function (name) { return isNamedShortcut(e, name); });
  }

  function appShortcutLabel(name) {
    return shortcutLabel(APP_SHORTCUTS[name].key);
  }

  // Elsewhere the shell's own Ctrl+L clears.
  function isClearShortcut(e) {
    return isMac() && isAppShortcut(e, 'k', { shift: true });
  }

  function clearShortcutLabel() {
    return isMac() ? '\u2318\u21e7K' : 'Ctrl+L';
  }

  // Stands in for window.prompt(), which Electron doesn't implement; resolves to the values or null.
  function promptDialog(opts) {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'klaus-modal-overlay';
      var html = '<div class="klaus-modal"><h3>' + escHtml(opts.title) + '</h3>';
      opts.fields.forEach(function (f, i) {
        var id = 'prompt-dialog-field-' + i;
        html += '<label class="prompt-dialog-label" for="' + id + '">' + escHtml(f.label) + '</label>'
          + (f.multiline
            ? '<textarea id="' + id + '" class="prompt-dialog-input" rows="4"></textarea>'
            : '<input id="' + id + '" class="prompt-dialog-input" type="text" autocomplete="off" spellcheck="false">');
      });
      html += '<div class="klaus-modal-actions">'
        + '<button type="button" class="klaus-btn klaus-btn-ghost" data-dialog-close>Cancel</button>'
        + '<button type="button" class="klaus-btn klaus-btn-primary prompt-dialog-ok">' + escHtml(opts.okLabel || 'OK') + '</button>'
        + '</div></div>';
      overlay.innerHTML = html;
      var inputs = Array.prototype.slice.call(overlay.querySelectorAll('.prompt-dialog-input'));

      function finish(values) {
        overlay.remove();
        resolve(values);
      }
      function submit() {
        var values = inputs.map(function (el) { return el.value.trim(); });
        var missing = opts.fields.findIndex(function (f, i) { return f.required && !values[i]; });
        if (missing >= 0) {
          inputs[missing].setAttribute('aria-invalid', 'true');
          inputs[missing].focus();
          return;
        }
        finish(values);
      }
      overlay.querySelector('[data-dialog-close]').addEventListener('click', function () { finish(null); });
      overlay.querySelector('.prompt-dialog-ok').addEventListener('click', submit);
      overlay.addEventListener('click', function (e) { if (e.target === overlay) finish(null); });
      overlay.addEventListener('keydown', function (e) {
        var multiline = e.target.tagName === 'TEXTAREA';
        if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey) && e.target.classList.contains('prompt-dialog-input')) {
          e.preventDefault();
          submit();
        }
      });
      document.body.appendChild(overlay);
      inputs[0].focus();
    });
  }

  function screenReaderMode(prefs) {
    return !!(prefs && (prefs.screenReaderMode || prefs.screenReaderActive));
  }

  return {
    screenReaderMode: screenReaderMode,
    promptDialog: promptDialog,
    isMac: isMac,
    isAppShortcut: isAppShortcut,
    shortcutLabel: shortcutLabel,
    isNamedShortcut: isNamedShortcut,
    isAnyAppShortcut: isAnyAppShortcut,
    appShortcutLabel: appShortcutLabel,
    isClearShortcut: isClearShortcut,
    clearShortcutLabel: clearShortcutLabel,
    escHtml: escHtml,
    escAttr: escAttr,
    formatAge: formatAge,
    iconColor: iconColor,
    modeShortLabel: modeShortLabel,
    modeDisplayName: modeDisplayName,
    exitedAgent: exitedAgent,
  };
})();
