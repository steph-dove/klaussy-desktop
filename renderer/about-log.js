window.Dialogs = (function () {
  var escHtml = AppUtils.escHtml;

  // Write a slash command into the active task's terminal. `run` appends a
  // carriage return to execute immediately. Routes to the active sub-terminal
  // (Shell tab) when one is live, mirroring the drag-drop handler.
  function sendSlashToTerminal(insert, run) {
    var state = window.AppState;
    var id = state && state.activeTaskId;
    if (!insert || id == null) {
      if (window.toast) window.toast.error('Open a terminal first, then insert the command.');
      return false;
    }
    var entry = state.tasks && state.tasks.get(id);
    var subId = entry ? entry.activeSubId : null;
    if (subId != null && entry) {
      var sub = (entry.subTerminals || []).find(function (s) { return s.subId === subId; });
      if (!sub || !sub.alive) subId = null;
    }
    // A trailing space keeps the cursor off the command token (so the CLI's own
    // arg hints show); run-mode submits with \r instead.
    window.klaus.terminal.write(id, insert + (run ? '\r' : ' '), subId);
    return true;
  }

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

    window.klaus.ui.getAboutInfo().then(function (info) {
      // One row per detected AI CLI; falls back to the legacy single-Claude
      // fields if an older main process didn't send the `agents` array.
      var agents = (info.agents && info.agents.length)
        ? info.agents
        : [{ displayName: 'Claude CLI', version: info.claudeVersion }];
      var agentRows = agents.map(function (a) {
        return '<div class="about-row"><span>' + escHtml(a.displayName) + '</span><span>' + escHtml(a.version) + '</span></div>';
      }).join('');
      dialog.innerHTML =
        '<h2>Klaussy</h2>' +
        '<p class="about-tagline">Multi-terminal AI coding-agent worktree manager + PR reviewer.</p>' +
        '<div class="about-rows">' +
          '<div class="about-row"><span>Version</span><span>' + escHtml(info.appVersion) + '</span></div>' +
          '<div class="about-row"><span>Electron</span><span>' + escHtml(info.electronVersion) + '</span></div>' +
          '<div class="about-row"><span>Node</span><span>' + escHtml(info.nodeVersion) + '</span></div>' +
          agentRows +
        '</div>' +
        '<div class="about-actions">' +
          '<button class="about-howto" type="button">How to use</button>' +
          '<button class="about-licenses" type="button">Licenses</button>' +
          '<button class="about-discord" type="button">Join Discord</button>' +
          '<button class="about-close" type="button">Close</button>' +
        '</div>';
      dialog.querySelector('.about-close').addEventListener('click', function () { overlay.remove(); });
      dialog.querySelector('.about-howto').addEventListener('click', function () {
        overlay.remove();
        showHowToUse();
      });
      var licBtn = dialog.querySelector('.about-licenses');
      if (licBtn) licBtn.addEventListener('click', function () {
        overlay.remove();
        showLicenses();
      });
      var discBtn = dialog.querySelector('.about-discord');
      if (discBtn) discBtn.addEventListener('click', function () {
        // Route through gh.openExternal so the invite opens in the user's
        // default browser rather than an Electron webview.
        try { window.klaus.gh.openExternal('https://discord.gg/9bpSdwCx'); } catch {}
      });
    });
  }

  // Open-source attribution shown in About → Licenses: bundled deps, the local
  // Ollama runtime, and the qwen2.5-coder model. Update when adding a shipped/
  // invoked dep — commercial redistribution requires preserving every notice.
  function showLicenses() {
    var entries = [
      { name: 'Electron', license: 'MIT License', copyright: '© GitHub Inc. and Electron contributors', url: 'https://github.com/electron/electron/blob/main/LICENSE' },
      { name: 'Monaco Editor', license: 'MIT License', copyright: '© Microsoft Corporation', url: 'https://github.com/microsoft/monaco-editor/blob/main/LICENSE.md' },
      { name: 'node-pty', license: 'MIT License', copyright: '© Microsoft Corporation', url: 'https://github.com/microsoft/node-pty/blob/main/LICENSE' },
      { name: 'xterm.js', license: 'MIT License', copyright: '© The xterm.js authors', url: 'https://github.com/xtermjs/xterm.js/blob/master/LICENSE' },
      { name: '@xterm addons (fit, search, web-links)', license: 'MIT License', copyright: '© The xterm.js authors', url: 'https://github.com/xtermjs/xterm.js/blob/master/LICENSE' },
      { name: 'highlight.js', license: 'BSD 3-Clause License', copyright: '© 2006, Ivan Sagalaev', url: 'https://github.com/highlightjs/highlight.js/blob/main/LICENSE' },
      { name: 'vscode-languageserver-protocol, vscode-jsonrpc', license: 'MIT License', copyright: '© Microsoft Corporation', url: 'https://github.com/microsoft/vscode-languageserver-node/blob/main/License.txt' },
      { name: 'Ollama (invoked locally for inline AI)', license: 'MIT License', copyright: '© Ollama Inc.', url: 'https://github.com/ollama/ollama/blob/main/LICENSE' },
      { name: 'Qwen2.5-Coder-1.5B (model run via Ollama)', license: 'Apache License 2.0', copyright: '© Alibaba Cloud', url: 'https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B/blob/main/LICENSE' },
    ];

    var overlay = document.createElement('div');
    overlay.className = 'palette-overlay';
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });

    var dialog = document.createElement('div');
    dialog.className = 'licenses-dialog';
    dialog.innerHTML =
      '<div class="licenses-head">'
        + '<h2>Open Source Licenses</h2>'
        + '<button class="licenses-close" type="button" title="Close">&times;</button>'
      + '</div>'
      + '<p class="licenses-preamble">Klaussy is built on the following open-source software. Full license texts are available at the linked sources.</p>'
      + '<div class="licenses-list">'
        + entries.map(function (e) {
          return '<div class="license-row">'
            + '<div class="license-row-head">'
              + '<span class="license-name">' + escHtml(e.name) + '</span>'
              + '<span class="license-kind">' + escHtml(e.license) + '</span>'
            + '</div>'
            + '<div class="license-copyright">' + escHtml(e.copyright) + '</div>'
            + '<a class="license-link" href="' + escHtml(e.url) + '" target="_blank" rel="noopener">View full license</a>'
          + '</div>';
        }).join('')
      + '</div>';

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    dialog.querySelector('.licenses-close').addEventListener('click', function () { overlay.remove(); });

    // External links open in the user's default browser (Electron shell),
    // not inside our renderer — same pattern as web-links in the terminal.
    dialog.querySelectorAll('a.license-link').forEach(function (a) {
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        try { window.klaus.gh.openExternal(a.href); } catch {}
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
        body: 'Click + in the sidebar to spawn a new task. Each task gets its own git worktree (sibling of the repo) and its own agent instance. Use the New Worktree modal to either create a new branch (type a name) or continue an existing one (pick from the Branch dropdown). The Existing Worktree tab attaches an agent to a pre-existing worktree directory.',
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
        body: 'Pulls in someone else\'s PR for review. The Files tab shows the full diff with inline comment threads + draft review-comment composer (Finish review submits everything in one go). Conversation tab is the full GitHub-style comment feed. Checks tab lists CI runs with a Debug button on failures that has the agent diagnose them. Review tab runs an AI review and breaks the result into per-finding cards (Ignore / Implement / Add to PR). Implement-all bundles open findings into one agent run.',
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
        body: 'Klaussy pings the macOS notification center when the agent finishes responding in a backgrounded task. Toggle per-task in the task notes / context menu.',
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

    window.klaus.ui.getLogs().then(function (logs) {
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

  // First-run / on-demand setup dialog. Probes gh + claude, shows only when
  // something is missing/unauthed. Has a Re-check button so the user can fix in
  // another terminal and verify without restarting.
  async function checkAndPromptDeps(opts) {
    var force = opts && opts.force;
    var deps = await window.klaus.gh.checkDependencies();
    var ghBad = !deps.gh.installed || !deps.gh.authed;
    // Agent list: prefer the multi-agent `agents` array; fall back to the
    // legacy single-Claude shape for older main processes.
    var agentList = (deps.agents && deps.agents.length)
      ? deps.agents
      : [{ id: 'claude', name: 'Claude Code CLI (claude)', installed: deps.claude.installed, version: deps.claude.version, path: deps.claude.path, isDefault: true }];
    // The setup gate is "at least one agent installed" — any of Claude / Codex /
    // Gemini / Copilot counts. We auto-prompt only when gh is bad or NO agent is
    // installed, so a Codex-only user is never nagged about a missing Claude.
    var anyAgentInstalled = agentList.some(function (a) { return a.installed; });
    var noAgent = !anyAgentInstalled;
    if (!ghBad && !noAgent && !force) return; // all good, stay quiet

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
      fixes: [],
      // Per-row Sign-in button (handled by the in-app login modal). Missing-
      // binary installs use the global "Install requirements" button below, so
      // the user doesn't click two install buttons in sequence.
      action: (deps.gh.installed && !deps.gh.authed) ? {
        label: 'Sign in to GitHub',
        kind: 'gh-signin',
      } : null,
    });

    // One row per agent. The required Claude CLI is covered by the bundled
    // "Install requirements" button; optional agents get a copyable
    // `npm install -g …` command inline.
    var agentRows = agentList.map(function (a) {
      // Installed but a verified auth probe says not signed in → warn + show
      // the login command. authed===null means "unknown" (no probe) — stay quiet.
      var notSignedIn = a.installed && a.authed === false;
      // With no agent installed, every row is an actionable "pick one" option;
      // once at least one is installed, the rest are just optional extras.
      var problem = !a.installed
        ? (noAgent
            ? 'Not installed (looking for: ' + (a.path || a.id) + ').'
            : 'Optional — not installed (looking for: ' + (a.path || a.id) + ').')
        : (notSignedIn ? 'Installed, but not signed in.' : null);
      var fixes = [];
      if (!a.installed && a.installCommand) fixes.push(a.installCommand); // every agent shows its install command
      if (notSignedIn && a.loginCommand) fixes.push(a.loginCommand);
      return depRow({
        name: a.name,
        ok: a.installed && a.authed !== false,
        missing: !a.installed,
        version: a.version,
        problem: problem,
        fixes: fixes,
      });
    }).join('');

    // A missing REQUIRED CLI → offer one-click install of the essentials
    // bundle. Optional agents are installed via their own copyable command.
    var anyMissing = !deps.gh.installed || noAgent;
    var platformLabel = deps.platform === 'darwin' ? 'macOS'
      : deps.platform === 'win32' ? 'Windows'
      : deps.platform === 'linux' ? 'Linux'
      : 'this system';
    // Spell out exactly what gets installed and why before a 2 GB download. The
    // main-process script is idempotent (installed pieces skipped); this is the
    // full set so the user can audit it once.
    var defaultAgent = agentList.filter(function (a) { return a.isDefault; })[0] || agentList[0] || {};
    var defaultAgentName = defaultAgent.name || 'your AI agent';
    var requirements = [
      { name: 'Node.js + npm',  why: 'Runtime for the agent CLIs and other npm-installed tools.' },
      { name: 'GitHub CLI (gh)', why: 'PR review, CI status, and GitHub auth (the Sign-in button uses gh under the hood).' },
      { name: defaultAgentName, why: 'Your current default AI agent. You can install another any time from the rows above.' },
      { name: 'Ollama',           why: 'Local model server for inline tab-autocomplete. Runs on your machine — no code leaves your laptop. ~2 GB.' },
    ];
    var requirementList = requirements.map(function (r) {
      return '<li><strong>' + escHtml(r.name) + '</strong> — ' + escHtml(r.why) + '</li>';
    }).join('');
    var installSection = anyMissing
      ? '<div class="deps-install-section">'
        + '<details class="deps-install-details">'
          + '<summary>What gets installed?</summary>'
          + '<ul class="deps-install-list">' + requirementList + '</ul>'
        + '</details>'
        + '<button class="deps-install-btn" type="button">Install requirements</button>'
        + '<p class="deps-install-hint">Opens your ' + escHtml(platformLabel) + ' terminal and installs the bundle (~2 GB total — Ollama is the bulk of it). You’ll still complete <code>gh auth login</code> and <code>' + escHtml(defaultAgent.loginCommand || 'agent') + '</code> sign-in once it finishes.</p>'
      + '</div>'
      : '';

    var allOkBanner = (!ghBad && !noAgent)
      ? '<div class="deps-all-ok">All dependencies look good.</div>'
      : '';

    dialog.innerHTML =
      '<div class="deps-head">'
        + '<h2>Setup check</h2>'
        + '<button class="deps-close" type="button" title="Close">&times;</button>'
      + '</div>'
      + '<p class="deps-intro">Klaussy uses these CLIs under the hood. Missing ones cause downstream errors that look cryptic — fix them here first.</p>'
      + allOkBanner
      + '<div class="deps-rows">' + ghRow + agentRows + '</div>'
      + installSection
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
    var ghSigninBtn = dialog.querySelector('[data-action="gh-signin"]');
    if (ghSigninBtn) {
      ghSigninBtn.addEventListener('click', function () {
        showGhLogin({
          onSuccess: function () {
            overlay.remove();
            checkAndPromptDeps({ force: true });
          },
        });
      });
    }
    var installBtn = dialog.querySelector('.deps-install-btn');
    if (installBtn) {
      installBtn.addEventListener('click', async function () {
        var orig = installBtn.textContent;
        installBtn.disabled = true;
        installBtn.textContent = 'Opening terminal…';
        var result = await window.klaus.gh.installRequirements();
        installBtn.disabled = false;
        if (result && result.error) {
          installBtn.textContent = orig;
          if (window.toast && window.toast.error) {
            window.toast.error('Could not start installer: ' + result.error);
          }
          return;
        }
        // The install runs in an external terminal — we can't watch it
        // finish, so prompt the user to re-check once they're done.
        installBtn.textContent = 'Installing in terminal…';
        if (window.toast && window.toast.info) {
          window.toast.info('Installer running in your terminal. Click Re-check when it finishes.');
        }
      });
    }
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
    var actionBtn = d.action
      ? '<button class="deps-action" type="button" data-action="' + escHtml(d.action.kind) + '">' + escHtml(d.action.label) + '</button>'
      : '';
    return '<div class="deps-row deps-row-' + iconCls + '">'
      + '<div class="deps-row-head">'
        + '<span class="deps-icon ' + iconCls + '">' + icon + '</span>'
        + '<span class="deps-name">' + escHtml(d.name) + '</span>'
        + (d.version ? '<span class="deps-version">' + escHtml(d.version) + '</span>' : '')
      + '</div>'
      + (d.problem ? '<div class="deps-problem">' + escHtml(d.problem) + '</div>' : '')
      + (fixes ? '<div class="deps-fixes">' + fixes + '</div>' : '')
      + (actionBtn ? '<div class="deps-action-row">' + actionBtn + '</div>' : '')
    + '</div>';
  }

  // Open a pre-filled GitHub issue with version info baked in. Saves the
  // user from chasing version + environment when filing a bug; saves us from
  // asking for it later.
  function openFeedback() {
    window.klaus.ui.getAboutInfo().then(function (info) {
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
      var url = 'https://github.com/steph-dove/klaussy-desktop-feedback/issues/new'
        + '?labels=feedback'
        + '&title=' + encodeURIComponent('[feedback] ')
        + '&body=' + encodeURIComponent(lines.join('\n'));
      window.klaus.gh.openExternal(url);
    });
  }

  // Browse Claude skills + slash commands installed on the user's machine (user
  // + every klaussy project). Click a row to preview in-app; "Open in editor"
  // kicks out to the user's default editor.
  function showSkills() {
    var overlay = document.createElement('div');
    overlay.className = 'palette-overlay';

    var dialog = document.createElement('div');
    dialog.className = 'skills-dialog';
    dialog.innerHTML =
      '<div class="skills-head">'
        + '<h2>Skills &amp; Commands</h2>'
        + '<div class="skills-head-actions">'
          + '<button class="skills-new" type="button" title="Create a new skill or slash command">+ New</button>'
          + '<button class="skills-close" type="button" title="Close">&times;</button>'
        + '</div>'
      + '</div>'
      + '<div class="skills-search-row">'
        + '<input type="text" class="skills-search" placeholder="Search skills &amp; commands\u2026" autocomplete="off" spellcheck="false" />'
      + '</div>'
      + '<div class="skills-body">'
        + '<div class="skills-list-pane"><div class="skills-loading">Reading ~/.claude\u2026</div></div>'
        + '<div class="skills-preview-pane"><div class="skills-preview-empty">Select a skill or command on the left to preview.</div></div>'
      + '</div>';

    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    dialog.querySelector('.skills-close').addEventListener('click', function () { overlay.remove(); });

    var listPane = dialog.querySelector('.skills-list-pane');
    var previewPane = dialog.querySelector('.skills-preview-pane');
    var searchInput = dialog.querySelector('.skills-search');
    var lastResult = null; // cache so search filters without re-reading disk

    function matchesQuery(s, q) {
      if (!q) return true;
      return ((s.name || '') + ' ' + (s.description || '') + ' ' + (s.source || ''))
        .toLowerCase().indexOf(q) !== -1;
    }

    searchInput.addEventListener('input', function () { if (lastResult) renderList(lastResult); });

    function refreshAndSelect(targetPath) {
      window.klaus.skills.listSkills().then(function (r) { renderList(r, targetPath); });
    }

    dialog.querySelector('.skills-new').addEventListener('click', function () {
      openCreateForm(previewPane, function (created) {
        if (created && created.path) refreshAndSelect(created.path);
      });
    });

    function renderList(result, autoSelectPath) {
      if (result) lastResult = result;
      var rawSkills = (result && result.skills) || [];
      var rawCommands = (result && result.commands) || [];
      if (rawSkills.length === 0 && rawCommands.length === 0) {
        listPane.innerHTML =
          '<div class="skills-empty">'
            + '<p>No skills or slash commands yet.</p>'
            + '<p class="skills-empty-hint">Click <strong>+ New</strong> above to create one, or drop files into ~/.claude/skills/ or ~/.claude/commands/ and reopen.</p>'
          + '</div>';
        return;
      }
      var q = (searchInput.value || '').trim().toLowerCase();
      var skills = rawSkills.filter(function (s) { return matchesQuery(s, q); });
      var commands = rawCommands.filter(function (s) { return matchesQuery(s, q); });
      if (skills.length === 0 && commands.length === 0) {
        listPane.innerHTML = '<div class="skills-empty"><p>No skills or commands match “' + escHtml(q) + '”.</p></div>';
        return;
      }
      var html = '';
      if (skills.length > 0) {
        html += '<div class="skills-section-head">Skills <span class="skills-section-count">' + skills.length + '</span></div>';
        html += '<div class="skills-list">' + skills.map(renderSkillRow).join('') + '</div>';
      }
      if (commands.length > 0) {
        html += '<div class="skills-section-head">Slash commands <span class="skills-section-count">' + commands.length + '</span></div>';
        html += '<div class="skills-list">' + commands.map(renderSkillRow).join('') + '</div>';
      }
      listPane.innerHTML = html;
      listPane.querySelectorAll('.skills-row').forEach(function (row) {
        row.addEventListener('click', function () {
          listPane.querySelectorAll('.skills-row').forEach(function (r) { r.classList.remove('selected'); });
          row.classList.add('selected');
          loadSkillPreview(previewPane, row.dataset.path, row.dataset.name, row.dataset.insert);
        });
      });
      // Selection priority: an explicit autoSelectPath (e.g. just-created
      // file) → otherwise first row.
      var target = autoSelectPath
        ? listPane.querySelector('.skills-row[data-path="' + cssEscape(autoSelectPath) + '"]')
        : listPane.querySelector('.skills-row');
      if (target) target.click();
    }

    window.klaus.skills.listSkills().then(function (result) { renderList(result); });
  }

  // Helper for selector-safe path attribute lookup. Path may contain dots,
  // slashes, etc. — escape the few that break attribute selectors.
  function cssEscape(s) {
    return String(s).replace(/(["\\])/g, '\\$1');
  }

  // Inline create-form rendered into the preview pane. Lets the user pick
  // type (skill / command), scope (user or any klaussy project), and a
  // name; on success refreshes the list and opens the new file for editing.
  function openCreateForm(pane, onCreated) {
    Promise.all([
      window.klaus.repo.listProjects(),
    ]).then(function (results) {
      var projects = results[0] || [];
      var scopeOpts = '<option value="user">User (~/.claude)</option>';
      projects.forEach(function (p) {
        scopeOpts += '<option value="' + cssEscape(p.path) + '">' + escHtml(p.name) + ' (project)</option>';
      });
      pane.innerHTML =
        '<div class="skills-preview-head">'
          + '<div class="skills-preview-title">New skill or command</div>'
        + '</div>'
        + '<div class="skills-create-form">'
          + '<label class="skills-create-row">'
            + '<span>Type</span>'
            + '<div class="skills-create-toggle">'
              + '<button type="button" data-type="skill" class="active">Skill</button>'
              + '<button type="button" data-type="command">Slash command</button>'
            + '</div>'
          + '</label>'
          + '<label class="skills-create-row">'
            + '<span>Scope</span>'
            + '<select class="skills-create-scope">' + scopeOpts + '</select>'
          + '</label>'
          + '<label class="skills-create-row">'
            + '<span>Name</span>'
            + '<input type="text" class="skills-create-name" placeholder="my-skill" autocomplete="off" spellcheck="false" />'
          + '</label>'
          + '<div class="skills-create-hint">Letters, numbers, dashes, underscores.</div>'
          + '<div class="skills-create-error" hidden></div>'
          + '<div class="skills-create-actions">'
            + '<button type="button" class="skills-create-cancel">Cancel</button>'
            + '<button type="button" class="skills-create-go">Create</button>'
          + '</div>'
        + '</div>';

      var typeBtns = pane.querySelectorAll('.skills-create-toggle button');
      var nameInput = pane.querySelector('.skills-create-name');
      var scopeSel = pane.querySelector('.skills-create-scope');
      var goBtn = pane.querySelector('.skills-create-go');
      var cancelBtn = pane.querySelector('.skills-create-cancel');
      var errEl = pane.querySelector('.skills-create-error');
      var selectedType = 'skill';

      typeBtns.forEach(function (b) {
        b.addEventListener('click', function () {
          typeBtns.forEach(function (x) { x.classList.remove('active'); });
          b.classList.add('active');
          selectedType = b.dataset.type;
        });
      });

      cancelBtn.addEventListener('click', function () {
        pane.innerHTML = '<div class="skills-preview-empty">Select a skill or command on the left to preview.</div>';
      });

      async function submit() {
        var name = nameInput.value.trim();
        if (!name) { errEl.hidden = false; errEl.textContent = 'Name is required.'; return; }
        goBtn.disabled = true;
        goBtn.textContent = 'Creating\u2026';
        errEl.hidden = true;
        var r = await window.klaus.skills.createFile({ type: selectedType, scope: scopeSel.value, name: name });
        if (r && r.error) {
          errEl.hidden = false;
          errEl.textContent = r.error;
          goBtn.disabled = false;
          goBtn.textContent = 'Create';
          return;
        }
        if (typeof onCreated === 'function') onCreated(r);
      }
      goBtn.addEventListener('click', submit);
      nameInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
        if (e.key === 'Escape') cancelBtn.click();
      });
      setTimeout(function () { nameInput.focus(); }, 50);
    });
  }

  function loadSkillPreview(pane, filePath, name, insert) {
    pane.innerHTML = '<div class="skills-preview-loading">Loading\u2026</div>';
    window.klaus.skills.readFile(filePath).then(function (result) {
      if (result && result.error) {
        pane.innerHTML = '<div class="skills-preview-empty">Failed to read: ' + escHtml(result.error) + '</div>';
        return;
      }
      var original = (result && result.content) || '';
      // Slash invocation buttons only make sense when we know the command/skill
      // string to type into the terminal.
      var slashBtns = insert
        ? '<button class="skills-preview-insert" type="button" title="Insert ' + escHtml(insert) + ' into the active terminal">Insert</button>'
          + '<button class="skills-preview-run" type="button" title="Run ' + escHtml(insert) + ' in the active terminal">Run</button>'
        : '';
      pane.innerHTML =
        '<div class="skills-preview-head">'
          + '<div class="skills-preview-title">' + escHtml(name || filePath.split('/').pop()) + '<span class="skills-preview-dirty" hidden>\u00b7 unsaved</span></div>'
          + '<div class="skills-preview-actions">'
            + slashBtns
            + '<button class="skills-preview-copy" type="button" title="Copy file contents">Copy</button>'
            + '<button class="skills-preview-save" type="button" title="Save (\u2318S)" disabled>Save</button>'
          + '</div>'
        + '</div>'
        + '<div class="skills-preview-path">' + escHtml(filePath) + '</div>'
        + '<textarea class="skills-preview-editor" spellcheck="false"></textarea>';

      var ta = pane.querySelector('.skills-preview-editor');
      var saveBtn = pane.querySelector('.skills-preview-save');
      var dirtyMark = pane.querySelector('.skills-preview-dirty');
      var copyBtn = pane.querySelector('.skills-preview-copy');
      var insertBtn = pane.querySelector('.skills-preview-insert');
      var runBtn = pane.querySelector('.skills-preview-run');
      ta.value = original;

      if (insertBtn) {
        insertBtn.addEventListener('click', function () {
          if (sendSlashToTerminal(insert, false) && window.toast) window.toast.success('Inserted ' + insert);
        });
      }
      if (runBtn) {
        runBtn.addEventListener('click', function () {
          sendSlashToTerminal(insert, true);
        });
      }

      function setDirty(d) {
        saveBtn.disabled = !d;
        dirtyMark.hidden = !d;
      }

      ta.addEventListener('input', function () { setDirty(ta.value !== original); });
      ta.addEventListener('keydown', function (e) {
        if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); saveBtn.click(); }
      });

      async function save() {
        if (saveBtn.disabled) return;
        saveBtn.disabled = true;
        var origText = saveBtn.textContent;
        saveBtn.textContent = 'Saving\u2026';
        var r = await window.klaus.skills.writeFile(filePath, ta.value);
        if (r && r.error) {
          window.toast.error('Save failed: ' + r.error);
          saveBtn.disabled = false;
          saveBtn.textContent = origText;
          return;
        }
        original = ta.value;
        saveBtn.textContent = 'Saved';
        dirtyMark.hidden = true;
        setTimeout(function () {
          saveBtn.textContent = 'Save';
          // Stay disabled until next edit.
        }, 900);
      }
      saveBtn.addEventListener('click', save);

      copyBtn.addEventListener('click', function () {
        navigator.clipboard.writeText(ta.value).then(function () {
          var orig = copyBtn.textContent;
          copyBtn.textContent = 'Copied';
          setTimeout(function () { copyBtn.textContent = orig; }, 900);
        });
      });
    });
  }

  function renderSkillRow(s) {
    var sourceCls = s.kind === 'user' ? 'skills-source-user'
      : s.kind === 'plugin' ? 'skills-source-plugin'
      : 'skills-source-project';
    return '<div class="skills-row" data-path="' + escHtml(s.path) + '" data-name="' + escHtml(s.name) + '"'
      + ' data-insert="' + escHtml(s.insert || '') + '" data-kind="' + escHtml(s.kind || '') + '"'
      + ' title="' + escHtml(s.path) + '">'
      + '<div class="skills-row-main">'
        + '<span class="skills-row-name">' + escHtml(s.name) + '</span>'
        + '<span class="skills-row-source ' + sourceCls + '">' + escHtml(s.source) + '</span>'
      + '</div>'
      + (s.description ? '<div class="skills-row-desc">' + escHtml(s.description) + '</div>' : '')
    + '</div>';
  }

  // ---- GitHub login (device flow via gh CLI) ----
  // Spawns `gh auth login --web`, surfaces the one-time code, resolves on exit 0.
  // gh does the keyring write so other `gh` code paths agree on where the token lives.
  function showGhLogin(opts) {
    var hostname = (opts && opts.hostname) || 'github.com';
    var onSuccess = (opts && opts.onSuccess) || function () {};
    var onCancel = (opts && opts.onCancel) || function () {};
    var settled = false;
    var overlay = document.createElement('div');
    overlay.className = 'palette-overlay';
    var dialog = document.createElement('div');
    dialog.className = 'gh-login-dialog deps-dialog';
    dialog.innerHTML =
      '<div class="deps-head">'
        + '<h2>Sign in to GitHub</h2>'
        + '<button class="deps-close" type="button" title="Close">&times;</button>'
      + '</div>'
      + '<div class="gh-login-body"><div class="skills-loading">Starting sign-in…</div></div>';
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    var body = dialog.querySelector('.gh-login-body');

    var unsubscribe = null;
    var closed = false;
    function cleanup() {
      if (closed) return;
      closed = true;
      if (unsubscribe) { try { unsubscribe(); } catch (_) {} unsubscribe = null; }
      window.klaus.gh.loginCancel();
      overlay.remove();
      // Notify caller only on user-cancel, not after a successful sign-in
      // (the success handler sets settled=true before tearing down).
      if (!settled) { try { onCancel(); } catch (_) {} }
    }

    overlay.addEventListener('click', function (e) { if (e.target === overlay) cleanup(); });
    dialog.querySelector('.deps-close').addEventListener('click', cleanup);

    function renderCode(code, verificationUrl) {
      body.innerHTML =
        '<p class="gh-login-step">'
          + '<span class="gh-login-num">1</span>'
          + 'Copy this one-time code:'
        + '</p>'
        + '<div class="gh-login-code-row">'
          + '<code class="gh-login-code">' + escHtml(code) + '</code>'
          + '<button class="deps-copy gh-login-copy" type="button" data-copy="' + escHtml(code) + '">Copy</button>'
        + '</div>'
        + '<p class="gh-login-step">'
          + '<span class="gh-login-num">2</span>'
          + 'Paste it at <code>' + escHtml(verificationUrl) + '</code> (a browser tab should have opened automatically).'
        + '</p>'
        + '<div class="deps-actions">'
          + '<button class="gh-login-open" type="button">Open browser</button>'
          + '<button class="deps-skip gh-login-cancel" type="button">Cancel</button>'
        + '</div>'
        + '<p class="gh-login-wait">Waiting for you to authorize…</p>';
      body.querySelector('.gh-login-copy').addEventListener('click', function (e) {
        var btn = e.currentTarget;
        navigator.clipboard.writeText(btn.dataset.copy || '').then(function () {
          var orig = btn.textContent;
          btn.textContent = 'Copied';
          setTimeout(function () { btn.textContent = orig; }, 900);
        });
      });
      body.querySelector('.gh-login-open').addEventListener('click', function () {
        window.klaus.gh.openExternal(verificationUrl);
      });
      body.querySelector('.gh-login-cancel').addEventListener('click', cleanup);
    }

    function renderError(message) {
      body.innerHTML =
        '<div class="gh-login-error">'
          + '<p><strong>Sign-in failed.</strong></p>'
          + '<pre>' + escHtml(message || 'Unknown error') + '</pre>'
        + '</div>'
        + '<div class="deps-actions">'
          + '<button class="gh-login-retry" type="button">Retry</button>'
          + '<button class="deps-skip gh-login-close" type="button">Close</button>'
        + '</div>';
      body.querySelector('.gh-login-retry').addEventListener('click', function () {
        cleanup();
        showGhLogin({ hostname: hostname, onSuccess: onSuccess });
      });
      body.querySelector('.gh-login-close').addEventListener('click', cleanup);
    }

    unsubscribe = window.klaus.gh.onLoginEvent(function (evt) {
      if (closed) return;
      if (evt.type === 'code') {
        renderCode(evt.code, evt.verificationUrl);
      } else if (evt.type === 'success') {
        settled = true;
        body.innerHTML = '<div class="gh-login-success">'
          + '<p>✓ Signed in.</p>'
        + '</div>';
        if (window.toast && window.toast.success) window.toast.success('GitHub sign-in complete');
        var accounts = evt.accounts || [];
        setTimeout(function () {
          // closed=true means user already cancelled; skip both cleanup
          // (avoids double-cancel IPC) and the onSuccess callback.
          if (closed) return;
          closed = true;
          if (unsubscribe) { try { unsubscribe(); } catch (_) {} unsubscribe = null; }
          overlay.remove();
          try { onSuccess({ accounts: accounts }); } catch (_) {}
        }, 600);
      } else if (evt.type === 'error') {
        renderError(evt.message);
      } else if (evt.type === 'cancelled') {
        cleanup();
      }
    });

    window.klaus.gh.loginStart(hostname).then(function (r) {
      if (r && r.error && !closed) renderError(r.error);
    }, function (err) {
      // Rejected IPC (handler threw, channel torn down). Without this the
      // modal would sit on "Starting sign-in…" forever.
      if (!closed) renderError((err && err.message) || 'IPC failed to start sign-in.');
    });
  }

  // ---- GitHub accounts ----
  // opts.onChange (optional) fires after a switch/re-auth so a caller showing
  // stale data can reload without waiting for the dialog to close.
  function showGhAccounts(opts) {
    opts = opts || {};
    var overlay = document.createElement('div');
    overlay.className = 'palette-overlay';
    var dialog = document.createElement('div');
    dialog.className = 'gh-accounts-dialog';
    dialog.innerHTML =
      '<div class="skills-head">'
        + '<h2>GitHub accounts</h2>'
        + '<button class="skills-close" type="button" title="Close">&times;</button>'
      + '</div>'
      + '<div class="gh-accounts-body"><div class="skills-loading">Reading gh auth status\u2026</div></div>';
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    dialog.querySelector('.skills-close').addEventListener('click', function () { overlay.remove(); });
    var body = dialog.querySelector('.gh-accounts-body');

    function refresh() {
      body.innerHTML = '<div class="skills-loading">Reading gh auth status\u2026</div>';
      window.klaus.gh.listAccounts().then(function (r) {
        var accounts = (r && r.accounts) || [];
        if (accounts.length === 0) {
          body.innerHTML = '<div class="skills-empty">'
            + '<p>No gh accounts found.</p>'
            + '<button class="gh-account-add" type="button">Sign in to GitHub</button>'
          + '</div>';
          body.querySelector('.gh-account-add').addEventListener('click', function () {
            showGhLogin({ onSuccess: refresh });
          });
          return;
        }
        // Each row: active+valid \u2192 "active" badge; inactive+valid \u2192 "Switch";
        // any+invalid \u2192 "Re-auth". Keeping invalids in the list (not dropping
        // them) is the point \u2014 one bad token shouldn't hide the other accounts.
        body.innerHTML = '<p class="gh-accounts-intro">Klaussy uses whichever gh account is active. Click another to switch.</p>'
          + accounts.map(function (a) {
            var classes = 'gh-account-row';
            if (a.active) classes += ' active';
            if (!a.valid) classes += ' invalid';
            var status;
            if (!a.valid) status = '<span class="gh-account-status invalid" title="' + escHtml(a.reason || 'Token invalid') + '">' + escHtml(a.reason || 'Token invalid') + '</span><span class="gh-account-action">Re-auth</span>';
            else if (a.active) status = '<span class="gh-account-badge">active</span>';
            else status = '<span class="gh-account-action">Switch</span>';
            var disabledAttr = (a.active && a.valid) ? ' disabled' : '';
            var actionAttr = !a.valid ? 'reauth' : 'switch';
            return '<button class="' + classes + '" type="button"'
              + ' data-username="' + escHtml(a.username) + '"'
              + ' data-action="' + actionAttr + '"' + disabledAttr + '>'
              + '<span class="gh-account-name">' + escHtml(a.username) + '</span>'
              + status
            + '</button>';
          }).join('')
          + '<div class="gh-accounts-foot">'
            + '<button class="gh-account-add" type="button">+ Add another account</button>'
          + '</div>';

        body.querySelector('.gh-account-add').addEventListener('click', function () {
          showGhLogin({ onSuccess: refresh });
        });

        body.querySelectorAll('.gh-account-row[data-username]').forEach(function (btn) {
          btn.addEventListener('click', async function () {
            if (btn.disabled) return;
            var username = btn.dataset.username;
            var action = btn.dataset.action;
            if (action === 'reauth') {
              showGhLogin({ onSuccess: function () { refresh(); if (opts.onChange) try { opts.onChange(); } catch (_) {} } });
              return;
            }
            btn.disabled = true;
            var orig = btn.querySelector('.gh-account-action');
            if (orig) orig.textContent = 'Switching\u2026';
            var result = await window.klaus.gh.switchAccount(username);
            // The switch handler in main returns needsLogin when the
            // target's token is stale \u2014 route to the login modal instead
            // of toasting a confusing error.
            if (result && result.needsLogin) {
              showGhLogin({ onSuccess: function () { refresh(); if (opts.onChange) try { opts.onChange(); } catch (_) {} } });
              return;
            }
            if (result && result.error) {
              window.toast.error('Switch failed: ' + result.error);
              refresh();
              return;
            }
            refresh();
            if (opts.onChange) try { opts.onChange(); } catch (_) {}
          });
        });
      });
    }
    refresh();
  }

  // ---- Memory (CLAUDE.md) ----
  function showMemory() {
    var overlay = document.createElement('div');
    overlay.className = 'palette-overlay';
    var dialog = document.createElement('div');
    dialog.className = 'skills-dialog';
    dialog.innerHTML =
      '<div class="skills-head">'
        + '<h2>Memory (CLAUDE.md)</h2>'
        + '<button class="skills-close" type="button" title="Close">&times;</button>'
      + '</div>'
      + '<div class="skills-body">'
        + '<div class="skills-list-pane"><div class="skills-loading">Reading\u2026</div></div>'
        + '<div class="skills-preview-pane"><div class="skills-preview-empty">Select a scope on the left.</div></div>'
      + '</div>';
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    dialog.querySelector('.skills-close').addEventListener('click', function () { overlay.remove(); });
    var listPane = dialog.querySelector('.skills-list-pane');
    var previewPane = dialog.querySelector('.skills-preview-pane');

    function refresh(targetPath) {
      window.klaus.skills.listMemory().then(function (r) {
        var entries = (r && r.entries) || [];
        listPane.innerHTML =
          '<div class="skills-section-head">Scopes <span class="skills-section-count">' + entries.length + '</span></div>'
          + '<div class="skills-list">' + entries.map(function (e) {
            var sourceCls = e.kind === 'user' ? 'skills-source-user' : 'skills-source-project';
            var statusCls = e.exists ? 'memory-exists' : 'memory-missing';
            return '<div class="skills-row ' + statusCls + '" data-path="' + cssEscape(e.path) + '" data-exists="' + (e.exists ? '1' : '0') + '" title="' + escHtml(e.path) + '">'
              + '<div class="skills-row-main">'
                + '<span class="skills-row-name">' + escHtml(e.scope) + '</span>'
                + '<span class="skills-row-source ' + sourceCls + '">' + escHtml(e.scope) + '</span>'
              + '</div>'
              + '<div class="skills-row-desc">' + (e.exists ? 'CLAUDE.md exists' : 'No CLAUDE.md yet') + '</div>'
            + '</div>';
          }).join('') + '</div>';
        listPane.querySelectorAll('.skills-row').forEach(function (row) {
          row.addEventListener('click', function () {
            listPane.querySelectorAll('.skills-row').forEach(function (r) { r.classList.remove('selected'); });
            row.classList.add('selected');
            var p = row.dataset.path;
            var exists = row.dataset.exists === '1';
            if (exists) {
              loadSkillPreview(previewPane, p, p.split('/').pop());
            } else {
              renderMemoryCreate(previewPane, p, function () { refresh(p); });
            }
          });
        });
        var target = targetPath
          ? listPane.querySelector('.skills-row[data-path="' + cssEscape(targetPath) + '"]')
          : listPane.querySelector('.skills-row');
        if (target) target.click();
      });
    }
    refresh();
  }

  function renderMemoryCreate(pane, filePath, onCreated) {
    pane.innerHTML =
      '<div class="skills-preview-head">'
        + '<div class="skills-preview-title">No CLAUDE.md here yet</div>'
      + '</div>'
      + '<div class="skills-preview-path">' + escHtml(filePath) + '</div>'
      + '<div class="skills-create-form">'
        + '<p class="skills-create-hint" style="margin:0">Create a starter CLAUDE.md for this scope. You can edit it in place after.</p>'
        + '<div class="skills-create-error" hidden></div>'
        + '<div class="skills-create-actions">'
          + '<button class="skills-create-go" type="button">Create CLAUDE.md</button>'
        + '</div>'
      + '</div>';
    var go = pane.querySelector('.skills-create-go');
    var err = pane.querySelector('.skills-create-error');
    go.addEventListener('click', async function () {
      go.disabled = true;
      go.textContent = 'Creating\u2026';
      var r = await window.klaus.skills.createMemory(filePath);
      if (r && r.error) {
        err.hidden = false;
        err.textContent = r.error;
        go.disabled = false;
        go.textContent = 'Create CLAUDE.md';
        return;
      }
      if (typeof onCreated === 'function') onCreated();
    });
  }

  // ---- Keyboard shortcuts ----
  var SHORTCUTS = [
    { keys: '\u2318K', label: 'Open command palette' },
    { keys: '\u2318G', label: 'Toggle diff panel for current task' },
    { keys: '\u2318N', label: 'New window' },
    { keys: '\u2318R', label: 'Reload (resets renderer; main-process state survives)' },
    { keys: '\u2318+ / \u2318\u2212', label: 'Zoom in / out (terminal text)' },
    { keys: '\u23180', label: 'Reset zoom' },
    { keys: '\u2318\u21E7F', label: 'Search inside the active terminal (xterm find)' },
    { keys: 'Double-click task name', label: 'Rename a task' },
    { keys: 'Drag task row', label: 'Reorder tasks in the sidebar' },
    { keys: 'Right-click task row', label: 'Task context menu (kill, restart, pop out, notes\u2026)' },
    { keys: 'Cmd+\u23CE in any composer', label: 'Submit comment / reply / save' },
    { keys: 'Esc', label: 'Close composer / cancel selection / dismiss palette' },
  ];

  function showShortcuts() {
    var overlay = document.createElement('div');
    overlay.className = 'palette-overlay';
    var dialog = document.createElement('div');
    dialog.className = 'shortcuts-dialog';
    dialog.innerHTML =
      '<div class="skills-head">'
        + '<h2>Keyboard shortcuts</h2>'
        + '<button class="skills-close" type="button" title="Close">&times;</button>'
      + '</div>'
      + '<div class="shortcuts-body">'
        + SHORTCUTS.map(function (s) {
          return '<div class="shortcuts-row">'
            + '<span class="shortcuts-keys">' + escHtml(s.keys) + '</span>'
            + '<span class="shortcuts-label">' + escHtml(s.label) + '</span>'
          + '</div>';
        }).join('')
      + '</div>';
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    dialog.querySelector('.skills-close').addEventListener('click', function () { overlay.remove(); });
  }

  // ---- MCP servers ----
  // Full manager: view configured servers across every agent, add from a catalog
  // (or custom), and remove. Format-aware read/write lives in main/util/mcp-config.js.
  function showMcpServers() {
    var overlay = document.createElement('div');
    overlay.className = 'palette-overlay';
    var dialog = document.createElement('div');
    dialog.className = 'skills-dialog mcp-dialog';
    overlay.appendChild(dialog);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);

    var catalog = [];
    var categories = [];
    var targets = [];

    function close() { overlay.remove(); }

    function loadingView(msg) {
      dialog.innerHTML =
        '<div class="skills-head"><h2>MCP servers</h2>'
          + '<button class="skills-close" type="button" title="Close">&times;</button></div>'
        + '<div class="mcp-body"><div class="skills-loading">' + escHtml(msg) + '</div></div>';
      dialog.querySelector('.skills-close').addEventListener('click', close);
    }

    loadingView('Reading MCP configs\u2026');

    Promise.all([window.klaus.mcp.catalog(), window.klaus.mcp.targets()])
      .then(function (res) {
        catalog = (res[0] && res[0].catalog) || [];
        categories = (res[0] && res[0].categories) || [];
        targets = (res[1] && res[1].targets) || [];
        showList();
      })
      .catch(function () { loadingView('Could not load MCP data.'); });

    // ---- List view ----
    function showList() {
      loadingView('Reading MCP configs\u2026');
      window.klaus.mcp.list().then(function (r) {
        var groups = groupServers((r && r.servers) || []);
        dialog.innerHTML =
          '<div class="skills-head">'
            + '<h2>MCP servers</h2>'
            + '<div class="skills-head-actions">'
              + '<button class="skills-new mcp-add-open" type="button">+ Add server</button>'
              + '<button class="skills-close" type="button" title="Close">&times;</button>'
            + '</div>'
          + '</div>'
          + '<div class="mcp-body">' + listBody(groups) + '</div>';
        dialog.querySelector('.skills-close').addEventListener('click', close);
        dialog.querySelector('.mcp-add-open').addEventListener('click', function () { showAdd(null); });
        wireRemove(groups);
        annotateStatus();
      });
    }

    // A server can live in several agents' configs (one "add" fans out). Collapse
    // those into one row keyed by name + scope + definition, so Notion on 6 agents
    // reads as one Notion with six badges, not six rows.
    function groupServers(servers) {
      var map = {};
      var order = [];
      servers.forEach(function (s) {
        var detail = s.type === 'stdio'
          ? (s.command + (s.args && s.args.length ? ' ' + s.args.join(' ') : ''))
          : s.url;
        var key = [s.name, s.scope, s.projectName || '', s.type, detail, (s.envKeys || []).join(',')].join(' ');
        if (!map[key]) {
          map[key] = { name: s.name, scope: s.scope, projectName: s.projectName, type: s.type, detail: detail, envKeys: s.envKeys || [], members: [] };
          order.push(key);
        }
        map[key].members.push({ agentId: s.agentId, agentName: s.agentName, sourceFile: s.sourceFile });
      });
      return order.map(function (k) { return map[k]; });
    }

    function listBody(groups) {
      if (!groups.length) {
        return '<div class="skills-empty">'
          + '<p>No MCP servers configured yet.</p>'
          + '<p class="skills-empty-hint">Click \u201cAdd server\u201d to connect GitHub, Slack, Linear, Jira, Datadog and more \u2014 across Claude, Codex, Cursor, Gemini and the other agents Klaussy drives.</p>'
        + '</div>';
      }
      return '<div class="skills-section-head">Configured <span class="skills-section-count">' + groups.length + '</span></div>'
        + '<div class="skills-list">' + groups.map(groupRowHtml).join('') + '</div>';
    }

    function groupRowHtml(g, i) {
      var scopeLabel = g.scope === 'project' ? ('project' + (g.projectName ? ': ' + g.projectName : '')) : 'user';
      var title = g.members.map(function (m) { return m.sourceFile; }).join('\n');
      var badges = g.members.map(function (m) { return '<span class="mcp-agent-badge">' + escHtml(m.agentName) + '</span>'; }).join('');
      return '<div class="skills-row mcp-row" title="' + escHtml(title) + '">'
        + '<div class="skills-row-main">'
          + '<span class="skills-row-name">' + escHtml(g.name) + '</span>'
          + '<span class="mcp-conn mcp-conn-loading" data-name="' + escHtml(g.name) + '">checking…</span>'
          + '<button class="mcp-connect mcp-hidden" type="button" data-name="' + escHtml(g.name) + '" title="Sign in to this server (opens your browser)">Connect</button>'
          + '<span class="skills-row-source ' + (g.scope === 'user' ? 'skills-source-user' : 'skills-source-project') + '">' + escHtml(scopeLabel) + '</span>'
          + '<span class="mcp-type">' + escHtml(g.type) + '</span>'
          + '<button class="mcp-remove" type="button" data-index="' + i + '" title="Remove from all of its agents">&times;</button>'
        + '</div>'
        + '<div class="skills-row-desc mcp-agent-badges">' + badges + '</div>'
        + '<div class="skills-row-desc"><code class="mcp-cmd">' + escHtml(g.detail) + '</code></div>'
        + (g.envKeys.length
          ? '<div class="skills-row-desc">env: ' + g.envKeys.map(function (k) { return '<code class="mcp-envkey">' + escHtml(k) + '</code>'; }).join(' ') + '</div>'
          : '')
        + '<div class="mcp-authbox mcp-hidden"></div>'
      + '</div>';
    }

    function wireRemove(groups) {
      dialog.querySelectorAll('.mcp-remove').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var g = groups[parseInt(btn.dataset.index, 10)];
          if (!g) return;
          var where = g.members.length > 1 ? g.members.length + ' agents' : g.members[0].agentName;
          if (!window.confirm('Remove \u201c' + g.name + '\u201d from ' + where + ' (' + g.scope + ' scope)?')) return;
          btn.disabled = true;
          Promise.all(g.members.map(function (m) {
            return window.klaus.mcp.remove(m.agentId, g.scope, g.name);
          })).then(function (results) {
            var err = results.filter(function (r) { return !r || r.error; })[0];
            if (err && window.toast) window.toast.error((err && err.error) || 'Remove failed');
            else if (window.toast) window.toast.success('Removed ' + g.name);
            showList();
          });
        });
      });
    }

    // Live connection status, health-checked by `claude mcp list`. Runs async
    // (the check takes a few seconds) and fills each row's pill when it returns.
    // Servers Claude doesn't have configured get no pill (status is Claude-only).
    var STATUS_LABEL = { connected: 'connected', auth: 'needs auth', partial: 'tools failed', failed: 'not connected', unknown: '' };
    function annotateStatus() {
      window.klaus.mcp.status().then(function (r) {
        var byName = (r && r.byName) || {};
        var sourceErr = r && r.error;
        dialog.querySelectorAll('.mcp-row').forEach(function (row) {
          var el = row.querySelector('.mcp-conn');
          if (!el) return;
          var connect = row.querySelector('.mcp-connect');
          var st = byName[el.dataset.name];
          if (!st) {
            // No Claude-side status for this server — leave it blank rather than
            // implying a failure (it may only live in other agents).
            el.className = 'mcp-conn mcp-conn-none';
            el.textContent = '';
            el.title = sourceErr ? 'Status check unavailable' : 'Not in Claude — status unknown';
            if (connect) connect.classList.add('mcp-hidden');
            return;
          }
          el.className = 'mcp-conn mcp-conn-' + st.status;
          el.textContent = STATUS_LABEL[st.status] || st.text;
          el.title = st.text + ' (via claude mcp list)';
          // Offer a sign-in button only when the server actually needs auth.
          if (connect) {
            if (st.status === 'auth') { connect.classList.remove('mcp-hidden'); wireConnect(connect); }
            else connect.classList.add('mcp-hidden');
          }
          // Once connected, retire any open sign-in instructions for this row.
          if (st.status === 'connected') {
            var doneBox = row.querySelector('.mcp-authbox');
            if (doneBox) { doneBox.classList.add('mcp-hidden'); doneBox.innerHTML = ''; }
          }
        });
      }).catch(function () {
        dialog.querySelectorAll('.mcp-conn').forEach(function (el) { el.className = 'mcp-conn mcp-conn-none'; el.textContent = ''; });
      });
    }

    // Sign-in for a needs-auth server. `claude mcp login` is interactive, so it
    // can't run headless; the Connect button opens a persistent instructions box
    // that launches the flow in a real terminal. Stays until closed.
    function wireConnect(btn) {
      if (btn._wired) return;
      btn._wired = true;
      btn.addEventListener('click', function () {
        var name = btn.dataset.name;
        var row = btn.closest('.mcp-row');
        var box = row.querySelector('.mcp-authbox');
        if (!box) return;
        if (!box.classList.contains('mcp-hidden')) { box.classList.add('mcp-hidden'); box.innerHTML = ''; return; }
        var cmd = 'claude mcp login ' + name;
        box.innerHTML =
          '<div class="mcp-auth-head">Sign in to ' + escHtml(name)
            + '<button class="mcp-auth-close" type="button" title="Close">&times;</button></div>'
          + '<div class="mcp-auth-text">This server uses an interactive sign-in. Open a terminal, approve access in your browser, then paste the redirect URL back into the terminal when it asks. Come back and Recheck when done.</div>'
          + '<pre class="mcp-exports">' + escHtml(cmd) + '</pre>'
          + '<div class="mcp-setup-actions">'
            + '<button class="mcp-connect mcp-auth-open" type="button">Open in Terminal</button>'
            + '<button class="skills-create-cancel mcp-auth-copy" type="button">Copy command</button>'
            + '<button class="skills-create-cancel mcp-auth-recheck" type="button">Recheck status</button>'
          + '</div>';
        box.classList.remove('mcp-hidden');
        box.querySelector('.mcp-auth-close').addEventListener('click', function () { box.classList.add('mcp-hidden'); box.innerHTML = ''; });
        box.querySelector('.mcp-auth-open').addEventListener('click', function () {
          window.klaus.mcp.loginTerminal(name).then(function (r) {
            if (r && r.error) { if (window.toast) window.toast.error('Could not open a terminal: ' + r.error); return; }
            if (window.toast) window.toast.info('Terminal opened — finish signing in there, then Recheck.');
          });
        });
        box.querySelector('.mcp-auth-copy').addEventListener('click', function () {
          if (navigator.clipboard) navigator.clipboard.writeText(cmd);
          if (window.toast) window.toast.success('Copied');
        });
        box.querySelector('.mcp-auth-recheck').addEventListener('click', function () { annotateStatus(); });
      });
    }

    // ---- Add view ----
    function showAdd(entry) {
      dialog.innerHTML =
        '<div class="skills-head">'
          + '<h2>Add MCP server</h2>'
          + '<div class="skills-head-actions">'
            + '<button class="skills-create-cancel mcp-back" type="button">\u2190 Back</button>'
            + '<button class="skills-close" type="button" title="Close">&times;</button>'
          + '</div>'
        + '</div>'
        + '<div class="mcp-body">'
          + catalogGrid()
          + formHtml(entry)
        + '</div>';
      dialog.querySelector('.skills-close').addEventListener('click', close);
      dialog.querySelector('.mcp-back').addEventListener('click', showList);
      dialog.querySelectorAll('.mcp-card').forEach(function (card) {
        card.addEventListener('click', function () {
          var id = card.dataset.id;
          showAdd(id ? catalog.find(function (c) { return c.id === id; }) : null);
        });
      });
      wireForm(entry);
    }

    function catalogGrid() {
      var html = '<div class="skills-section-head">Catalog</div><div class="mcp-catalog">';
      categories.forEach(function (cat) {
        var items = catalog.filter(function (c) { return c.category === cat; });
        if (!items.length) return;
        html += '<div class="mcp-cat-label">' + escHtml(cat) + '</div><div class="mcp-card-grid">';
        items.forEach(function (c) {
          var tag = c.auth === 'oauth' ? '<span class="mcp-card-tag">OAuth</span>'
            : (c.auth === 'env' ? '<span class="mcp-card-tag">env</span>' : '');
          html += '<button class="mcp-card" type="button" data-id="' + escHtml(c.id) + '">'
            + '<span class="mcp-card-name">' + escHtml(c.name) + tag + '</span>'
            + '<span class="mcp-card-desc">' + escHtml(c.description || '') + '</span>'
          + '</button>';
        });
        html += '</div>';
      });
      html += '<div class="mcp-card-grid"><button class="mcp-card mcp-card-custom" type="button" data-id="">'
        + '<span class="mcp-card-name">Custom server\u2026</span>'
        + '<span class="mcp-card-desc">Enter command/URL by hand</span></button></div>';
      html += '</div>';
      return html;
    }

    function formHtml(entry) {
      entry = entry || {};
      var type = entry.type || 'stdio';
      var isRemote = type === 'http' || type === 'sse';
      var f = '<div class="skills-section-head">' + (entry.id ? escHtml(entry.name) : 'Custom server') + '</div>';
      f += '<div class="mcp-form">';
      if (entry.note) f += '<div class="mcp-note">' + escHtml(entry.note) + '</div>';
      f += row('Name', '<input class="skills-create-name mcp-in" id="mcp-name" spellcheck="false" value="' + escHtml(entry.id || '') + '" placeholder="my-server">');
      f += row('Transport',
        '<select class="skills-create-scope mcp-in" id="mcp-type">'
          + opt('stdio', 'stdio (local command)', type)
          + opt('http', 'http (remote)', type)
          + opt('sse', 'sse (remote)', type)
        + '</select>');
      // stdio fields
      f += '<div id="mcp-stdio" class="' + (isRemote ? 'mcp-hidden' : '') + '">';
      f += row('Command', '<input class="skills-create-name mcp-in" id="mcp-command" spellcheck="false" value="' + escHtml(entry.command || '') + '" placeholder="npx">');
      f += row('Args', '<input class="skills-create-name mcp-in" id="mcp-args" spellcheck="false" value="' + escHtml((entry.args || []).join(' ')) + '" placeholder="-y some-package">');
      (entry.requiredArgs || []).forEach(function (a, idx) {
        f += row(a.label, '<input class="skills-create-name mcp-in mcp-reqarg" data-idx="' + idx + '" spellcheck="false" placeholder="' + escHtml(a.placeholder || '') + '">');
      });
      f += '</div>';
      // remote field
      f += '<div id="mcp-remote" class="' + (isRemote ? '' : 'mcp-hidden') + '">';
      f += row('URL', '<input class="skills-create-name mcp-in" id="mcp-url" spellcheck="false" value="' + escHtml(entry.url || '') + '" placeholder="https://mcp.example.com/mcp">');
      f += '</div>';
      // Environment variables \u2014 rendered/refreshed by renderEnvBox() so the
      // shell-profile setup block tracks which vars are included.
      f += '<div id="mcp-envbox"></div>';
      // targets — default-check only the user's default agent so a single add
      // doesn't silently fan out to every installed CLI. Others are opt-in.
      f += '<div class="mcp-env-label">Add to agents</div>'
        + '<div class="mcp-targets-hint">Defaults to your default agent — check more to add this server to several at once.</div>'
        + '<div class="mcp-targets">';
      targets.forEach(function (t) {
        var note = !t.installed ? ' <span class="mcp-target-note">(not installed)</span>'
          : (!t.verified ? ' <span class="mcp-target-note">(unverified path)</span>' : '');
        f += '<label class="mcp-target"><input type="checkbox" class="mcp-target-cb" data-agent="' + escHtml(t.id) + '" data-project="' + (t.hasProjectScope ? '1' : '0') + '" data-cansecret="' + (t.canSecretRef ? '1' : '0') + '"' + (t.isDefault ? ' checked' : '') + '> ' + escHtml(t.name) + note + '</label>';
      });
      f += '</div>';
      f += '<div class="mcp-targets-hint mcp-hidden" id="mcp-secret-note">Greyed-out agents can\'t read secrets from the environment, so they\'re excluded for this server.</div>';
      // scope
      var anyProject = targets.some(function (t) { return t.hasProjectScope; });
      f += '<div class="mcp-env-label">Scope</div><div class="mcp-scope">'
        + '<label class="mcp-target"><input type="radio" name="mcp-scope" value="user" checked> User (applies everywhere)</label>'
        + '<label class="mcp-target"><input type="radio" name="mcp-scope" value="project"' + (anyProject ? '' : ' disabled') + '> This project' + (anyProject ? '' : ' <span class="mcp-target-note">(open a repo with a project-scoped agent)</span>') + '</label>'
        + '</div>';
      f += '<div class="skills-create-error mcp-form-error" id="mcp-error" style="margin-left:0"></div>';
      f += '<div class="skills-create-actions"><button class="skills-create-go mcp-submit" type="button">Add server</button></div>';
      f += '</div>';
      return f;

      function row(label, control) {
        return '<div class="mcp-field"><label>' + escHtml(label) + '</label><div class="mcp-control">' + control + '</div></div>';
      }
      function opt(val, label, cur) {
        return '<option value="' + val + '"' + (cur === val ? ' selected' : '') + '>' + escHtml(label) + '</option>';
      }
    }

    // Env-var section. Plain values are written inline; SECRETS (catalog
    // `secret:true`, or a custom row's "secret" toggle) are never stored \u2014 only
    // their name is recorded and each agent pulls the value from the environment.
    function renderEnvBox(entry) {
      entry = entry || {};
      var box = dialog.querySelector('#mcp-envbox');
      var typeSel = dialog.querySelector('#mcp-type');
      var remote = typeSel.value === 'http' || typeSel.value === 'sse';
      if (remote) {
        box.innerHTML = '<div class="mcp-env-label">Authentication</div>'
          + '<div class="mcp-note">Remote servers sign in from your agent on first use (OAuth) \u2014 no environment setup needed here.</div>';
        updateSecretTargets();
        return;
      }
      var reqEnv = entry.requiredEnv || [];
      var optEnv = entry.optionalEnv || [];
      var anySecret = reqEnv.concat(optEnv).some(function (e) { return e.secret; });
      var html = '<div class="mcp-env-label">Environment variables</div>';
      if (anySecret) {
        html += '<div class="mcp-note">Secrets are referenced from your environment, never stored. Set them where your agents can read them (e.g. ~/.zshenv).</div>';
      }
      html += '<div class="mcp-var-list">';
      reqEnv.forEach(function (e) { html += envRow(e, true); });
      optEnv.forEach(function (e) { html += envRow(e, false); });
      html += '<div id="mcp-custom-env"></div>';
      html += '<button class="skills-create-cancel mcp-add-env" type="button">+ Add variable</button>';
      html += '</div>';
      box.innerHTML = html;
      wireEnvBox();
      updateSecretTargets();

      function envRow(e, required) {
        var docs = entry.docsUrl ? ' <a class="mcp-docs-link" href="' + escHtml(entry.docsUrl) + '" target="_blank" rel="noreferrer">where to get this</a>' : '';
        if (e.secret) {
          return '<div class="mcp-field"><label>' + escHtml(e.label || e.key) + (required ? ' *' : '') + '</label>'
            + '<div class="mcp-control mcp-secret-ref" data-env-key="' + escHtml(e.key) + '">'
            + '<code class="mcp-envkey">' + escHtml(e.key) + '</code> <span class="mcp-var-label">referenced from your environment' + docs + '</span></div></div>';
        }
        return '<div class="mcp-field"><label>' + escHtml(e.label || e.key) + (required ? ' *' : '') + '</label>'
          + '<div class="mcp-control">'
          + '<input class="skills-create-name mcp-in mcp-env-fixed" type="text" autocomplete="off" data-env-key="' + escHtml(e.key) + '"' + (required ? ' data-required="1"' : '') + ' spellcheck="false" placeholder="' + escHtml(e.placeholder || '') + '">'
          + '<span class="mcp-env-keyname">' + escHtml(e.key) + '</span></div></div>';
      }
    }

    // Split form input into literal values (`env`) and secret names to pull from
    // the environment (`secretRefs`). Required-but-empty value \u2192 `missing`.
    function collectEnv() {
      var env = {};
      var secretRefs = [];
      var missing = null;
      var bad = null;
      dialog.querySelectorAll('.mcp-env-fixed').forEach(function (inp) {
        var v = inp.value.trim();
        if (v) env[inp.dataset.envKey] = v;
        else if (inp.dataset.required) missing = inp.dataset.envKey;
      });
      dialog.querySelectorAll('.mcp-secret-ref').forEach(function (el) { secretRefs.push(el.dataset.envKey); });
      dialog.querySelectorAll('.mcp-custom-row').forEach(function (rowEl) {
        var k = rowEl.querySelector('.mcp-env-k').value.trim();
        if (!k) return;
        if (!/^[A-Za-z0-9_]+$/.test(k)) { bad = k; return; }
        if (rowEl.querySelector('.mcp-env-secret').checked) secretRefs.push(k);
        else env[k] = rowEl.querySelector('.mcp-env-v').value;
      });
      return { env: env, secretRefs: secretRefs, missing: missing, bad: bad };
    }

    function wireEnvBox() {
      var addBtn = dialog.querySelector('.mcp-add-env');
      if (!addBtn) return;
      addBtn.addEventListener('click', function () {
        var hostBox = dialog.querySelector('#mcp-custom-env');
        var rowEl = document.createElement('div');
        rowEl.className = 'mcp-field mcp-custom-row';
        rowEl.innerHTML = '<label></label><div class="mcp-control mcp-custom-pair">'
          + '<input class="skills-create-name mcp-in mcp-env-k" spellcheck="false" placeholder="VAR_NAME">'
          + '<input class="skills-create-name mcp-in mcp-env-v" spellcheck="false" placeholder="value">'
          + '<label class="mcp-secret-toggle" title="Secret \u2014 referenced from your environment, never stored"><input type="checkbox" class="mcp-env-secret"> secret</label>'
          + '<button class="skills-create-cancel mcp-env-del" type="button" title="Remove">&times;</button>'
        + '</div>';
        var valInput = rowEl.querySelector('.mcp-env-v');
        rowEl.querySelector('.mcp-env-secret').addEventListener('change', function () {
          valInput.classList.toggle('mcp-hidden', this.checked);
          updateSecretTargets();
        });
        rowEl.querySelector('.mcp-env-del').addEventListener('click', function () { rowEl.remove(); updateSecretTargets(); });
        hostBox.appendChild(rowEl);
      });
    }

    // When the server needs a secret, disable agents that can't reference env
    // vars (Copilot/Cline/Antigravity) \u2014 we never store the secret for them.
    function updateSecretTargets() {
      var hasSecret = dialog.querySelectorAll('.mcp-secret-ref').length > 0
        || Array.prototype.some.call(dialog.querySelectorAll('.mcp-env-secret'), function (cb) { return cb.checked; });
      var noteEl = dialog.querySelector('#mcp-secret-note');
      if (noteEl) noteEl.classList.toggle('mcp-hidden', !hasSecret);
      dialog.querySelectorAll('.mcp-target-cb').forEach(function (cb) {
        if (cb.dataset.cansecret === '1') return;
        var label = cb.closest('.mcp-target');
        if (hasSecret) { cb.checked = false; cb.disabled = true; if (label) label.classList.add('mcp-target-disabled'); }
        else { cb.disabled = false; if (label) label.classList.remove('mcp-target-disabled'); }
      });
    }

    function wireForm(entry) {
      var typeSel = dialog.querySelector('#mcp-type');
      var stdioBox = dialog.querySelector('#mcp-stdio');
      var remoteBox = dialog.querySelector('#mcp-remote');
      typeSel.addEventListener('change', function () {
        var remote = typeSel.value === 'http' || typeSel.value === 'sse';
        stdioBox.classList.toggle('mcp-hidden', remote);
        remoteBox.classList.toggle('mcp-hidden', !remote);
        renderEnvBox(entry);
      });
      renderEnvBox(entry);
      dialog.querySelector('.mcp-submit').addEventListener('click', function () { submit(entry); });
    }

    function fail(msg) {
      var el = dialog.querySelector('#mcp-error');
      if (el) el.textContent = msg;
    }

    function submit(entry) {
      entry = entry || {};
      var name = dialog.querySelector('#mcp-name').value.trim();
      var type = dialog.querySelector('#mcp-type').value;
      var remote = type === 'http' || type === 'sse';
      if (!name) return fail('A server name is required.');
      if (!/^[\w.-]+$/.test(name)) return fail('Name may contain only letters, numbers, dot, dash, underscore.');

      var server = { name: name, type: type };
      if (remote) {
        var url = dialog.querySelector('#mcp-url').value.trim();
        if (!url) return fail('A URL is required for http/sse servers.');
        server.url = url;
      } else {
        var command = dialog.querySelector('#mcp-command').value.trim();
        if (!command) return fail('A command is required for stdio servers.');
        server.command = command;
        var args = dialog.querySelector('#mcp-args').value.trim().split(/\s+/).filter(Boolean);
        var missingArg = false;
        dialog.querySelectorAll('.mcp-reqarg').forEach(function (inp) {
          var v = inp.value.trim();
          if (!v) missingArg = true;
          else args.push(v);
        });
        if (missingArg) return fail('Fill in all required arguments.');
        server.args = args;
        var built = collectEnv();
        if (built.bad) return fail('Variable name \u201c' + built.bad + '\u201d may contain only letters, numbers, underscore.');
        if (built.missing) return fail('Required variable \u201c' + built.missing + '\u201d is empty.');
        if (Object.keys(built.env).length) server.env = built.env;
        if (built.secretRefs.length) server.secretRefs = built.secretRefs;
      }

      var scope = (dialog.querySelector('input[name="mcp-scope"]:checked') || {}).value || 'user';
      var chosen = [];
      dialog.querySelectorAll('.mcp-target-cb:checked').forEach(function (cb) {
        chosen.push({ id: cb.dataset.agent, hasProject: cb.dataset.project === '1' });
      });
      if (!chosen.length) return fail('Pick at least one agent to add this server to.');

      var writeTargets = chosen;
      var skipped = [];
      if (scope === 'project') {
        writeTargets = chosen.filter(function (t) { return t.hasProject; });
        skipped = chosen.filter(function (t) { return !t.hasProject; });
        if (!writeTargets.length) return fail('None of the selected agents support project scope here.');
      }

      fail('');
      var btn = dialog.querySelector('.mcp-submit');
      btn.disabled = true;
      btn.textContent = 'Adding\u2026';
      Promise.all(writeTargets.map(function (t) {
        return window.klaus.mcp.add(t.id, scope, server).then(function (r) { return { id: t.id, res: r }; });
      })).then(function (results) {
        var ok = results.filter(function (r) { return r.res && r.res.ok; });
        var errs = results.filter(function (r) { return !r.res || r.res.error; });
        if (ok.length && window.toast) {
          window.toast.success('Added ' + name + ' to ' + ok.length + ' agent' + (ok.length > 1 ? 's' : '')
            + (skipped.length ? ' (' + skipped.length + ' skipped \u2014 no project scope)' : ''));
        }
        if (errs.length) {
          btn.disabled = false;
          btn.textContent = 'Add server';
          fail('Failed for ' + errs.length + ' agent(s): ' + errs.map(function (e) { return (e.res && e.res.error) || e.id; }).join('; '));
          return;
        }
        showList();
      });
    }
  }

  // ---- Plugins ----
  function showPlugins() {
    var overlay = document.createElement('div');
    overlay.className = 'palette-overlay';
    var dialog = document.createElement('div');
    dialog.className = 'skills-dialog';
    dialog.innerHTML =
      '<div class="skills-head">'
        + '<h2>Plugins</h2>'
        + '<button class="skills-close" type="button" title="Close">&times;</button>'
      + '</div>'
      + '<div class="skills-body" style="grid-template-columns:1fr">'
        + '<div class="skills-list-pane" style="border-right:none;">'
          + '<div class="skills-loading">Reading ~/.claude/plugins\u2026</div>'
        + '</div>'
      + '</div>';
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    dialog.querySelector('.skills-close').addEventListener('click', function () { overlay.remove(); });
    var pane = dialog.querySelector('.skills-list-pane');

    window.klaus.skills.listPlugins().then(function (r) {
      var plugins = (r && r.plugins) || [];
      if (plugins.length === 0) {
        pane.innerHTML = '<div class="skills-empty">'
          + '<p>No plugins installed.</p>'
          + '<p class="skills-empty-hint">Install plugins via <code>claude plugin install</code>; they live in ~/.claude/plugins/.</p>'
        + '</div>';
        return;
      }
      pane.innerHTML =
        '<div class="skills-section-head">Installed <span class="skills-section-count">' + plugins.length + '</span></div>'
        + '<div class="skills-list">' + plugins.map(function (p) {
          return '<div class="skills-row" data-path="' + cssEscape(p.path) + '" title="' + escHtml(p.path) + '">'
            + '<div class="skills-row-main">'
              + '<span class="skills-row-name">' + escHtml(p.name) + '</span>'
              + (p.version ? '<span class="plugin-version">' + escHtml(p.version) + '</span>' : '')
              + (p.author ? '<span class="plugin-author">by ' + escHtml(p.author) + '</span>' : '')
            + '</div>'
            + (p.description ? '<div class="skills-row-desc">' + escHtml(p.description) + '</div>' : '')
            + (p.bundles.length ? '<div class="skills-row-desc">includes: ' + p.bundles.map(escHtml).join(', ') + '</div>' : '')
          + '</div>';
        }).join('') + '</div>';
      pane.querySelectorAll('.skills-row').forEach(function (row) {
        row.addEventListener('click', function () { window.klaus.skills.openFile(row.dataset.path); });
      });
    });
  }

  // Quick slash-command launcher. Lists every discovered command/skill and, on
  // pick, types it into the active terminal. Enter runs it; ⌘/Ctrl+Enter (or
  // "Insert") just inserts it for editing.
  function showSlashLauncher() {
    var overlay = document.createElement('div');
    overlay.className = 'palette-overlay';
    var palette = document.createElement('div');
    palette.className = 'palette slash-launcher';
    palette.innerHTML =
      '<input type="text" class="palette-input" placeholder="Run a slash command…  (Enter runs, ⌘Enter inserts)" autocomplete="off" spellcheck="false" value="/" />'
      + '<div class="palette-list"><div class="skills-loading">Reading installed commands…</div></div>';
    overlay.appendChild(palette);
    document.body.appendChild(overlay);
    var input = palette.querySelector('.palette-input');
    var list = palette.querySelector('.palette-list');

    function close() { overlay.remove(); }
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });

    var all = [];
    var filtered = [];
    var sel = 0;

    function render() {
      if (filtered.length === 0) {
        list.innerHTML = '<div class="palette-item palette-empty">No matching commands</div>';
        return;
      }
      list.innerHTML = filtered.map(function (c, i) {
        var cls = c.kind === 'user' ? 'skills-source-user' : c.kind === 'plugin' ? 'skills-source-plugin' : 'skills-source-project';
        return '<div class="palette-item' + (i === sel ? ' selected' : '') + '" data-i="' + i + '">'
          + '<span class="slash-cmd-name">' + escHtml(c.insert) + '</span>'
          + '<span class="skills-row-source ' + cls + '">' + escHtml(c.source) + '</span>'
          + (c.description ? '<div class="slash-cmd-desc">' + escHtml(c.description) + '</div>' : '')
        + '</div>';
      }).join('');
      list.querySelectorAll('.palette-item[data-i]').forEach(function (el) {
        el.addEventListener('click', function () { pick(filtered[+el.dataset.i], false); });
        el.addEventListener('mouseenter', function () { sel = +el.dataset.i; paint(); });
      });
    }
    function paint() {
      list.querySelectorAll('.palette-item').forEach(function (el, i) {
        el.classList.toggle('selected', i === sel);
      });
    }
    function applyFilter() {
      var q = input.value.replace(/^\//, '').toLowerCase().trim();
      filtered = all.filter(function (c) {
        return !q || c.insert.toLowerCase().indexOf(q) !== -1
          || (c.description && c.description.toLowerCase().indexOf(q) !== -1);
      });
      sel = 0;
      render();
    }
    function pick(c, run) {
      if (!c) return;
      close();
      if (sendSlashToTerminal(c.insert, run) && !run && window.toast) window.toast.success('Inserted ' + c.insert);
    }

    input.addEventListener('input', applyFilter);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, filtered.length - 1); paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); paint(); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(filtered[sel], !(e.metaKey || e.ctrlKey)); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });

    window.klaus.skills.listSkills().then(function (r) {
      // Commands are the typeable slash entries; include user-invocable skills
      // too since the CLI exposes those at `/` as well.
      var cmds = (r && r.commands) || [];
      var skills = ((r && r.skills) || []).filter(function (s) { return s.insert; });
      all = cmds.concat(skills);
      applyFilter();
      // Keep the caret after the leading "/".
      input.setSelectionRange(input.value.length, input.value.length);
    });
    setTimeout(function () { input.focus(); }, 50);
  }

  return {
    showAbout: showAbout,
    showLog: showLog,
    showSlashLauncher: showSlashLauncher,
    showHowToUse: showHowToUse,
    showLicenses: showLicenses,
    checkAndPromptDeps: checkAndPromptDeps,
    openFeedback: openFeedback,
    showSkills: showSkills,
    showMemory: showMemory,
    showShortcuts: showShortcuts,
    showMcpServers: showMcpServers,
    showPlugins: showPlugins,
    showGhAccounts: showGhAccounts,
    showGhLogin: showGhLogin,
  };
})();
