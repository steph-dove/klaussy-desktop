(async function () {
  var prefs = await window.klaus.ui.getPreferences();

  // Theme options (mirror theme.js presets)
  var themes = [
    { id: 'system', name: 'Match System' },
    { id: 'dark', name: 'Dark' },
    { id: 'midnight', name: 'Midnight' },
    { id: 'monokai', name: 'Monokai' },
    { id: 'nord', name: 'Nord' },
    { id: 'solarized', name: 'Solarized' },
    { id: 'rose', name: 'Rose Pine' },
    { id: 'light', name: 'Light' },
  ];

  // Default keybindings
  var defaultBindings = {
    'newTask': { label: 'New Task', default: 'CmdOrCtrl+T' },
    'toggleDiff': { label: 'Toggle Diff Panel', default: 'CmdOrCtrl+G' },
    'search': { label: 'Search in Terminal', default: 'CmdOrCtrl+F' },
    'zoomIn': { label: 'Zoom In', default: 'CmdOrCtrl+=' },
    'zoomOut': { label: 'Zoom Out', default: 'CmdOrCtrl+-' },
    'zoomReset': { label: 'Reset Zoom', default: 'CmdOrCtrl+0' },
    'clearTerminal': { label: 'Clear Terminal', default: 'CmdOrCtrl+K' },
  };

  // ---- Populate fields ----

  var fontFamily = document.getElementById('pref-font-family');
  var fontSize = document.getElementById('pref-font-size');
  var lineHeight = document.getElementById('pref-line-height');
  var cursorStyle = document.getElementById('pref-cursor-style');
  var themeSelect = document.getElementById('pref-theme');
  var claudePath = document.getElementById('pref-claude-path');
  var defaultMode = document.getElementById('pref-default-mode');
  var autoFetch = document.getElementById('pref-auto-fetch');
  var statusMsg = document.getElementById('status-msg');

  // Per-agent path inputs, keyed by provider id → { input, infoEl, prefKey }.
  var agentPaths = {
    claude: { input: claudePath, infoEl: document.getElementById('agent-info-claude'), prefKey: 'claudePath' },
    codex: { input: document.getElementById('pref-codex-path'), infoEl: document.getElementById('agent-info-codex'), prefKey: 'codexPath' },
    gemini: { input: document.getElementById('pref-gemini-path'), infoEl: document.getElementById('agent-info-gemini'), prefKey: 'geminiPath' },
    copilot: { input: document.getElementById('pref-copilot-path'), infoEl: document.getElementById('agent-info-copilot'), prefKey: 'copilotPath' },
  };

  fontFamily.value = prefs.fontFamily;
  fontSize.value = prefs.fontSize;
  lineHeight.value = prefs.lineHeight;
  cursorStyle.value = prefs.cursorStyle;
  Object.keys(agentPaths).forEach(function (id) {
    agentPaths[id].input.value = prefs[agentPaths[id].prefKey] || '';
  });
  defaultMode.value = prefs.defaultProvider || prefs.defaultMode || 'claude';
  autoFetch.value = Math.round((prefs.autoFetchInterval || 60000) / 1000);
  document.getElementById('pref-precommit-review').checked = prefs.preCommitReview !== false;
  document.getElementById('pref-repo-intel-enrich').checked = prefs.repoIntelEnrich === true;

  // Theme dropdown
  themes.forEach(function (t) {
    var opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    themeSelect.appendChild(opt);
  });
  themeSelect.value = prefs.theme.preset || 'dark';

  // Per-agent version probes
  Object.keys(agentPaths).forEach(loadAgentInfo);

  async function loadAgentInfo(id) {
    var infoEl = agentPaths[id].infoEl;
    if (!infoEl) return;
    infoEl.innerHTML = 'Status: <span class="version">checking…</span>';
    var info = await window.klaus.ui.getAgentInfo(id);
    if (!info || info.version === 'not found') {
      infoEl.innerHTML = 'Status: <span class="not-found">not found</span>';
    } else {
      infoEl.innerHTML = 'Status: <span class="version">' + escHtml(info.version) + '</span>';
    }
  }

  // ---- Keybindings ----

  var keybindingsBody = document.getElementById('keybindings-body');
  var userBindings = prefs.keybindings || {};

  Object.keys(defaultBindings).forEach(function (action) {
    var def = defaultBindings[action];
    var current = userBindings[action] || def.default;

    var tr = document.createElement('tr');
    var tdLabel = document.createElement('td');
    tdLabel.textContent = def.label;

    var tdKey = document.createElement('td');
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'key-input';
    input.readOnly = true;
    input.value = formatBinding(current);
    input.dataset.action = action;
    input.dataset.binding = current;

    input.addEventListener('click', function () {
      startRecording(input, action);
    });

    tdKey.appendChild(input);
    tr.appendChild(tdLabel);
    tr.appendChild(tdKey);
    keybindingsBody.appendChild(tr);
  });

  var recordingInput = null;

  function startRecording(input, action) {
    if (recordingInput) {
      recordingInput.classList.remove('recording');
      recordingInput.value = formatBinding(recordingInput.dataset.binding);
    }
    recordingInput = input;
    input.classList.add('recording');
    input.value = 'Press keys...';

    function onKeyDown(e) {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        input.classList.remove('recording');
        input.value = formatBinding(input.dataset.binding);
        recordingInput = null;
        document.removeEventListener('keydown', onKeyDown, true);
        return;
      }

      // Ignore bare modifier keys
      if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;

      var parts = [];
      if (e.metaKey) parts.push('CmdOrCtrl');
      else if (e.ctrlKey) parts.push('CmdOrCtrl');
      if (e.altKey) parts.push('Alt');
      if (e.shiftKey) parts.push('Shift');

      var key = e.key;
      if (key === ' ') key = 'Space';
      else if (key.length === 1) key = key.toUpperCase();
      parts.push(key);

      var binding = parts.join('+');
      input.dataset.binding = binding;
      input.value = formatBinding(binding);
      input.classList.remove('recording');
      recordingInput = null;
      document.removeEventListener('keydown', onKeyDown, true);

      saveAll();
    }

    document.addEventListener('keydown', onKeyDown, true);
  }

  function formatBinding(binding) {
    if (!binding) return '';
    return binding
      .replace(/CmdOrCtrl/g, navigator.platform.includes('Mac') ? '\u2318' : 'Ctrl')
      .replace(/Alt/g, navigator.platform.includes('Mac') ? '\u2325' : 'Alt')
      .replace(/Shift/g, '\u21E7')
      .replace(/\+/g, '');
  }

  // ---- Auto-save on change ----

  var saveTimer = null;

  function saveAll() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 300);
  }

  async function doSave() {
    var bindings = {};
    keybindingsBody.querySelectorAll('.key-input').forEach(function (input) {
      bindings[input.dataset.action] = input.dataset.binding;
    });

    var fetchSeconds = parseInt(autoFetch.value, 10);
    if (isNaN(fetchSeconds) || fetchSeconds < 0) fetchSeconds = 60;

    var updated = {
      fontFamily: fontFamily.value,
      fontSize: parseInt(fontSize.value, 10) || 13,
      lineHeight: parseFloat(lineHeight.value) || 1.2,
      cursorStyle: cursorStyle.value,
      claudePath: agentPaths.claude.input.value.trim(),
      codexPath: agentPaths.codex.input.value.trim(),
      geminiPath: agentPaths.gemini.input.value.trim(),
      copilotPath: agentPaths.copilot.input.value.trim(),
      defaultProvider: defaultMode.value,
      theme: { preset: themeSelect.value },
      keybindings: bindings,
      autoFetchInterval: fetchSeconds * 1000,
      preCommitReview: document.getElementById('pref-precommit-review').checked,
      repoIntelEnrich: document.getElementById('pref-repo-intel-enrich').checked,
    };

    await window.klaus.ui.setPreferences(updated);
    showStatus('Saved');
  }

  function showStatus(msg) {
    statusMsg.textContent = msg;
    statusMsg.classList.add('visible');
    setTimeout(function () { statusMsg.classList.remove('visible'); }, 1500);
  }

  // Attach change listeners
  [fontFamily, fontSize, lineHeight, cursorStyle, themeSelect, defaultMode, autoFetch].forEach(function (el) {
    el.addEventListener('change', saveAll);
    el.addEventListener('input', saveAll);
  });

  // Re-probe an agent's version when its path changes.
  Object.keys(agentPaths).forEach(function (id) {
    agentPaths[id].input.addEventListener('change', function () {
      saveAll();
      setTimeout(function () { loadAgentInfo(id); }, 500);
    });
  });

  function escHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---- Window color ----
  // Per-window accent, applied to the window that opened Preferences (not a
  // global pref). "None" clears it.
  (function initWindowColor() {
    var container = document.getElementById('window-color-swatches');
    if (!container || !window.klaus.ui.prefsGetWindowColor) return;

    var presets = [
      { name: 'None', value: null },
      // Solids
      { name: 'Red', value: '#e5484d' },
      { name: 'Orange', value: '#f5821f' },
      { name: 'Amber', value: '#f5b800' },
      { name: 'Green', value: '#46a758' },
      { name: 'Teal', value: '#12a594' },
      { name: 'Blue', value: '#3b82f6' },
      { name: 'Purple', value: '#8e4ec6' },
      { name: 'Pink', value: '#e93d82' },
      // Gradients — full CSS values, applied straight to the bar background.
      { name: 'Sunset', value: 'linear-gradient(90deg, #ff8a00, #e52e71)' },
      { name: 'Ocean', value: 'linear-gradient(90deg, #2193b0, #6dd5ed)' },
      { name: 'Aurora', value: 'linear-gradient(90deg, #00c6ff, #0072ff)' },
      { name: 'Forest', value: 'linear-gradient(90deg, #11998e, #38ef7d)' },
      { name: 'Grape', value: 'linear-gradient(90deg, #8e2de2, #4a00e0)' },
      { name: 'Mango', value: 'linear-gradient(90deg, #f7971e, #ffd200)' },
    ];

    var current = null;

    function markSelected() {
      container.querySelectorAll('.window-color-swatch').forEach(function (el) {
        var val = el.dataset.value || null;
        el.classList.toggle('selected', val === current);
      });
    }

    presets.forEach(function (p) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'window-color-swatch' + (p.value ? '' : ' none');
      if (p.value) btn.style.background = p.value;
      if (p.value) btn.dataset.value = p.value;
      btn.title = p.name;
      btn.addEventListener('click', function () {
        current = p.value;
        markSelected();
        window.klaus.ui.prefsSetWindowColor(p.value).then(function () {
          showStatus('Saved');
        });
      });
      container.appendChild(btn);
    });

    window.klaus.ui.prefsGetWindowColor().then(function (color) {
      current = color || null;
      markSelected();
    }).catch(function () {});
  })();
})();
