window.Dialogs = (function () {
  var escHtml = AppUtils.escHtml;

  function showAbout() {
    var overlay = document.createElement('div');
    overlay.className = 'palette-overlay';

    var dialog = document.createElement('div');
    dialog.className = 'about-dialog';
    dialog.innerHTML = '<h2>Klaussy</h2><div class="about-loading">Loading...</div>';

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    window.klaus.getAboutInfo().then(function (info) {
      dialog.innerHTML =
        '<h2>Klaussy</h2>' +
        '<div class="about-rows">' +
          '<div class="about-row"><span>Version</span><span>' + escHtml(info.appVersion) + '</span></div>' +
          '<div class="about-row"><span>Electron</span><span>' + escHtml(info.electronVersion) + '</span></div>' +
          '<div class="about-row"><span>Node</span><span>' + escHtml(info.nodeVersion) + '</span></div>' +
          '<div class="about-row"><span>Claude CLI</span><span>' + escHtml(info.claudeVersion) + '</span></div>' +
          '<div class="about-row"><span>Claude Path</span><span>' + escHtml(info.claudePath) + '</span></div>' +
        '</div>' +
        '<button class="about-close">Close</button>';
      dialog.querySelector('.about-close').addEventListener('click', function () { overlay.remove(); });
    });
  }

  function showLog() {
    var overlay = document.createElement('div');
    overlay.className = 'palette-overlay';

    var viewer = document.createElement('div');
    viewer.className = 'log-viewer';
    viewer.innerHTML = '<div class="log-viewer-header"><h3>Main Process Logs</h3><button class="log-viewer-close">&times;</button></div><div class="log-viewer-content">Loading...</div>';

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });

    overlay.appendChild(viewer);
    document.body.appendChild(overlay);

    viewer.querySelector('.log-viewer-close').addEventListener('click', function () { overlay.remove(); });

    window.klaus.getLogs().then(function (logs) {
      var content = viewer.querySelector('.log-viewer-content');
      if (!logs || logs.length === 0) {
        content.textContent = 'No logs yet.';
        return;
      }
      content.innerHTML = logs.map(function (entry) {
        var cls = entry.level === 'error' ? 'log-error' : entry.level === 'warn' ? 'log-warn' : 'log-info';
        return '<div class="log-entry ' + cls + '"><span class="log-time">' + escHtml(entry.time.substring(11, 19)) + '</span><span class="log-level">' + escHtml(entry.level) + '</span><span class="log-msg">' + escHtml(entry.msg) + '</span></div>';
      }).join('');
      content.scrollTop = content.scrollHeight;
    });
  }

  return { showAbout: showAbout, showLog: showLog };
})();
