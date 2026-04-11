// Pop-out window — standalone terminal for a single task
(function () {
  window.klaus.onPopoutInit(function (task) {
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
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      scrollback: 10000,
      theme: {
        background: '#0f0f1a',
        foreground: '#e0e0e0',
        cursor: '#6c5ce7',
        selectionBackground: '#6c5ce744',
      },
      allowProposedApi: true,
    });

    var fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);

    var webLinksAddon = new WebLinksAddon.WebLinksAddon(function (_event, uri) {
      window.klaus.openExternal(uri);
    });
    terminal.loadAddon(webLinksAddon);

    var container = document.getElementById('popout-terminal');
    terminal.open(container);

    setTimeout(function () {
      fitAddon.fit();
      window.klaus.resizeTerminal(id, terminal.cols, terminal.rows);
    }, 50);

    // Wire up I/O
    window.klaus.onTerminalData(id, function (data) {
      terminal.write(data);
    });

    terminal.onData(function (data) {
      window.klaus.writeTerminal(id, data);
    });

    // Key shortcuts
    terminal.attachCustomKeyEventHandler(function (e) {
      if (e.type !== 'keydown') return true;
      var meta = e.metaKey;

      if (e.key === 'Enter' && e.shiftKey) {
        window.klaus.writeTerminal(id, '\n');
        return false;
      }
      if (meta && e.key === 'c') {
        var sel = terminal.getSelection();
        if (sel) { navigator.clipboard.writeText(sel); return false; }
        return true;
      }
      if (meta && e.key === 'v') {
        navigator.clipboard.readText().then(function (text) {
          if (text) window.klaus.writeTerminal(id, text);
        });
        return false;
      }
      if (meta && e.key === 'k') {
        terminal.clear();
        return false;
      }
      return true;
    });

    window.addEventListener('resize', function () {
      fitAddon.fit();
      window.klaus.resizeTerminal(id, terminal.cols, terminal.rows);
    });
  });
})();
