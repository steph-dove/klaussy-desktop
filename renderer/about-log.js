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
        '<p class="about-tagline">Multi-terminal Claude Code worktree manager + PR reviewer.</p>' +
        '<div class="about-rows">' +
          '<div class="about-row"><span>Version</span><span>' + escHtml(info.appVersion) + '</span></div>' +
          '<div class="about-row"><span>Electron</span><span>' + escHtml(info.electronVersion) + '</span></div>' +
          '<div class="about-row"><span>Node</span><span>' + escHtml(info.nodeVersion) + '</span></div>' +
          '<div class="about-row"><span>Claude CLI</span><span>' + escHtml(info.claudeVersion) + '</span></div>' +
          '<div class="about-row"><span>Claude Path</span><span>' + escHtml(info.claudePath) + '</span></div>' +
        '</div>' +
        '<div class="about-actions">' +
          '<button class="about-howto" type="button">How to use</button>' +
          '<button class="about-close" type="button">Close</button>' +
        '</div>';
      dialog.querySelector('.about-close').addEventListener('click', function () { overlay.remove(); });
      dialog.querySelector('.about-howto').addEventListener('click', function () {
        overlay.remove();
        showHowToUse();
      });
    });
  }

  function showHowToUse() {
    var overlay = document.createElement('div');
    overlay.className = 'palette-overlay';

    var dialog = document.createElement('div');
    dialog.className = 'howto-dialog';

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });

    var sections = [
      {
        title: 'Tasks & worktrees',
        body: 'Click + in the sidebar to spawn a new task. Each task gets its own git worktree (sibling of the repo) and its own Claude Code instance. Use the New Worktree modal to either create a new branch (type a name) or continue an existing one (pick from the Branch dropdown). The Existing Worktree tab attaches Claude to a pre-existing worktree directory.',
      },
      {
        title: 'Sidebar at a glance',
        body: 'Each task row shows a status dot, mode (cc/sh), name, dirty-state badge (staged / unstaged / untracked + ahead/behind arrows), and a notes button. The header has Δ (toggle diff), ▦ (cycle layout), ! (filter to only-dirty tasks), PR (review surface), + (new task). Drag rows to reorder; double-click to rename.',
      },
      {
        title: 'Diff panel (Δ)',
        body: 'Per-task git overview. Stage/unstage/discard files or hunks, partial-line staging via per-line checkboxes, commit + push, create-PR, and Explain (highlight code, click the floating Explain button). Switch between unified and split views in the file header. Auto-refreshes as the worktree changes.',
      },
      {
        title: 'Reviewing PRs (PR button)',
        body: 'Pulls in someone else\'s PR for review. The Files tab shows the full diff with inline comment threads + draft review-comment composer (Finish review submits everything in one go). Conversation tab is the full GitHub-style comment feed. Checks tab lists CI runs with a Debug button on failures that has Claude diagnose them. Review tab runs an AI review and breaks the result into per-finding cards (Ignore / Implement / Add to PR). Implement-all bundles open findings into one Claude run.',
      },
      {
        title: 'Pop-out & detach',
        body: 'Any task can pop out into its own window via the Pop Out command (Cmd+K → Pop Out). The PR review surface has its own Pop out / Pop back in toggle so you can read a review on a second monitor.',
      },
      {
        title: 'Command palette (Cmd+K)',
        body: 'Fuzzy-search every action: New Task, Toggle Diff Panel, Switch to: <task>, Review Pull Request…, Theme, Preferences, View Logs, About Klaussy. Faster than hunting through menus.',
      },
      {
        title: 'Multi-project',
        body: 'The project switcher (top of the sidebar) lets you swap repos. Add a project with the + next to it. Tasks and PR review state are kept per-project; recently reviewed PRs persist across launches.',
      },
      {
        title: 'Notifications & idle',
        body: 'Klaussy pings the macOS notification center when Claude finishes responding in a backgrounded task. Toggle per-task in the task notes / context menu.',
      },
    ];

    var sectionsHtml = sections.map(function (s) {
      return '<section class="howto-section">'
        + '<h3>' + escHtml(s.title) + '</h3>'
        + '<p>' + escHtml(s.body) + '</p>'
      + '</section>';
    }).join('');

    dialog.innerHTML =
      '<div class="howto-head">'
        + '<h2>How to use Klaussy</h2>'
        + '<button class="howto-close" type="button" title="Close">&times;</button>'
      + '</div>'
      + '<div class="howto-body">' + sectionsHtml + '</div>';

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    dialog.querySelector('.howto-close').addEventListener('click', function () { overlay.remove(); });
  }

  function showLog() {
    var overlay = document.createElement('div');
    overlay.className = 'palette-overlay';

    var viewer = document.createElement('div');
    viewer.className = 'log-viewer';
    viewer.innerHTML =
      '<div class="log-viewer-header">'
        + '<h3>Main Process Logs</h3>'
        + '<div class="log-viewer-actions">'
          + '<button class="log-viewer-copy" type="button" title="Copy all log lines to clipboard">Copy</button>'
          + '<button class="log-viewer-close">&times;</button>'
        + '</div>'
      + '</div>'
      + '<div class="log-viewer-content">Loading...</div>';

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });

    overlay.appendChild(viewer);
    document.body.appendChild(overlay);

    viewer.querySelector('.log-viewer-close').addEventListener('click', function () { overlay.remove(); });

    var rawLogText = '';
    var copyBtn = viewer.querySelector('.log-viewer-copy');
    copyBtn.addEventListener('click', function () {
      if (!rawLogText) return;
      navigator.clipboard.writeText(rawLogText).then(function () {
        var orig = copyBtn.textContent;
        copyBtn.textContent = 'Copied';
        setTimeout(function () { copyBtn.textContent = orig; }, 900);
      });
    });

    window.klaus.getLogs().then(function (logs) {
      var content = viewer.querySelector('.log-viewer-content');
      if (!logs || logs.length === 0) {
        content.textContent = 'No logs yet.';
        copyBtn.disabled = true;
        return;
      }
      // Plain-text version goes to the clipboard so users can paste it
      // straight into a bug report without HTML markup.
      rawLogText = logs.map(function (e) {
        return '[' + (e.time || '') + '] ' + (e.level || 'info').toUpperCase() + ' ' + (e.msg || '');
      }).join('\n');
      content.innerHTML = logs.map(function (entry) {
        var cls = entry.level === 'error' ? 'log-error' : entry.level === 'warn' ? 'log-warn' : 'log-info';
        return '<div class="log-entry ' + cls + '"><span class="log-time">' + escHtml(entry.time.substring(11, 19)) + '</span><span class="log-level">' + escHtml(entry.level) + '</span><span class="log-msg">' + escHtml(entry.msg) + '</span></div>';
      }).join('');
      content.scrollTop = content.scrollHeight;
    });
  }

  // First-run / on-demand setup dialog. Probes gh + claude and only shows
  // when something is missing/unauthed, so the steady-state user never sees
  // it. Has a Re-check button so the user can fix in another terminal and
  // verify without restarting the app.
  async function checkAndPromptDeps(opts) {
    var force = opts && opts.force;
    var deps = await window.klaus.checkDependencies();
    var ghBad = !deps.gh.installed || !deps.gh.authed;
    var claudeBad = !deps.claude.installed;
    if (!ghBad && !claudeBad && !force) return; // all good, stay quiet

    var existing = document.getElementById('deps-overlay');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'deps-overlay';
    overlay.className = 'palette-overlay';

    var dialog = document.createElement('div');
    dialog.className = 'deps-dialog';

    var ghRow = depRow({
      name: 'GitHub CLI (gh)',
      ok: deps.gh.installed && deps.gh.authed,
      missing: !deps.gh.installed,
      version: deps.gh.version,
      problem: !deps.gh.installed ? 'Not installed.'
              : !deps.gh.authed ? 'Installed, but not authenticated.'
              : null,
      fixes: !deps.gh.installed
        ? ['brew install gh', 'gh auth login']
        : !deps.gh.authed ? ['gh auth login'] : [],
    });

    var claudeRow = depRow({
      name: 'Claude Code CLI (claude)',
      ok: deps.claude.installed,
      missing: !deps.claude.installed,
      version: deps.claude.version,
      problem: !deps.claude.installed
        ? 'Not installed (looking for: ' + (deps.claude.path || 'claude') + ').'
        : null,
      fixes: !deps.claude.installed
        ? ['npm install -g @anthropic-ai/claude-code']
        : [],
    });

    var allOkBanner = (!ghBad && !claudeBad)
      ? '<div class="deps-all-ok">All dependencies look good.</div>'
      : '';

    dialog.innerHTML =
      '<div class="deps-head">'
        + '<h2>Setup check</h2>'
        + '<button class="deps-close" type="button" title="Close">&times;</button>'
      + '</div>'
      + '<p class="deps-intro">Klaussy uses these CLIs under the hood. Missing ones cause downstream errors that look cryptic — fix them here first.</p>'
      + allOkBanner
      + '<div class="deps-rows">' + ghRow + claudeRow + '</div>'
      + '<div class="deps-actions">'
        + '<button class="deps-recheck" type="button">Re-check</button>'
        + '<button class="deps-skip" type="button">Continue anyway</button>'
      + '</div>';

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
    dialog.querySelector('.deps-close').addEventListener('click', function () { overlay.remove(); });
    dialog.querySelector('.deps-skip').addEventListener('click', function () { overlay.remove(); });
    dialog.querySelector('.deps-recheck').addEventListener('click', function () {
      overlay.remove();
      checkAndPromptDeps({ force: true });
    });
    dialog.querySelectorAll('.deps-copy').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var text = btn.dataset.copy || '';
        navigator.clipboard.writeText(text).then(function () {
          var orig = btn.textContent;
          btn.textContent = 'Copied';
          setTimeout(function () { btn.textContent = orig; }, 900);
        });
      });
    });
  }

  function depRow(d) {
    var iconCls = d.ok ? 'ok' : d.missing ? 'missing' : 'warn';
    var icon = d.ok ? '\u2713' : d.missing ? '\u2717' : '!';
    var fixes = (d.fixes || []).map(function (cmd) {
      return '<div class="deps-fix">'
        + '<code>' + escHtml(cmd) + '</code>'
        + '<button class="deps-copy" type="button" data-copy="' + escHtml(cmd) + '">Copy</button>'
      + '</div>';
    }).join('');
    return '<div class="deps-row deps-row-' + iconCls + '">'
      + '<div class="deps-row-head">'
        + '<span class="deps-icon ' + iconCls + '">' + icon + '</span>'
        + '<span class="deps-name">' + escHtml(d.name) + '</span>'
        + (d.version ? '<span class="deps-version">' + escHtml(d.version) + '</span>' : '')
      + '</div>'
      + (d.problem ? '<div class="deps-problem">' + escHtml(d.problem) + '</div>' : '')
      + (fixes ? '<div class="deps-fixes">' + fixes + '</div>' : '')
    + '</div>';
  }

  // Open a pre-filled GitHub issue with version info baked in. Saves the
  // user from chasing version + environment when filing a bug; saves us from
  // asking for it later.
  function openFeedback() {
    window.klaus.getAboutInfo().then(function (info) {
      var lines = [
        '**Klaussy**: ' + (info.appVersion || ''),
        '**Electron**: ' + (info.electronVersion || ''),
        '**Node**: ' + (info.nodeVersion || ''),
        '**Claude CLI**: ' + (info.claudeVersion || 'not detected'),
        '',
        '### What happened?',
        '<!-- a few sentences describing the bug or feedback -->',
        '',
        '### What did you expect?',
        '<!-- expected behavior -->',
        '',
        '### Steps to reproduce',
        '1.',
        '2.',
        '3.',
        '',
        '### Logs',
        '<!-- Cmd+K → View Logs → Copy and paste here -->',
      ];
      // Source repo is private — issues live in the public mirror so the
      // first batch of devs can file without source-repo access.
      var url = 'https://github.com/steph-dove/klausify-desktop-feedback/issues/new'
        + '?labels=feedback'
        + '&title=' + encodeURIComponent('[feedback] ')
        + '&body=' + encodeURIComponent(lines.join('\n'));
      window.klaus.openExternal(url);
    });
  }

  return {
    showAbout: showAbout,
    showLog: showLog,
    showHowToUse: showHowToUse,
    checkAndPromptDeps: checkAndPromptDeps,
    openFeedback: openFeedback,
  };
})();
