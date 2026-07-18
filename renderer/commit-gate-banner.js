// The "Enable Commit Review Gate" banner under the repo filter. It appears
// only when a single repo is selected AND that repo has no Klaussy pre-commit
// hook installed; enabling it drives the same installer the app runs
// automatically (state/precommit-hook.js), so worktrees, hook chaining, and
// opt-out all behave identically to hooks installed on session create.
window.CommitGateBanner = (function () {
  var el = document.getElementById('commit-gate-banner');
  var btn = document.getElementById('btn-enable-commit-gate');
  // The repo the banner currently reflects. Guards against a slow hookStatus
  // resolving after the user has already switched to another repo.
  var shownRepo = null;

  function hide() {
    shownRepo = null;
    if (el) el.hidden = true;
  }

  // Query the gate status for `repoPath` and show/hide accordingly. Passing a
  // falsy repo (e.g. the "All repos" filter) just hides the banner.
  function update(repoPath) {
    if (!el || !btn) return;
    if (!repoPath) { hide(); return; }
    window.klaus.repo.hookStatus(repoPath).then(function (status) {
      // Stale response — the selection moved on while we were awaiting.
      if (AppState.selectedRepoFilter !== repoPath) return;
      if (!status || status.installed) { hide(); return; }
      shownRepo = repoPath;
      el.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Enable Commit Review Gate';
    }).catch(function () { hide(); });
  }

  if (btn) {
    btn.addEventListener('click', function () {
      var repoPath = shownRepo;
      if (!repoPath) return;
      btn.disabled = true;
      btn.textContent = 'Enabling…';
      window.klaus.repo.installHook(repoPath).then(function (res) {
        if (res && res.ok && res.installed) {
          hide();
          if (window.toast) window.toast.success('Commit review gate enabled.');
        } else {
          btn.disabled = false;
          btn.textContent = 'Enable Commit Review Gate';
          if (window.toast) {
            window.toast.error('Could not enable the commit review gate' + (res && res.error ? ': ' + res.error : '.'));
          }
        }
      }).catch(function (err) {
        btn.disabled = false;
        btn.textContent = 'Enable Commit Review Gate';
        if (window.toast) window.toast.error('Could not enable the commit review gate: ' + (err.message || err));
      });
    });
  }

  return { update: update, hide: hide };
})();
