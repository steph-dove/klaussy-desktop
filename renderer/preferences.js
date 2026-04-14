(async function () {
  var prefs = await window.klaus.getPreferences();

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
  var claudeInfo = document.getElementById('claude-info');
  var autoFetch = document.getElementById('pref-auto-fetch');
  var statusMsg = document.getElementById('status-msg');

  fontFamily.value = prefs.fontFamily;
  fontSize.value = prefs.fontSize;
  lineHeight.value = prefs.lineHeight;
  cursorStyle.value = prefs.cursorStyle;
  claudePath.value = prefs.claudePath || '';
  defaultMode.value = prefs.defaultMode;
  autoFetch.value = Math.round((prefs.autoFetchInterval || 60000) / 1000);

  // Theme dropdown
  themes.forEach(function (t) {
    var opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    themeSelect.appendChild(opt);
  });
  themeSelect.value = prefs.theme.preset || 'dark';

  // Claude info
  loadClaudeInfo();

  async function loadClaudeInfo() {
    var info = await window.klaus.getClaudeInfo();
    if (info.version === 'not found') {
      claudeInfo.innerHTML = 'Status: <span class="not-found">not found</span>';
    } else {
      claudeInfo.innerHTML = 'Status: <span class="version">' + escHtml(info.version) + '</span>';
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
      claudePath: claudePath.value.trim(),
      defaultMode: defaultMode.value,
      theme: { preset: themeSelect.value },
      keybindings: bindings,
      autoFetchInterval: fetchSeconds * 1000,
    };

    await window.klaus.setPreferences(updated);
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

  claudePath.addEventListener('change', function () {
    saveAll();
    setTimeout(loadClaudeInfo, 500);
  });

  function escHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
})();
