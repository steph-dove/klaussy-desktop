// Reusable "split button + agent picker" for the built-in AI actions.
//
// There is ONE global default agent (persisted as config.defaultProvider). The
// main button runs the action with that agent; the ▾ picks a different one,
// which becomes the new global default — so every agent action (Review, Ask,
// Implement, commit message, inline edit, …) follows it, and it survives app
// restarts and PR-panel reopens. Picking from any split button updates them
// all (and the Preferences "Default Agent" control, via setPreferences).
//
//   var btn = AgentSplit.create({ verb: 'Review with', run: function (agentId) {...} });
//   AgentSplit.getAgent()  // the current global default agent id
window.AgentSplit = (function () {
  var escHtml = (window.AppUtils && AppUtils.escHtml) || function (s) { return s; };

  var openMenu = null;
  document.addEventListener('click', function () {
    if (openMenu) { openMenu.style.display = 'none'; openMenu = null; }
  });

  function providers() {
    return (window.klaus.ui && window.klaus.ui.providers) || [];
  }
  function isKnown(id) {
    return providers().some(function (p) { return p.id === id; });
  }
  // The single source of truth: the global default agent.
  function currentAgent() {
    var pref = window.AppState && AppState.savedPrefs
      && (AppState.savedPrefs.defaultProvider || AppState.savedPrefs.defaultMode);
    return isKnown(pref) ? pref : (providers()[0] ? providers()[0].id : 'claude');
  }
  // Set the new global default everywhere: local state, persisted config, and
  // every other split button + listener.
  function setDefaultAgent(id) {
    if (!isKnown(id)) return;
    if (window.AppState) {
      if (!AppState.savedPrefs) AppState.savedPrefs = {};
      AppState.savedPrefs.defaultProvider = id;
      AppState.savedPrefs.defaultMode = id;
    }
    try {
      if (window.klaus.ui && window.klaus.ui.setPreferences) {
        window.klaus.ui.setPreferences({ defaultProvider: id });
      }
    } catch (e) {}
    document.dispatchEvent(new CustomEvent('klaussy:default-agent-changed', { detail: { agent: id } }));
  }
  function nameOf(id) {
    var p = providers().find(function (x) { return x.id === id; });
    return p ? (p.shortName || p.displayName) : (id || 'Agent');
  }

  function create(opts) {
    var verb = opts.verb || 'Run';
    var run = opts.run || function () {};
    var showName = opts.showName !== false;

    var wrap = document.createElement('span');
    wrap.className = 'agent-split' + (opts.className ? ' ' + opts.className : '');

    var mainBtn = document.createElement('button');
    mainBtn.type = 'button';
    mainBtn.className = 'agent-split-main';

    var caret = document.createElement('button');
    caret.type = 'button';
    caret.className = 'agent-split-caret';
    caret.innerHTML = '&#9662;';
    caret.title = 'Choose the default agent';

    var menu = document.createElement('div');
    menu.className = 'agent-split-menu';
    menu.style.display = 'none';

    function rebuildMenu() {
      var cur = currentAgent();
      menu.innerHTML = providers().map(function (p) {
        var on = p.id === cur;
        return '<button type="button" class="agent-split-item' + (on ? ' on' : '')
          + '" data-id="' + p.id + '">' + (on ? '✓ ' : '') + escHtml(p.displayName) + '</button>';
      }).join('');
    }
    function refresh() {
      var name = nameOf(currentAgent());
      mainBtn.textContent = showName ? (verb + ' ' + name) : verb;
      mainBtn.title = opts.titleFor ? opts.titleFor(name) : (verb + ' ' + name);
      rebuildMenu();
    }

    mainBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      run(currentAgent(), false); // (agentId, fromPicker)
    });
    caret.addEventListener('click', function (e) {
      e.stopPropagation();
      var isOpen = menu.style.display !== 'none';
      if (openMenu && openMenu !== menu) openMenu.style.display = 'none';
      menu.style.display = isOpen ? 'none' : 'flex';
      openMenu = isOpen ? null : menu;
    });
    menu.addEventListener('click', function (e) {
      e.stopPropagation();
      var item = e.target.closest('.agent-split-item');
      if (!item) return;
      menu.style.display = 'none';
      openMenu = null;
      var id = item.dataset.id;
      setDefaultAgent(id); // becomes the new global default for everything
      run(id, true);
    });

    // Keep this button's label in sync when the default changes elsewhere
    // (another split button, or Preferences).
    document.addEventListener('klaussy:default-agent-changed', refresh);

    wrap.appendChild(mainBtn);
    wrap.appendChild(caret);
    wrap.appendChild(menu);
    refresh();
    wrap.refresh = refresh;
    return wrap;
  }

  // ---- Per-agent model/version selection ----

  function modelsForAgent(agent) {
    var p = providers().find(function (x) { return x.id === agent; });
    return (p && p.models) || [{ id: '', label: 'Default' }];
  }
  function currentModel(agent) {
    var m = window.AppState && AppState.savedPrefs && AppState.savedPrefs.agentModel;
    return (m && m[agent]) || '';
  }
  function setModel(agent, modelId) {
    if (window.AppState) {
      if (!AppState.savedPrefs) AppState.savedPrefs = {};
      if (!AppState.savedPrefs.agentModel) AppState.savedPrefs.agentModel = {};
      AppState.savedPrefs.agentModel[agent] = modelId;
    }
    try {
      if (window.klaus.ui && window.klaus.ui.setPreferences) {
        var patch = {}; patch[agent] = modelId;
        window.klaus.ui.setPreferences({ agentModel: patch });
      }
    } catch (e) {}
  }

  // A header toolbar: Agent + Version dropdowns that drive the one global
  // default agent (and that agent's model), plus a Run button. The selection
  // applies to every agent action (review, implement, CI debug, ask, …).
  //   AgentSplit.createToolbar({ runLabel: 'Run Review', onRun: function (agentId) {...} })
  function createToolbar(opts) {
    opts = opts || {};
    var onRun = opts.onRun || function () {};
    var wrap = document.createElement('div');
    wrap.className = 'agent-toolbar' + (opts.className ? ' ' + opts.className : '');

    var agentLbl = document.createElement('span');
    agentLbl.className = 'agent-toolbar-label';
    agentLbl.textContent = 'Agent';

    var agentSel = document.createElement('select');
    agentSel.className = 'agent-toolbar-agent';
    agentSel.title = 'Agent used for review, implement, CI debug, and ask';
    providers().forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id; o.textContent = p.displayName;
      agentSel.appendChild(o);
    });

    var modelLbl = document.createElement('span');
    modelLbl.className = 'agent-toolbar-label';
    modelLbl.textContent = 'Version';

    var modelSel = document.createElement('select');
    modelSel.className = 'agent-toolbar-model';
    modelSel.title = 'Model / version';

    var runBtn = document.createElement('button');
    runBtn.type = 'button';
    runBtn.className = 'agent-toolbar-run';
    runBtn.textContent = opts.runLabel || 'Run';

    function fillModels() {
      var agent = currentAgent();
      var models = modelsForAgent(agent);
      var cur = currentModel(agent);
      modelSel.innerHTML = '';
      models.forEach(function (m) {
        var o = document.createElement('option');
        o.value = m.id; o.textContent = m.label;
        if (m.id === cur) o.selected = true;
        modelSel.appendChild(o);
      });
      // Only one option (Default) → nothing to choose, so disable.
      modelSel.disabled = models.length <= 1;
    }
    function sync() {
      agentSel.value = currentAgent();
      fillModels();
    }

    agentSel.addEventListener('change', function () {
      setDefaultAgent(agentSel.value); // dispatches klaussy:default-agent-changed
    });
    modelSel.addEventListener('change', function () {
      setModel(currentAgent(), modelSel.value);
    });
    runBtn.addEventListener('click', function () { onRun(currentAgent()); });
    document.addEventListener('klaussy:default-agent-changed', sync);

    wrap.appendChild(agentLbl);
    wrap.appendChild(agentSel);
    wrap.appendChild(modelLbl);
    wrap.appendChild(modelSel);
    wrap.appendChild(runBtn);
    sync();
    return wrap;
  }

  // getAgent() ignores any argument (kept for back-compat callers) and returns
  // the single global default agent.
  return {
    create: create,
    createToolbar: createToolbar,
    getAgent: currentAgent,
    setAgent: setDefaultAgent,
    agentName: nameOf,
  };
})();
