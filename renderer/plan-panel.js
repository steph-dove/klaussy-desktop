// Plan panel module — find the worktree's markdown plan and (optional) design
// doc, render whichever is selected, and track task-checkbox progress (overall
// + per-phase) for the plan. The progress card is collapsible; a source
// switcher appears when both a plan and a design doc exist.
window.PlanPanel = (function () {
  var planMarkdownViewEl, refreshBtnEl, summaryEl, phasesEl, titleEl;
  var sourceSwitchEl, sourceBtns, summaryToggleEl;
  var doneEl, totalEl, pctEl, barEl, fillEl;
  var currentWorktreePath = null;
  var currentSource = 'plan';   // 'plan' | 'design'
  var planDoc = null;           // { name, content } or null
  var designDoc = null;
  var loadGeneration = 0;
  var reloadTimer = null;
  var COLLAPSE_KEY = 'plan.summaryCollapsed';

  function init() {
    planMarkdownViewEl = document.getElementById('plan-markdown-view');
    refreshBtnEl = document.getElementById('btn-refresh-plan');
    titleEl = document.getElementById('plan-tab-title');
    sourceSwitchEl = document.getElementById('plan-source-switch');
    sourceBtns = sourceSwitchEl ? sourceSwitchEl.querySelectorAll('.plan-source-btn') : [];
    summaryEl = document.getElementById('plan-progress-summary');
    summaryToggleEl = document.getElementById('plan-summary-toggle');
    if (summaryEl) {
      phasesEl = summaryEl.querySelector('.plan-phases');
      doneEl = summaryEl.querySelector('.plan-count-done');
      totalEl = summaryEl.querySelector('.plan-count-total');
      pctEl = summaryEl.querySelector('.plan-count-pct');
      barEl = summaryEl.querySelector('.plan-progressbar');
      fillEl = summaryEl.querySelector('.plan-progressbar-fill');
    }

    if (refreshBtnEl) refreshBtnEl.addEventListener('click', load);
    window.addEventListener('load-plan', load);
    window.addEventListener('reload-tab-plan', load);

    sourceBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.dataset.source === currentSource) return;
        currentSource = btn.dataset.source;
        renderSource();
      });
    });

    if (summaryToggleEl) {
      summaryToggleEl.addEventListener('click', toggleCollapseSafe);
      applyCollapseState();
    }

    // Keep the worktree in sync on every task switch — otherwise a plain Plan-
    // tab click (which only dispatches `load-plan`) would run load() against a
    // stale/null worktree, since the worktree is otherwise only pushed in when
    // the Plan tab happens to be active during a task switch. If the tab is
    // already showing, refresh it for the newly-selected task.
    if (window.Events && window.Events.on) {
      window.Events.on('task:switched', function (detail) {
        var task = detail && detail.task;
        setWorktree(task ? task.worktreePath : null);
        if (planTabVisible()) load();
      });
    }

    // Live updates: the active worktree is already watched (sidebar dirty
    // indicators), so we piggyback on its `worktree-changed` broadcast. Reload
    // only when the plan tab is visible and a *plan*.md / *design*.md actually
    // changed, so progress ticks up as the agent works without us restatting on
    // every unrelated save.
    if (window.klaus && window.klaus.fs && window.klaus.fs.onWorktreeChanged) {
      window.klaus.fs.onWorktreeChanged(function (data) {
        if (!data || !currentWorktreePath || data.worktreePath !== currentWorktreePath) return;
        if (!planTabVisible()) return;
        var hit = (data.changedFiles || []).some(function (f) {
          return /(^|\/)[^/]*(plan|design)[^/]*\.md$/i.test(f);
        });
        if (!hit) return;
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(load, 250);
      });
    }
  }

  // Guard the collapse toggle so a stray error never wedges the click handler.
  function toggleCollapseSafe() {
    var collapsed = !(summaryEl.classList.contains('is-collapsed'));
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch (_e) {}
    applyCollapseState();
  }

  function applyCollapseState() {
    if (!summaryEl) return;
    var collapsed = false;
    try { collapsed = localStorage.getItem(COLLAPSE_KEY) === '1'; } catch (_e) {}
    summaryEl.classList.toggle('is-collapsed', collapsed);
    if (summaryToggleEl) summaryToggleEl.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }

  function planTabVisible() {
    var c = document.getElementById('plan-tab-content');
    return !!c && c.style.display !== 'none';
  }

  function setWorktree(wt) {
    currentWorktreePath = wt;
  }

  function showMessage(cls, html) {
    if (summaryEl) summaryEl.hidden = true;
    planMarkdownViewEl.style.display = '';
    planMarkdownViewEl.innerHTML = '<div class="' + cls + '">' + html + '</div>';
  }

  async function load() {
    if (!planMarkdownViewEl) return;
    if (!currentWorktreePath) {
      setSwitchVisible([]);
      showMessage('plan-empty', 'No active task');
      return;
    }

    var gen = ++loadGeneration;
    showMessage('plan-loading', 'Loading…');

    var results = await Promise.all([
      window.klaus.fs.findPlanFile(currentWorktreePath),
      window.klaus.fs.findDesignFile(currentWorktreePath),
    ]);

    // Abort if a newer load was triggered while we were awaiting.
    if (gen !== loadGeneration) return;

    planDoc = docOrNull(results[0]);
    designDoc = docOrNull(results[1]);
    renderSource();
  }

  function docOrNull(r) {
    return (r && !r.error && typeof r.content === 'string') ? r : null;
  }

  // Decide which sources exist, reconcile the current selection, update the
  // switcher + title, then render the selected doc.
  function renderSource() {
    var available = [];
    if (planDoc) available.push('plan');
    if (designDoc) available.push('design');

    if (available.length === 0) {
      setSwitchVisible([]);
      if (titleEl) titleEl.textContent = 'Plan';
      if (summaryEl) summaryEl.hidden = true;
      showMessage('plan-empty',
        'No plan or design file found at root.<br><small>Create a <code>plan.md</code>, ' +
        '<code>implementation_plan.md</code>, or <code>design.md</code> to view it here.</small>');
      return;
    }

    if (available.indexOf(currentSource) === -1) currentSource = available[0];
    setSwitchVisible(available);

    if (currentSource === 'design' && designDoc) {
      // Design view: render the document, no progress card.
      if (titleEl) titleEl.textContent = 'Design Document';
      if (summaryEl) summaryEl.hidden = true;
      planMarkdownViewEl.style.display = '';
      renderPlan(designDoc.content);
    } else if (planDoc) {
      // Plan view is the progress tracker. The card already summarizes the
      // checklist, so rendering the full plan markdown below it just duplicates
      // the tasks — hide the doc body. Only when the plan has no checkboxes to
      // track (nothing for the card to show) do we fall back to the document.
      if (titleEl) titleEl.textContent = 'Current Plan Progress';
      var prog = parseProgress(planDoc.content);
      if (prog.total > 0) {
        planMarkdownViewEl.style.display = 'none';
        planMarkdownViewEl.innerHTML = '';
        renderSummary(prog);
      } else {
        if (summaryEl) summaryEl.hidden = true;
        planMarkdownViewEl.style.display = '';
        renderPlan(planDoc.content);
      }
    }
  }

  // Show the switcher only when there's a real choice (both docs present);
  // sync the active button to the current source.
  function setSwitchVisible(available) {
    if (!sourceSwitchEl) return;
    var show = available.length >= 2;
    sourceSwitchEl.hidden = !show;
    if (titleEl) titleEl.style.display = show ? 'none' : '';
    sourceBtns.forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.source === currentSource);
    });
  }

  function renderPlan(content) {
    if (window.MarkdownPreview && typeof window.MarkdownPreview.render === 'function') {
      planMarkdownViewEl.innerHTML = window.MarkdownPreview.render(content);
      window.MarkdownPreview.attachLinkInterceptor(planMarkdownViewEl);
      enhanceTaskItems(planMarkdownViewEl);
    } else {
      var pre = document.createElement('pre');
      pre.textContent = content;
      planMarkdownViewEl.innerHTML = '';
      planMarkdownViewEl.appendChild(pre);
    }
  }

  // markdown-it has no task-list plugin here, so `- [ ] foo` renders as a list
  // item whose leading text is the literal "[ ] foo". Convert that prefix into
  // a real (read-only) checkbox so the body reads as done/pending at a glance.
  function enhanceTaskItems(rootEl) {
    rootEl.querySelectorAll('li').forEach(function (li) {
      var first = li.firstChild;
      if (!first || first.nodeType !== 3) return; // must lead with a text node
      var m = first.nodeValue.match(/^\s*\[([ xX])\]\s+/);
      if (!m) return;
      var checked = m[1].toLowerCase() === 'x';
      first.nodeValue = first.nodeValue.slice(m[0].length);
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.disabled = true; // read-only progress tracker
      cb.checked = checked;
      li.classList.add('plan-task');
      if (checked) li.classList.add('is-done');
      li.insertBefore(cb, first);
    });
  }

  // Parse GitHub task-list items and bucket them under the nearest preceding
  // markdown heading (a "phase"). Returns { done, total, phases:[{name,done,
  // total}] } in document order. Items before any heading land in a "Tasks"
  // bucket. Headings with no tasks are omitted.
  function parseProgress(content) {
    var lines = String(content).split(/\r?\n/);
    var taskRe = /^\s*[-*+]\s+\[([ xX])\]/;
    var headingRe = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
    var phases = [];
    var byName = {};
    var current = null;
    var done = 0;
    var total = 0;

    function bucket(name) {
      if (Object.prototype.hasOwnProperty.call(byName, name)) return phases[byName[name]];
      var p = { name: name, done: 0, total: 0 };
      byName[name] = phases.length;
      phases.push(p);
      return p;
    }

    lines.forEach(function (line) {
      var h = line.match(headingRe);
      if (h) { current = h[2].trim(); return; }
      var t = line.match(taskRe);
      if (!t) return;
      var checked = t[1].toLowerCase() === 'x';
      var p = bucket(current || 'Tasks');
      p.total++;
      total++;
      if (checked) { p.done++; done++; }
    });

    phases = phases.filter(function (p) { return p.total > 0; });
    return { done: done, total: total, phases: phases };
  }

  function renderSummary(p) {
    if (!summaryEl) return;
    if (!p || p.total === 0) {
      summaryEl.hidden = true;
      return;
    }
    summaryEl.hidden = false;
    applyCollapseState();

    var pct = Math.round((p.done / p.total) * 100);
    doneEl.textContent = String(p.done);
    totalEl.textContent = String(p.total);
    pctEl.textContent = pct + '%';
    barEl.setAttribute('aria-valuenow', String(pct));
    animateFill(fillEl, pct);

    // Per-phase breakdown is only meaningful when the plan has more than one
    // phase — a single phase just restates the overall bar.
    phasesEl.innerHTML = '';
    if (p.phases.length < 2) return;
    p.phases.forEach(function (ph) {
      var ppct = Math.round((ph.done / ph.total) * 100);
      var li = document.createElement('li');
      li.className = 'plan-phase';
      li.setAttribute('data-pct', String(ppct));

      var name = document.createElement('span');
      name.className = 'plan-phase-name';
      name.textContent = ph.name;
      name.title = ph.name;

      var count = document.createElement('span');
      count.className = 'plan-phase-count';
      count.textContent = ph.done + '/' + ph.total;

      var track = document.createElement('span');
      track.className = 'plan-phase-bar';
      var fill = document.createElement('span');
      fill.className = 'plan-phase-fill';
      track.appendChild(fill);

      li.appendChild(name);
      li.appendChild(count);
      li.appendChild(track);
      phasesEl.appendChild(li);
      animateFill(fill, ppct);
    });
  }

  // Start at 0 and grow to the target on the next frame so the CSS width
  // transition fires on every (re)render, not just the first.
  function animateFill(el, pct) {
    el.style.width = '0%';
    requestAnimationFrame(function () { el.style.width = pct + '%'; });
  }

  return { init: init, setWorktree: setWorktree, load: load };
})();
