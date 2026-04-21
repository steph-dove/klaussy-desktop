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

  // Browse Claude skills + slash commands installed on the user's machine
  // (user-level + every klausify project). Click a row to preview the file
  // contents in-app; an explicit "Open in editor" button kicks out to the
  // user's default editor when they actually want to edit.
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

    function refreshAndSelect(targetPath) {
      window.klaus.listSkills().then(function (r) { renderList(r, targetPath); });
    }

    dialog.querySelector('.skills-new').addEventListener('click', function () {
      openCreateForm(previewPane, function (created) {
        if (created && created.path) refreshAndSelect(created.path);
      });
    });

    function renderList(result, autoSelectPath) {
      var skills = (result && result.skills) || [];
      var commands = (result && result.commands) || [];
      if (skills.length === 0 && commands.length === 0) {
        listPane.innerHTML =
          '<div class="skills-empty">'
            + '<p>No skills or slash commands yet.</p>'
            + '<p class="skills-empty-hint">Click <strong>+ New</strong> above to create one, or drop files into ~/.claude/skills/ or ~/.claude/commands/ and reopen.</p>'
          + '</div>';
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
          loadSkillPreview(previewPane, row.dataset.path, row.dataset.name);
        });
      });
      // Selection priority: an explicit autoSelectPath (e.g. just-created
      // file) → otherwise first row.
      var target = autoSelectPath
        ? listPane.querySelector('.skills-row[data-path="' + cssEscape(autoSelectPath) + '"]')
        : listPane.querySelector('.skills-row');
      if (target) target.click();
    }

    window.klaus.listSkills().then(function (result) { renderList(result); });
  }

  // Helper for selector-safe path attribute lookup. Path may contain dots,
  // slashes, etc. — escape the few that break attribute selectors.
  function cssEscape(s) {
    return String(s).replace(/(["\\])/g, '\\$1');
  }

  // Inline create-form rendered into the preview pane. Lets the user pick
  // type (skill / command), scope (user or any klausify project), and a
  // name; on success refreshes the list and opens the new file for editing.
  function openCreateForm(pane, onCreated) {
    Promise.all([
      window.klaus.listProjects(),
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
        var r = await window.klaus.createSkillFile({ type: selectedType, scope: scopeSel.value, name: name });
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

  function loadSkillPreview(pane, filePath, name) {
    pane.innerHTML = '<div class="skills-preview-loading">Loading\u2026</div>';
    window.klaus.readSkillFile(filePath).then(function (result) {
      if (result && result.error) {
        pane.innerHTML = '<div class="skills-preview-empty">Failed to read: ' + escHtml(result.error) + '</div>';
        return;
      }
      var original = (result && result.content) || '';
      pane.innerHTML =
        '<div class="skills-preview-head">'
          + '<div class="skills-preview-title">' + escHtml(name || filePath.split('/').pop()) + '<span class="skills-preview-dirty" hidden>\u00b7 unsaved</span></div>'
          + '<div class="skills-preview-actions">'
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
      ta.value = original;

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
        var r = await window.klaus.writeSkillFile(filePath, ta.value);
        if (r && r.error) {
          alert('Save failed: ' + r.error);
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
    var sourceCls = s.source === 'user' ? 'skills-source-user' : 'skills-source-project';
    return '<div class="skills-row" data-path="' + escHtml(s.path) + '" data-name="' + escHtml(s.name) + '" title="' + escHtml(s.path) + '">'
      + '<div class="skills-row-main">'
        + '<span class="skills-row-name">' + escHtml(s.name) + '</span>'
        + '<span class="skills-row-source ' + sourceCls + '">' + escHtml(s.source) + '</span>'
      + '</div>'
      + (s.description ? '<div class="skills-row-desc">' + escHtml(s.description) + '</div>' : '')
    + '</div>';
  }

  // ---- GitHub accounts ----
  function showGhAccounts() {
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
      window.klaus.ghListAccounts().then(function (r) {
        var accounts = (r && r.accounts) || [];
        if (accounts.length === 0) {
          body.innerHTML = '<div class="skills-empty">'
            + '<p>No gh accounts found.</p>'
            + '<p class="skills-empty-hint">Run <code>gh auth login</code> in a terminal, then reopen this dialog.</p>'
          + '</div>';
          return;
        }
        body.innerHTML = '<p class="gh-accounts-intro">Klaussy uses whichever gh account is active. Click another to switch.</p>'
          + accounts.map(function (a) {
            return '<button class="gh-account-row' + (a.active ? ' active' : '') + '" type="button" data-username="' + escHtml(a.username) + '"' + (a.active ? ' disabled' : '') + '>'
              + '<span class="gh-account-name">' + escHtml(a.username) + '</span>'
              + (a.active ? '<span class="gh-account-badge">active</span>' : '<span class="gh-account-switch">Switch</span>')
            + '</button>';
          }).join('');
        body.querySelectorAll('.gh-account-row[data-username]').forEach(function (btn) {
          btn.addEventListener('click', async function () {
            if (btn.disabled) return;
            btn.disabled = true;
            var orig = btn.querySelector('.gh-account-switch');
            if (orig) orig.textContent = 'Switching\u2026';
            var result = await window.klaus.ghSwitchAccount(btn.dataset.username);
            if (result && result.error) {
              alert('Switch failed: ' + result.error);
              refresh();
              return;
            }
            refresh();
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
      window.klaus.listMemoryFiles().then(function (r) {
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
      var r = await window.klaus.createMemoryFile(filePath);
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
  function showMcpServers() {
    var overlay = document.createElement('div');
    overlay.className = 'palette-overlay';
    var dialog = document.createElement('div');
    dialog.className = 'skills-dialog';
    dialog.innerHTML =
      '<div class="skills-head">'
        + '<h2>MCP servers</h2>'
        + '<button class="skills-close" type="button" title="Close">&times;</button>'
      + '</div>'
      + '<div class="skills-body" style="grid-template-columns:1fr">'
        + '<div class="skills-list-pane" style="border-right:none;">'
          + '<div class="skills-loading">Reading mcp configs\u2026</div>'
        + '</div>'
      + '</div>';
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    dialog.querySelector('.skills-close').addEventListener('click', function () { overlay.remove(); });
    var pane = dialog.querySelector('.skills-list-pane');

    window.klaus.listMcpServers().then(function (r) {
      var servers = (r && r.servers) || [];
      if (servers.length === 0) {
        pane.innerHTML = '<div class="skills-empty">'
          + '<p>No MCP servers configured.</p>'
          + '<p class="skills-empty-hint">Klaussy looks at ~/.claude.json, ~/.claude/mcp.json, and each project\u2019s .mcp.json or .claude/mcp.json. Configure servers there and reopen.</p>'
        + '</div>';
        return;
      }
      pane.innerHTML =
        '<div class="skills-section-head">Configured <span class="skills-section-count">' + servers.length + '</span></div>'
        + '<div class="skills-list">' + servers.map(function (s) {
          var sourceCls = s.sourceKind === 'user' ? 'skills-source-user' : 'skills-source-project';
          var argLine = s.command + (s.args.length ? ' ' + s.args.join(' ') : '');
          return '<div class="skills-row" title="' + escHtml(s.sourceFile) + '">'
            + '<div class="skills-row-main">'
              + '<span class="skills-row-name">' + escHtml(s.name) + '</span>'
              + '<span class="skills-row-source ' + sourceCls + '">' + escHtml(s.source) + '</span>'
              + '<span class="mcp-type">' + escHtml(s.type) + '</span>'
            + '</div>'
            + '<div class="skills-row-desc"><code class="mcp-cmd">' + escHtml(argLine) + '</code></div>'
            + (s.envKeys.length
              ? '<div class="skills-row-desc">env: ' + s.envKeys.map(function (k) { return '<code class="mcp-envkey">' + escHtml(k) + '</code>'; }).join(' ') + '</div>'
              : '')
          + '</div>';
        }).join('') + '</div>';
    });
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

    window.klaus.listPlugins().then(function (r) {
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
        row.addEventListener('click', function () { window.klaus.openSkillFile(row.dataset.path); });
      });
    });
  }

  return {
    showAbout: showAbout,
    showLog: showLog,
    showHowToUse: showHowToUse,
    checkAndPromptDeps: checkAndPromptDeps,
    openFeedback: openFeedback,
    showSkills: showSkills,
    showMemory: showMemory,
    showShortcuts: showShortcuts,
    showMcpServers: showMcpServers,
    showPlugins: showPlugins,
    showGhAccounts: showGhAccounts,
  };
})();
