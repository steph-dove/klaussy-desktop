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
    '#5b8def', '#e05a33', '#43a047', '#ab47bc',
    '#ef6c00', '#00897b', '#d81b60', '#5c6bc0'
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

  return {
    escHtml: escHtml,
    escAttr: escAttr,
    formatAge: formatAge,
    iconColor: iconColor,
    modeShortLabel: modeShortLabel,
    modeDisplayName: modeDisplayName,
  };
})();
