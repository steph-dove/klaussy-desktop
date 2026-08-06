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
    { id: 'synthwave', name: 'Synthwave \'84' },
    { id: 'gruvbox', name: 'Gruvbox' },
    { id: 'catppuccin', name: 'Catppuccin' },
    { id: 'tokyo', name: 'Tokyo Night' },
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
  var ollamaModel = document.getElementById('pref-ollama-model');
  var ollamaModelStatus = document.getElementById('ollama-model-status');
  var opencodeModelSelect = document.getElementById('pref-opencode-model');
  var opencodeModelStatus = document.getElementById('opencode-model-status');
  var agentContextSelect = document.getElementById('pref-agent-context');
  var agentContextStatus = document.getElementById('agent-context-status');
  var themeSelect = document.getElementById('pref-theme');
  var claudePath = document.getElementById('pref-claude-path');
  var defaultMode = document.getElementById('pref-default-mode');
  var autoFetch = document.getElementById('pref-auto-fetch');
  var statusMsg = document.getElementById('status-msg');
  var nemesisProfilesEl = document.getElementById('nemesis-profiles');
  var nemesisProfileTpl = document.getElementById('nemesis-profile-tpl');
  var nemesisAddBtn = document.getElementById('pref-nemesis-add');

  // Per-agent path inputs, keyed by provider id → { input, infoEl, prefKey }.
  var agentPaths = {
    claude: { input: claudePath, infoEl: document.getElementById('agent-info-claude'), prefKey: 'claudePath' },
    codex: { input: document.getElementById('pref-codex-path'), infoEl: document.getElementById('agent-info-codex'), prefKey: 'codexPath' },
    gemini: { input: document.getElementById('pref-gemini-path'), infoEl: document.getElementById('agent-info-gemini'), prefKey: 'geminiPath' },
    antigravity: { input: document.getElementById('pref-antigravity-path'), infoEl: document.getElementById('agent-info-antigravity'), prefKey: 'antigravityPath' },
    copilot: { input: document.getElementById('pref-copilot-path'), infoEl: document.getElementById('agent-info-copilot'), prefKey: 'copilotPath' },
    cursor: { input: document.getElementById('pref-cursor-path'), infoEl: document.getElementById('agent-info-cursor'), prefKey: 'cursorPath' },
    cline: { input: document.getElementById('pref-cline-path'), infoEl: document.getElementById('agent-info-cline'), prefKey: 'clinePath' },
    opencode: { input: document.getElementById('pref-opencode-path'), infoEl: document.getElementById('agent-info-opencode'), prefKey: 'opencodePath' },
    kimi: { input: document.getElementById('pref-kimi-path'), infoEl: document.getElementById('agent-info-kimi'), prefKey: 'kimiPath' },
    ollama: { input: document.getElementById('pref-aider-path'), infoEl: document.getElementById('agent-info-ollama'), prefKey: 'aiderPath' },
  };

  fontFamily.value = prefs.fontFamily;
  fontSize.value = prefs.fontSize;
  lineHeight.value = prefs.lineHeight;
  cursorStyle.value = prefs.cursorStyle;

  // Autocomplete model: show the saved value even if it isn't one of the
  // presets (e.g. a hand-set tag), so the picker never misrepresents config.
  var savedOllamaModel = prefs.ollamaModel || 'qwen2.5-coder:1.5b-base';
  if (!Array.prototype.slice.call(ollamaModel.options).some(function (o) { return o.value === savedOllamaModel; })) {
    var custom = document.createElement('option');
    custom.value = savedOllamaModel;
    custom.textContent = savedOllamaModel + ' (current)';
    ollamaModel.insertBefore(custom, ollamaModel.firstChild);
  }
  ollamaModel.value = savedOllamaModel;

  if (opencodeModelSelect) {
    var savedOpencodeModel = (prefs.agentModel && prefs.agentModel.opencode) || prefs.opencodeModel || '';
    if (savedOpencodeModel && !Array.prototype.slice.call(opencodeModelSelect.options).some(function (o) { return o.value === savedOpencodeModel; })) {
      var customOpt = document.createElement('option');
      customOpt.value = savedOpencodeModel;
      customOpt.textContent = savedOpencodeModel + ' (custom)';
      opencodeModelSelect.appendChild(customOpt);
    }
    opencodeModelSelect.value = savedOpencodeModel;
  }

  if (agentContextSelect) {
    agentContextSelect.value = prefs.agentContextLength ? String(prefs.agentContextLength) : '';
  }
  Object.keys(agentPaths).forEach(function (id) {
    agentPaths[id].input.value = prefs[agentPaths[id].prefKey] || '';
  });
  defaultMode.value = prefs.defaultProvider || prefs.defaultMode || 'claude';
  autoFetch.value = Math.round((prefs.autoFetchInterval || 60000) / 1000);
  document.getElementById('pref-precommit-review').checked = prefs.preCommitReview !== false;
  document.getElementById('pref-strip-comments').checked = prefs.stripComments !== false;
  // null = config.toml unreadable; disable rather than untick, so a Save can't
  // revoke a grant that may still be live.
  var kimiBash = document.getElementById('pref-kimi-autonomous-bash');
  kimiBash.checked = prefs.kimiAutonomousBash === true;
  kimiBash.disabled = prefs.kimiAutonomousBash === null;
  if (kimiBash.disabled) kimiBash.title = "Can't read ~/.kimi-code/config.toml";
  document.getElementById('pref-repo-intel-enrich').checked = prefs.repoIntelEnrich === true;

  var ng = prefs.notificationGateway || {};
  var ngEvents = ng.events || {};
  document.getElementById('pref-slack-webhook').value = ng.slackWebhookUrl || '';
  document.getElementById('pref-discord-webhook').value = ng.discordWebhookUrl || '';
  document.getElementById('pref-notify-completed').checked = ngEvents.completed !== false;
  document.getElementById('pref-notify-failed').checked = ngEvents.failed !== false;
  document.getElementById('pref-notify-approval').checked = ngEvents.approvalRequired !== false;
  document.getElementById('pref-notify-stale').checked = ngEvents.stale !== false;
  document.getElementById('pref-notify-stale-after').value = ng.staleAfterSeconds || 120;
  document.getElementById('pref-notify-new-sessions').checked = ng.notifyNewSessions !== false;
  document.getElementById('pref-slack-app-token').value = ng.slackAppToken || '';
  document.getElementById('pref-slack-bot-token').value = ng.slackBotToken || '';
  document.getElementById('pref-slack-channel').value = ng.slackChannel || '';
  document.getElementById('pref-discord-bot-token').value = ng.discordBotToken || '';
  document.getElementById('pref-discord-channel').value = ng.discordChannel || '';
  document.getElementById('pref-notify-allowlist').value = (ng.allowList || []).join(', ');

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
      antigravityPath: agentPaths.antigravity.input.value.trim(),
      copilotPath: agentPaths.copilot.input.value.trim(),
      cursorPath: agentPaths.cursor.input.value.trim(),
      clinePath: agentPaths.cline.input.value.trim(),
      opencodePath: agentPaths.opencode.input.value.trim(),
      opencodeModel: opencodeModelSelect ? opencodeModelSelect.value : '',
      // '' means auto — the main side sizes it to the machine.
      agentContextLength: agentContextSelect ? Number(agentContextSelect.value || 0) : 0,
      agentModel: Object.assign({}, prefs.agentModel || {}, { opencode: opencodeModelSelect ? opencodeModelSelect.value : '' }),
      kimiPath: agentPaths.kimi.input.value.trim(),
      aiderPath: agentPaths.ollama.input.value.trim(),
      defaultProvider: defaultMode.value,
      theme: { preset: themeSelect.value },
      keybindings: bindings,
      autoFetchInterval: fetchSeconds * 1000,
      preCommitReview: document.getElementById('pref-precommit-review').checked,
      stripComments: document.getElementById('pref-strip-comments').checked,
      repoIntelEnrich: document.getElementById('pref-repo-intel-enrich').checked,
      nemesisProfiles: collectNemesisProfiles(),
      notificationGateway: collectNotificationGateway(),
    };

    // Omitted entirely while unknown so the main side skips it (`!== undefined`).
    if (!kimiBash.disabled) updated.kimiAutonomousBash = kimiBash.checked;

    var res = await window.klaus.ui.setPreferences(updated);
    showStatus(res && res.error ? res.error : 'Saved');
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

  // Toggling this rewrites kimi's own config.toml, so it saves on change rather
  // than riding along with whatever control the user touches next.
  kimiBash.addEventListener('change', saveAll);

  ['pref-slack-webhook', 'pref-discord-webhook', 'pref-notify-completed',
    'pref-notify-failed', 'pref-notify-approval', 'pref-notify-new-sessions',
    'pref-slack-app-token', 'pref-slack-bot-token', 'pref-slack-channel',
    'pref-discord-bot-token', 'pref-discord-channel', 'pref-notify-allowlist',
    'pref-notify-stale', 'pref-notify-stale-after',
  ].forEach(function (id) {
    var el = document.getElementById(id);
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

  // Autocomplete model picker: persist immediately (partial update so it
  // doesn't depend on the debounced doSave), then pull the model if it isn't
  // installed yet, surfacing download progress inline.
  ollamaModel.addEventListener('change', async function () {
    await window.klaus.ui.setPreferences({ ollamaModel: ollamaModel.value });
    showStatus('Saved');
    pullSelectedModel();
  });

  if (opencodeModelSelect) {
    opencodeModelSelect.addEventListener('change', async function () {
      var val = opencodeModelSelect.value;
      var agentModel = Object.assign({}, prefs.agentModel || {}, { opencode: val });
      await window.klaus.ui.setPreferences({ agentModel: agentModel, opencodeModel: val });
      showStatus('Saved');
      checkAndPullOpencodeModel(val);
    });
  }

  // Changing the window rewrites the model itself, so it saves on change and
  // re-applies immediately rather than waiting for the next launch.
  if (agentContextSelect) {
    agentContextSelect.addEventListener('change', async function () {
      // doSave, not the debounced saveAll: the main side reads the persisted
      // window when re-baking, so it has to land before we apply.
      await doSave();
      var current = opencodeModelSelect ? opencodeModelSelect.value : '';
      if (!current || current.indexOf('ollama/') !== 0) {
        agentContextStatus.textContent = agentContextSelect.value
          ? 'Applies when an Ollama model is selected above.'
          : '';
        return;
      }
      agentContextStatus.textContent = 'Applying to ' + current.replace('ollama/', '') + '…';
      checkAndPullOpencodeModel(current);
    });
  }

  function checkAndPullOpencodeModel(modelVal) {
    if (!opencodeModelStatus) return;
    if (!modelVal || !modelVal.startsWith('ollama/')) {
      opencodeModelStatus.textContent = '';
      return;
    }
    var tag = modelVal.replace('ollama/', '');
    var api = window.klaus.ai && window.klaus.ai.ollama;
    if (!api || !api.ensureModel) return;

    opencodeModelStatus.textContent = 'Checking model ' + tag + '…';
    var dispose = api.onSetupProgress ? api.onSetupProgress(function (p) {
      if (!p || (p.step !== 'model' && p.step !== 'context')) return;
      opencodeModelStatus.textContent = (p.message || 'Downloading…') +
        (typeof p.percent === 'number' ? ' ' + p.percent + '%' : '');
    }) : null;

    // agentContext makes Ollama serve opencode a usable window; without it the
    // agent loses its tools and history to the 4096 default.
    api.ensureModel({ model: tag, agentContext: true }).then(function (r) {
      if (dispose) dispose();
      var ctx = r && r.contextLength ? ' (context ' + r.contextLength + ')' : '';
      if (r && r.error) opencodeModelStatus.textContent = 'Could not install ' + tag + ': ' + r.error;
      else if (r && r.alreadyPresent) opencodeModelStatus.textContent = 'Model ' + tag + ' is ready' + ctx + '.';
      else opencodeModelStatus.textContent = 'Model ' + tag + ' downloaded & ready' + ctx + '.';
    }).catch(function () {
      if (dispose) dispose();
      opencodeModelStatus.textContent = 'Could not install ' + tag + '.';
    });
  }

  function pullSelectedModel() {
    var api = window.klaus.ai && window.klaus.ai.ollama;
    if (!api || !api.ensureModel) return;
    ollamaModelStatus.textContent = 'Checking model…';
    var dispose = api.onSetupProgress ? api.onSetupProgress(function (p) {
      if (!p || p.step !== 'model') return;
      ollamaModelStatus.textContent = (p.message || 'Downloading…') +
        (typeof p.percent === 'number' ? ' ' + p.percent + '%' : '');
    }) : null;
    api.ensureModel().then(function (r) {
      if (dispose) dispose();
      if (r && r.error) ollamaModelStatus.textContent = 'Could not install model: ' + r.error;
      else if (r && r.alreadyPresent) ollamaModelStatus.textContent = 'Model installed.';
      else ollamaModelStatus.textContent = 'Model ready.';
    }).catch(function () {
      if (dispose) dispose();
      ollamaModelStatus.textContent = 'Could not install model.';
    });
  }

  // ---- Nemesis8 gateway profiles ----
  // One gateway (URL/token/agent) per card; the setup command inlines the token.
  var nemesisProfiles = (prefs.nemesisProfiles || []).map(function (p) {
    return {
      id: p.id || newProfileId(), name: p.name || '', remote: p.remote || '',
      token: p.token || '', provider: p.provider || '', model: p.model || '',
    };
  });

  function randomHex(n) {
    var bytes = new Uint8Array(n);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function newProfileId() { return 'n8-' + randomHex(6); }

  function collectNemesisProfiles() {
    return nemesisProfiles.map(function (p, i) {
      return {
        id: p.id, name: (p.name || '').trim() || ('Nemesis8 ' + (i + 1)),
        remote: (p.remote || '').trim(), token: p.token || '',
        provider: p.provider || '', model: (p.model || '').trim(),
      };
    });
  }

  function collectNotificationGateway() {
    return {
      slackWebhookUrl: document.getElementById('pref-slack-webhook').value.trim(),
      discordWebhookUrl: document.getElementById('pref-discord-webhook').value.trim(),
      notifyNewSessions: document.getElementById('pref-notify-new-sessions').checked,
      slackAppToken: document.getElementById('pref-slack-app-token').value.trim(),
      slackBotToken: document.getElementById('pref-slack-bot-token').value.trim(),
      slackChannel: document.getElementById('pref-slack-channel').value.trim(),
      discordBotToken: document.getElementById('pref-discord-bot-token').value.trim(),
      discordChannel: document.getElementById('pref-discord-channel').value.trim(),
      allowList: document.getElementById('pref-notify-allowlist').value
        .split(',').map(function (s) { return s.trim(); }).filter(Boolean),
      events: {
        completed: document.getElementById('pref-notify-completed').checked,
        failed: document.getElementById('pref-notify-failed').checked,
        approvalRequired: document.getElementById('pref-notify-approval').checked,
        stale: document.getElementById('pref-notify-stale').checked,
      },
      staleAfterSeconds: Math.max(30, parseInt(document.getElementById('pref-notify-stale-after').value, 10) || 120),
    };
  }

  var notifyDocsLink = document.getElementById('notify-docs-link');
  if (notifyDocsLink) {
    notifyDocsLink.addEventListener('click', function (e) {
      e.preventDefault();
      try {
        window.klaus.gh.openExternal(
          'https://github.com/steph-dove/klaussy-desktop/blob/main/docs/notifications-setup.md');
      } catch (err) {
        notifyTestStatus.textContent = 'Could not open the guide: ' + (err && err.message);
      }
    });
  }

  var notifyTestBtn = document.getElementById('pref-notify-test');
  var notifyTestStatus = document.getElementById('notify-test-status');
  notifyTestBtn.addEventListener('click', async function () {
    var cfg = collectNotificationGateway();
    if (!cfg.slackWebhookUrl && !cfg.discordWebhookUrl) {
      notifyTestStatus.textContent = 'Add a Slack or Discord webhook URL first.';
      return;
    }
    notifyTestBtn.disabled = true;
    notifyTestStatus.textContent = 'Sending…';
    try {
      // Send the on-screen values rather than the saved ones, so a URL can be
      // verified before committing it.
      var res = await window.klaus.ui.testNotification(cfg);
      notifyTestStatus.textContent = res && res.ok
        ? 'Sent — check your channel.'
        : 'Failed: ' + ((res && res.error) || 'unknown error');
    } catch (err) {
      // Without this the button re-enables but the text stays "Sending…".
      notifyTestStatus.textContent = 'Failed: ' + (err && err.message ? err.message : String(err));
    } finally {
      notifyTestBtn.disabled = false;
    }
    refreshSocketStatus();
  });

  var socketStatusEl = document.getElementById('notify-socket-status');
  async function refreshSocketStatus() {
    if (!socketStatusEl) return;
    var s;
    try {
      s = await window.klaus.ui.getNotificationStatus();
    } catch (err) {
      socketStatusEl.textContent = 'Could not read connection status: ' + (err && err.message);
      return;
    }
    if (!s || s.error) {
      socketStatusEl.textContent = s && s.error ? 'Status unavailable: ' + s.error : '';
      return;
    }
    var lines = [];
    ['slack', 'discord'].forEach(function (k) {
      var st = s[k];
      if (!st) return; // not configured for replies
      var label = k === 'slack' ? 'Slack' : 'Discord';
      if (st.pending) lines.push(label + ' replies: connecting…');
      else if (st.ok && st.degraded) lines.push(label + ' replies: ' + st.error);
      else if (st.ok) lines.push(label + ' replies: connected');
      else lines.push(label + ' replies: ' + (st.error || 'not connected'));
    });
    socketStatusEl.textContent = lines.join(' · ');
  }
  refreshSocketStatus();
  // Connecting is async and can fail later (token rejected, intent refused), so
  // keep the line current while the window is open.
  var socketStatusTimer = setInterval(refreshSocketStatus, 5000);
  window.addEventListener('beforeunload', function () { clearInterval(socketStatusTimer); });

  function isLocalHost(url) {
    var v = (url || '').trim();
    if (!v) return true;
    var host = v.replace(/^https?:\/\//i, '').split(/[:/]/)[0].toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  }

  function buildSetupCmd(profile) {
    var win = window.klaus.ui.platform === 'win32';
    var flag = profile.provider ? ' --provider ' + profile.provider : '';
    var token = (profile.token || '').trim();
    var install = win
      ? 'powershell -c "irm https://nemesis8.nuts.services/install.ps1 | iex"'
      : 'curl -fsSL https://nemesis8.nuts.services/install.sh | sh';
    var login = 'nemesis8 login' + flag + '   # sign in to the agent (interactive) — required';
    var tokenLine = token
      ? (win ? '$env:NEMESIS8_AUTH_TOKEN="' + token + '"' : 'export NEMESIS8_AUTH_TOKEN="' + token + '"')
      : (win ? '$env:NEMESIS8_AUTH_TOKEN="<click Generate>"' : 'export NEMESIS8_AUTH_TOKEN="<click Generate>"');
    var serve = 'nemesis8 serve' + flag + '   # gateway on port 9801';
    return [install, login, tokenLine, serve].join('\n');
  }

  function makeNemesisCard(profile) {
    var card = nemesisProfileTpl.content.firstElementChild.cloneNode(true);
    var q = function (sel) { return card.querySelector(sel); };
    var nameEl = q('.np-name'), remoteEl = q('.np-remote'), tokenEl = q('.np-token');
    var providerEl = q('.np-provider'), modelEl = q('.np-model');
    var statusEl = q('.np-status'), cmdEl = q('.np-cmd');
    var localRow = q('.np-local-row'), manualRow = q('.np-manual-row');

    nameEl.value = profile.name || '';
    remoteEl.value = profile.remote || '';
    tokenEl.value = profile.token || '';
    providerEl.value = profile.provider || '';
    modelEl.value = profile.model || '';

    function setStatus(kind, html) {
      if (!html) { statusEl.innerHTML = ''; return; }
      var cls = kind === 'ok' ? 'version' : kind === 'err' ? 'not-found' : '';
      statusEl.innerHTML = 'Status: <span class="' + cls + '">' + html + '</span>';
    }
    function refresh() {
      cmdEl.textContent = buildSetupCmd(profile);
      var local = isLocalHost(profile.remote);
      localRow.style.display = local ? '' : 'none';
      manualRow.style.display = local ? 'none' : '';
    }

    nameEl.addEventListener('input', function () { profile.name = nameEl.value; saveAll(); });
    remoteEl.addEventListener('input', function () { profile.remote = remoteEl.value; saveAll(); setStatus('', ''); refresh(); });
    tokenEl.addEventListener('input', function () { profile.token = tokenEl.value; saveAll(); setStatus('', ''); refresh(); });
    providerEl.addEventListener('change', function () { profile.provider = providerEl.value; saveAll(); refresh(); });
    modelEl.addEventListener('input', function () { profile.model = modelEl.value; saveAll(); });

    q('.np-gen').addEventListener('click', function () {
      profile.token = randomHex(24); tokenEl.value = profile.token; saveAll(); setStatus('', ''); refresh();
    });
    q('.np-copy').addEventListener('click', function (e) {
      var btn = e.currentTarget;
      try { window.klaus.fs.copyToClipboard(cmdEl.textContent); } catch (_e) {}
      btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy command'; }, 1500);
    });
    q('.np-remove').addEventListener('click', function () {
      var i = nemesisProfiles.indexOf(profile);
      if (i !== -1) nemesisProfiles.splice(i, 1);
      saveAll(); renderNemesisProfiles();
    });
    q('.np-test').addEventListener('click', async function (e) {
      var btn = e.currentTarget;
      var conn = { remote: (profile.remote || '').trim(), token: profile.token || '' };
      window.klaus.ui.setPreferences({ nemesisProfiles: collectNemesisProfiles() });
      btn.disabled = true; setStatus('', 'connecting…');
      var res;
      try { res = await window.klaus.ui.testNemesisConnection(conn); } catch (_e) { res = { ok: false, error: 'test failed' }; }
      btn.disabled = false;
      if (res && res.ok) { setStatus('ok', 'connected' + (res.version ? ' (v' + escHtml(res.version) + ')' : '')); }
      else { setStatus('err', escHtml((res && res.error) || 'unreachable')); }
      if (res && res.insecure) { statusEl.innerHTML += ' <span class="not-found">⚠ token sent over http — use https or a tunnel</span>'; }
    });
    q('.np-setup').addEventListener('click', async function (e) {
      var btn = e.currentTarget; var prev = btn.textContent;
      btn.disabled = true; btn.textContent = 'Opening terminal…';
      var res;
      try { res = await window.klaus.ui.nemesisSetupLocal({ token: (profile.token || '').trim(), provider: profile.provider || '' }); }
      catch (_e) { res = { error: 'could not start setup' }; }
      btn.disabled = false; btn.textContent = prev;
      if (res && res.ok) {
        if (res.token) { profile.token = res.token; tokenEl.value = res.token; }
        if (!(profile.remote || '').trim()) { profile.remote = 'http://localhost:9801'; remoteEl.value = profile.remote; }
        saveAll(); refresh();
        setStatus('', 'opened a setup tab in Klaussy — complete the sign-in there, then come back and Test connection');
      } else { setStatus('err', escHtml((res && res.error) || 'could not start setup')); }
    });

    refresh();
    return card;
  }

  function renderNemesisProfiles() {
    nemesisProfilesEl.innerHTML = '';
    nemesisProfiles.forEach(function (p) { nemesisProfilesEl.appendChild(makeNemesisCard(p)); });
  }
  renderNemesisProfiles();

  if (nemesisAddBtn) {
    nemesisAddBtn.addEventListener('click', function () {
      nemesisProfiles.push({ id: newProfileId(), name: '', remote: '', token: '', provider: '', model: '' });
      saveAll(); renderNemesisProfiles();
    });
  }

  var nemesisDocsLink = document.getElementById('nemesis-docs-link');
  if (nemesisDocsLink) {
    nemesisDocsLink.addEventListener('click', function (e) {
      e.preventDefault();
      try { window.klaus.gh.openExternal('https://github.com/DeepBlueDynamics/nemesis8'); } catch (_e) {}
    });
  }

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
