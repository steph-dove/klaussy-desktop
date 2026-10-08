(function () {
  function byId(id) { return document.getElementById(id); }

  A11y.tabs(byId('diff-tabs'), {
    itemSelector: '.diff-tab',
    label: 'Side panel',
    panelFor: function (tab) { return byId(tab.dataset.tab + '-tab-content'); },
  });
  A11y.tabs(byId('modal-tabs'), {
    itemSelector: '.modal-tab',
    label: 'Session type',
    panelFor: function (tab) { return byId('tab-' + tab.dataset.tab); },
  });
  A11y.tabs(byId('history-sub-tabs'), {
    itemSelector: '.history-sub-tab',
    label: 'History view',
    panelFor: function (tab) { return byId('history-' + tab.dataset.sub + '-content'); },
  });
  A11y.tabs(byId('plan-source-switch'), { itemSelector: '.plan-source-btn', label: 'Plan source' });
  // On a new session arrowing records the pick like a click; only the agent-setup prompt waits for a real activation.
  var shellGroup = document.querySelector('.shell-options');
  A11y.radios(shellGroup, {
    itemSelector: '.shell-option', label: 'Run', orientation: 'both',
    onMove: function (btn) {
      // A pick on the Existing tab hands every saved agent off to one, so arrows only move focus there; Space picks.
      if (window.App.activeTab === 'existing') return;
      window.App.selectedMode = btn.dataset.shell;
      window.App.shellUserPicked = true;
      window.App.shellOptions.forEach(function (b) { b.classList.toggle('active', b === btn); });
    },
  });
  var existingTab = byId('tab-existing');
  function syncResumeHint() {
    if (existingTab.classList.contains('active')) shellGroup.setAttribute('aria-describedby', 'resume-agent-hint');
    else shellGroup.removeAttribute('aria-describedby');
  }
  if (existingTab && byId('resume-agent-hint')) {
    syncResumeHint();
    new MutationObserver(syncResumeHint).observe(existingTab, { attributes: true, attributeFilter: ['class'] });
  }

  // The button sits inside the heading so the cards stay in heading navigation; clicks bubble to the card's handler.
  document.querySelectorAll('.dashboard-card').forEach(function (card) {
    card.querySelectorAll('svg').forEach(function (svg) { svg.setAttribute('aria-hidden', 'true'); });
    const title = card.querySelector('h3');
    if (!title) return;
    const action = document.createElement('span');
    action.className = 'dashboard-card-action';
    // The id moves with the text, which updateEmptyState rewrites.
    if (title.id) { action.id = title.id; title.removeAttribute('id'); }
    while (title.firstChild) action.appendChild(title.firstChild);
    title.appendChild(action);
    A11y.makeButton(action);
    const desc = card.querySelector('.card-content p');
    if (desc) action.setAttribute('aria-describedby', desc.id || (desc.id = card.id + '-desc'));
  });
  A11y.arrowNav(document.querySelector('.empty-dashboard-grid'), '.dashboard-card-action', { orientation: 'both' });

  // btn-diff's .active is the single source of truth for the panel's open state, toggled from several call sites.
  var btnDiff = byId('btn-diff');
  var diffToggles = [btnDiff, byId('diff-reveal')].filter(Boolean);
  function syncDiffExpanded() {
    var open = btnDiff.classList.contains('active');
    diffToggles.forEach(function (b) {
      b.setAttribute('aria-controls', 'diff-panel');
      b.setAttribute('aria-expanded', String(open));
    });
  }
  if (btnDiff) {
    syncDiffExpanded();
    new MutationObserver(syncDiffExpanded).observe(btnDiff, { attributes: true, attributeFilter: ['class'] });
  }

  A11y.arrowNav(byId('task-list'), '.task-main, .session-group-toggle, .session-group-select, .saved-session-resume, .worktree-open-claude, button.collapsed-icon');
})();
