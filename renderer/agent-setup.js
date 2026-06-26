// "Agent isn't installed" setup prompt.
//
// When a user picks an AI agent whose CLI isn't on their machine, spawning it
// would just print "command not found" into a terminal with no guidance. This
// module probes the agent and, when it's missing, shows a modal that explains
// the situation and offers a one-click path to set it up: the install command
// (copyable), a link to the agent's docs, and a Re-check button.
//
// Public API (all no-ops gracefully if window.klaus is unavailable):
//   window.agentSetup.checkAndPrompt(mode) -> Promise<boolean>
//     true  = installed (or 'shell'/unknown) → caller may proceed.
//     false = missing → the modal was shown; caller should NOT spawn.
//
// Self-contained like toast.js: it injects its own overlay + styles on first
// use and reuses the app's .klaus-modal classes so it matches the other modals.

(function () {
  var overlay = null;
  var els = {};

  function build() {
    if (overlay) return;

    // A little extra styling for the command box + docs link; the modal frame
    // itself rides on the existing .klaus-modal-* classes.
    var style = document.createElement('style');
    style.textContent = ''
      + '#agent-setup-overlay .agent-setup-lead{margin:0 0 12px;line-height:1.5;}'
      + '#agent-setup-overlay .agent-setup-cmd{display:flex;align-items:stretch;gap:8px;margin:12px 0;}'
      + '#agent-setup-overlay .agent-setup-cmd code{flex:1;font-family:"SF Mono",Menlo,monospace;font-size:12px;'
      + 'background:#11111b;color:#e8e8f0;border:1px solid rgba(255,255,255,0.1);border-radius:6px;'
      + 'padding:8px 10px;white-space:pre-wrap;word-break:break-all;user-select:text;}'
      + '#agent-setup-overlay .agent-setup-note{font-size:12px;opacity:0.7;margin:8px 0 0;line-height:1.5;}'
      + '#agent-setup-overlay .agent-setup-docs{color:#64b5f6;cursor:pointer;text-decoration:none;}'
      + '#agent-setup-overlay .agent-setup-docs:hover{text-decoration:underline;}';
    document.head.appendChild(style);

    overlay = document.createElement('div');
    overlay.id = 'agent-setup-overlay';
    overlay.className = 'klaus-modal-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = ''
      + '<div class="klaus-modal">'
      + '  <h3 id="agent-setup-title"></h3>'
      + '  <p class="agent-setup-lead" id="agent-setup-lead"></p>'
      + '  <div class="agent-setup-cmd" id="agent-setup-cmd-row">'
      + '    <code id="agent-setup-cmd"></code>'
      + '    <button id="agent-setup-copy" class="klaus-btn klaus-btn-secondary" type="button">Copy</button>'
      + '  </div>'
      + '  <p class="agent-setup-note" id="agent-setup-note"></p>'
      + '  <div class="klaus-modal-actions">'
      + '    <button id="agent-setup-close" class="klaus-btn klaus-btn-ghost" type="button">Close</button>'
      + '    <button id="agent-setup-docs" class="klaus-btn klaus-btn-secondary" type="button">View docs</button>'
      + '    <button id="agent-setup-recheck" class="klaus-btn klaus-btn-primary" type="button">Re-check</button>'
      + '  </div>'
      + '</div>';
    document.body.appendChild(overlay);

    els = {
      title: overlay.querySelector('#agent-setup-title'),
      lead: overlay.querySelector('#agent-setup-lead'),
      cmdRow: overlay.querySelector('#agent-setup-cmd-row'),
      cmd: overlay.querySelector('#agent-setup-cmd'),
      copy: overlay.querySelector('#agent-setup-copy'),
      note: overlay.querySelector('#agent-setup-note'),
      close: overlay.querySelector('#agent-setup-close'),
      docs: overlay.querySelector('#agent-setup-docs'),
      recheck: overlay.querySelector('#agent-setup-recheck'),
    };

    els.close.addEventListener('click', hide);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) hide(); });
    document.addEventListener('keydown', function (e) {
      if (overlay.style.display !== 'none' && e.key === 'Escape') hide();
    });
  }

  function hide() { if (overlay) overlay.style.display = 'none'; }

  function setText(el, text) { if (el) el.textContent = text == null ? '' : String(text); }

  // Show the setup modal for a probed-missing agent. `info` is the enriched
  // get-agent-info payload ({ displayName, installCommand, docsUrl, ... }).
  // Returns a Promise that resolves true if a re-check found it installed.
  function showMissing(mode, info) {
    build();
    var name = (info && info.displayName) || mode;
    var cmd = info && info.installCommand;
    var docs = info && info.docsUrl;

    setText(els.title, name + ' isn’t installed');
    setText(els.lead, 'You picked ' + name + ', but its command-line tool isn’t on your PATH yet. '
      + 'Install it below (or set a custom path in Preferences → AI CLIs), then re-check.');

    if (cmd) {
      els.cmdRow.style.display = '';
      setText(els.cmd, cmd);
    } else {
      // No known one-line installer (rare) — fall back to docs only.
      els.cmdRow.style.display = 'none';
    }
    setText(els.note, info && info.loginCommand
      ? 'After installing, sign in with: ' + info.loginCommand
      : '');

    els.docs.style.display = docs ? '' : 'none';

    return new Promise(function (resolve) {
      var settled = false;
      function finish(installed) {
        if (settled) return;
        settled = true;
        els.copy.onclick = null; els.docs.onclick = null;
        els.recheck.onclick = null; els.close.onclick = null;
        els.close.addEventListener('click', hide); // restore default close
        hide();
        resolve(!!installed);
      }

      els.copy.onclick = function () {
        if (!cmd) return;
        try { window.klaus.fs.copyToClipboard(cmd); } catch (_e) {}
        setText(els.copy, 'Copied');
        setTimeout(function () { setText(els.copy, 'Copy'); }, 1500);
      };
      els.docs.onclick = function () {
        if (docs) { try { window.klaus.gh.openExternal(docs); } catch (_e) {} }
      };
      els.close.onclick = function () { finish(false); };
      els.recheck.onclick = async function () {
        setText(els.recheck, 'Checking…');
        els.recheck.disabled = true;
        var ok = false;
        try {
          var fresh = await window.klaus.ui.getAgentInfo(mode);
          ok = !!(fresh && fresh.installed);
        } catch (_e) {}
        els.recheck.disabled = false;
        setText(els.recheck, 'Re-check');
        if (ok) {
          if (window.toast) window.toast.success(name + ' is ready.');
          finish(true);
        } else if (window.toast) {
          window.toast.warn(name + ' still not found. Make sure the install finished and the CLI is on your PATH.');
        }
      };

      overlay.style.display = 'flex';
    });
  }

  // Probe `mode`; if the agent isn't installed, show the setup prompt and
  // resolve false. Resolves true for installed agents, 'shell', or when we
  // can't probe (never block the user on an IPC hiccup).
  async function checkAndPrompt(mode) {
    if (!mode || mode === 'shell') return true;
    if (!window.klaus || !window.klaus.ui || !window.klaus.ui.getAgentInfo) return true;
    var info;
    try {
      info = await window.klaus.ui.getAgentInfo(mode);
    } catch (_e) {
      return true; // probe failed — don't block; the spawn will surface any error
    }
    if (info && info.installed) return true;
    return showMissing(mode, info || {});
  }

  window.agentSetup = { checkAndPrompt: checkAndPrompt };
})();
