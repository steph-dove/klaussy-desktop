// Pop-out window — standalone terminal for a single task
(function () {
  if (window.ThemeManager) window.ThemeManager.init();

  window.klaus.task.onPopoutInit(function (task) {
    var id = task.id;
    var name = task.name;
    var branch = task.branch;

    document.getElementById('popout-name').textContent = name;
    document.getElementById('popout-branch').textContent = branch ? '(' + branch + ')' : '';
    document.title = 'Klaussy \u2014 ' + name;

    var Terminal = window.Terminal;
    var FitAddon = window.FitAddon;
    var WebLinksAddon = window.WebLinksAddon;

    var terminal = new Terminal({
      cursorBlink: !AppUtils.prefersReducedMotion(),
      fontSize: 13,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      scrollback: 10000,
      theme: window.ThemeManager.getTerminalTheme(),
      minimumContrastRatio: 4.5, // never let low-contrast text vanish
      allowProposedApi: true,
    });
    var srPrefs = {};
    window.klaus.ui.getPreferences().then(function (prefs) {
      srPrefs = { screenReaderMode: prefs.screenReaderMode, screenReaderActive: prefs.screenReaderActive };
      terminal.options.screenReaderMode = AppUtils.screenReaderMode(prefs);
    }).catch(function (err) { console.error('[popout] getPreferences failed', err); });
    window.klaus.ui.onPreferencesChanged(function (prefs) {
      if (prefs.screenReaderMode !== undefined) srPrefs.screenReaderMode = prefs.screenReaderMode;
      if (prefs.screenReaderActive !== undefined) srPrefs.screenReaderActive = prefs.screenReaderActive;
      if (prefs.screenReaderMode !== undefined || prefs.screenReaderActive !== undefined) {
        terminal.options.screenReaderMode = AppUtils.screenReaderMode(srPrefs);
      }
    });

    var fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);

    var webLinksAddon = new WebLinksAddon.WebLinksAddon(function (_event, uri) {
      window.klaus.gh.openExternal(uri);
    });
    terminal.loadAddon(webLinksAddon);

    var container = document.getElementById('popout-terminal');
    terminal.open(container);
    AppUtils.labelTerminal(terminal, function () { return name + ' terminal'; });

    setTimeout(function () {
      fitAddon.fit();
      window.klaus.terminal.resize(id, terminal.cols, terminal.rows);
    }, 50);

    // Wire up I/O
    window.klaus.terminal.onData(id, function (data) {
      terminal.write(data);
      if (exited) setAlive(true);
    });

    terminal.onData(function (data) {
      window.klaus.terminal.write(id, data);
    });

    // A restart reuses the task id, so output after an exit means it's running again.
    var exited = false;
    function setAlive(alive) {
      exited = !alive;
      document.querySelector('#popout-header .dot').classList.toggle('exited', exited);
      document.getElementById('popout-status').textContent = alive ? 'running' : 'exited';
    }
    if (task.alive === false) setAlive(false);
    window.klaus.terminal.onExit(id, function () {
      setAlive(false);
      A11y.announce(name + ' exited');
    });

    // Key shortcuts
    terminal.attachCustomKeyEventHandler(function (e) {
      if (e.type !== 'keydown') return true;
      if (e.key === 'Enter' && e.shiftKey) {
        window.klaus.terminal.write(id, '\n');
        return false;
      }
      if (AppUtils.isAppShortcut(e, 'c')) {
        var sel = terminal.getSelection();
        if (sel) { navigator.clipboard.writeText(sel); return false; }
        return true;
      }
      if (AppUtils.isAppShortcut(e, 'v')) {
        e.preventDefault();
        navigator.clipboard.readText().then(function (text) {
          if (text) window.klaus.terminal.write(id, text);
        });
        return false;
      }
      if (AppUtils.isClearShortcut(e)) {
        terminal.clear();
        return false;
      }
      return true;
    });

    var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion.addEventListener('change', function () { terminal.options.cursorBlink = !reducedMotion.matches; });

    window.addEventListener('theme-changed', function () {
      terminal.options.theme = window.ThemeManager.getTerminalTheme();
    });

    window.addEventListener('resize', function () {
      fitAddon.fit();
      window.klaus.terminal.resize(id, terminal.cols, terminal.rows);
    });
  });
})();
