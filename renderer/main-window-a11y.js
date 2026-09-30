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
  // Arrowing only moves the choice; the click handler's handoff flag and setup prompt wait for a real activation.
  A11y.radios(document.querySelector('.shell-options'), {
    itemSelector: '.shell-option', label: 'Run', orientation: 'both',
    onMove: function (btn) {
      App.selectedMode = btn.dataset.shell;
      App.shellOptions.forEach(function (b) { b.classList.toggle('active', b === btn); });
    },
  });

  document.querySelectorAll('.dashboard-card').forEach(function (card) {
    A11y.makeButton(card);
    card.querySelectorAll('svg').forEach(function (svg) { svg.setAttribute('aria-hidden', 'true'); });
    const title = card.querySelector('h3');
    const desc = card.querySelector('.card-content p');
    if (title) card.setAttribute('aria-labelledby', title.id || (title.id = card.id + '-title'));
    if (desc) card.setAttribute('aria-describedby', desc.id || (desc.id = card.id + '-desc'));
  });
  A11y.arrowNav(document.querySelector('.empty-dashboard-grid'), '.dashboard-card', { orientation: 'both' });

  A11y.arrowNav(byId('task-list'), '.task-main, .session-group-toggle, .session-group-select, .saved-session-resume, .worktree-open-claude, button.collapsed-icon');
})();
