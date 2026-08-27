// Tracks the 9-phase "Rest of the Owl" dev loop by reading the agent's own PTY
// output plus on-disk artifacts (plan/design docs, QA media, PR state), so
// progress costs no extra API calls.

window.DevLoopPanel = (function () {
  var PHASES = [
    {
      id: 1,
      name: 'Plan & Discovery',
      shortName: 'Plan',
      icon: '📋',
      description: 'Analyze task requirements, check ambiguities, and construct the build sequence.',
    },
    {
      id: 2,
      name: 'Implementation',
      shortName: 'Implement',
      icon: '🔨',
      description: 'Work through the plan in small test-driven batches, keeping test suite green.',
    },
    {
      id: 3,
      name: 'Local Review & Humanize',
      shortName: 'Review',
      icon: '🔍',
      description: 'Review working diff for bugs and apply self-review humanization.',
    },
    {
      id: 4,
      name: 'QA & Evidence Recording',
      shortName: 'QA',
      icon: '🎥',
      description: 'Capture before/after screenshots, record responsive flow video (.mp4), and upload QA proof.',
    },
    {
      id: 5,
      name: 'Create PR (Humanized)',
      shortName: 'Create PR',
      icon: '🚀',
      description: 'Commit changes, format before/after table & video proof in PR description, and open PR.',
    },
    {
      id: 6,
      name: 'Re-review Remote PR',
      shortName: 'PR Review',
      icon: '🔍',
      description: 'Inspect full remote PR diff on forge for integration seams and push fixes.',
    },
    {
      id: 7,
      name: 'Pull & Fix CI Failures',
      shortName: 'Fix CI',
      icon: '⏳',
      description: 'Monitor CI checks, pull failure logs, diagnose real root causes, and auto-fix until green.',
    },
    {
      id: 8,
      name: 'Pull & Resolve Review Comments',
      shortName: 'Feedback',
      icon: '💬',
      description: 'Poll reviewer feedback, apply code adjustments, and resolve comment threads.',
    },
    {
      id: 9,
      name: 'Notify when Green (Merge Gate)',
      shortName: 'Green PR',
      icon: '🦉',
      description: 'Notify that CI is green, tests pass, and reviews are resolved. You retain the merge button.',
    },
  ];

  var devLoopStates = new Map();
  var currentWorktreePath = null;
  var currentSubTab = 'progress'; // 'progress' | 'design' | 'qa'
  var selectedDocPath = null;
  var cachedDocs = [];
  var cachedQaMedia = [];
  var containerEl = null;
  var reloadTimer = null;

  function normId(id) {
    if (id == null) return '';
    return String(id);
  }

  function defaultState(taskId, taskDescription) {
    var phaseStatuses = {};
    for (var i = 1; i <= 9; i++) {
      phaseStatuses[i] = {
        status: i === 1 ? 'in_progress' : 'pending',
        summary: '',
        startedAt: i === 1 ? Date.now() : null,
        completedAt: null,
      };
    }
    return {
      taskId: normId(taskId),
      taskDescription: taskDescription || '',
      active: true,
      currentPhase: 1,
      phaseStatuses: phaseStatuses,
      qaArtifacts: [],
      prUrl: null,
      prNumber: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  function getState(taskId) {
    var id = normId(taskId || activeTaskId());
    if (!id) return null;
    return devLoopStates.get(id) || null;
  }

  function getOrCreateState(taskId, taskDescription) {
    var id = normId(taskId || activeTaskId());
    if (!id) return defaultState('default', taskDescription);
    if (!devLoopStates.has(id)) {
      devLoopStates.set(id, defaultState(id, taskDescription));
    }
    return devLoopStates.get(id);
  }

  function advancePhase(state, targetPhase, summary) {
    if (!state || targetPhase < 1 || targetPhase > 9) return false;
    if (targetPhase > state.currentPhase) {
      for (var p = 1; p < targetPhase; p++) {
        if (state.phaseStatuses[p].status !== 'completed') {
          state.phaseStatuses[p].status = 'completed';
          if (!state.phaseStatuses[p].completedAt) {
            state.phaseStatuses[p].completedAt = Date.now();
          }
        }
      }
      state.currentPhase = targetPhase;
      state.phaseStatuses[targetPhase].status = 'in_progress';
      if (!state.phaseStatuses[targetPhase].startedAt) {
        state.phaseStatuses[targetPhase].startedAt = Date.now();
      }
      if (summary) {
        state.phaseStatuses[targetPhase].summary = summary;
      }
      state.updatedAt = Date.now();
      return true;
    } else if (targetPhase === state.currentPhase) {
      if (state.phaseStatuses[targetPhase].status !== 'in_progress') {
        state.phaseStatuses[targetPhase].status = 'in_progress';
        state.updatedAt = Date.now();
        return true;
      }
      if (summary && !state.phaseStatuses[targetPhase].summary) {
        state.phaseStatuses[targetPhase].summary = summary;
        state.updatedAt = Date.now();
        return true;
      }
    }
    return false;
  }

  function startDevLoop(taskId, taskDescription) {
    var id = normId(taskId || activeTaskId());
    var state = defaultState(id, taskDescription);
    devLoopStates.set(id, state);
    emitUpdate(id);
    switchDiffTabToDevLoop();
    load(currentWorktreePath);
    return state;
  }

  function switchDiffTabToDevLoop() {
    var tabBtn = document.querySelector('#diff-tabs .diff-tab[data-tab="devloop"]');
    if (tabBtn) tabBtn.click();
  }

  function emitUpdate(taskId) {
    var id = normId(taskId || activeTaskId());
    if (window.Events && window.Events.emit) {
      window.Events.emit('dev-loop:updated', { taskId: id, state: getState(id) });
    }
    renderActiveView();
    updateMiniHuds(id);
  }

  function stripAnsi(str) {
    if (!str) return '';
    return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
  }

  function feedTerminalData(taskId, rawData) {
    if (!rawData) return;
    var clean = stripAnsi(rawData);
    if (!clean) return;

    var id = normId(taskId || activeTaskId());
    var state = getOrCreateState(id, 'Active Dev Loop');
    var changed = false;

    // Explicit headers: "## Phase 1 — Plan", "Starting Phase 4".
    var phaseRegex = /(?:##\s*|Starting\s+|Entering\s+|Moving to\s+|Executing\s+|Beginning\s+)?Phase\s*([1-9])(?:\s*[-—:.]\s*|\.|\s+)([^\n\r]*)/gi;
    var match;
    while ((match = phaseRegex.exec(clean)) !== null) {
      var phaseNum = parseInt(match[1], 10);
      var phaseTitle = (match[2] || '').trim();
      if (advancePhase(state, phaseNum, phaseTitle)) {
        changed = true;
      }
    }

    // Todo checklists: "- [x] Phase 1", "[ ] 4. QA".
    var todoRegex = /\[([ xX✓])\]\s*(?:Phase\s*)?([1-9])(?:\s*[-—:.]\s*|\.|\s+)([^\n\r]*)/gi;
    var todoMatch;
    while ((todoMatch = todoRegex.exec(clean)) !== null) {
      var isDone = todoMatch[1] === 'x' || todoMatch[1] === 'X' || todoMatch[1] === '✓';
      var num = parseInt(todoMatch[2], 10);
      var text = (todoMatch[3] || '').trim();
      if (isDone) {
        if (num < 9) {
          if (advancePhase(state, num + 1, '')) changed = true;
        } else {
          state.phaseStatuses[9].status = 'completed';
          changed = true;
        }
      } else {
        if (advancePhase(state, num, text)) changed = true;
      }
    }

    // Milestone phrasing the agents actually print, newest phase first.
    if (/(?:All CI checks green|landing the owl|PR is ready for human merge|ready for merge|merge gate reached|dev loop complete)/i.test(clean)) {
      if (advancePhase(state, 9, 'CI green & ready to merge')) changed = true;
    } else if (/(?:gh pr view\s+--comments|polling for code review|review comments? resolved|review feedback resolved|pulling review comments)/i.test(clean)) {
      if (advancePhase(state, 8, 'Resolving review comments')) changed = true;
    } else if (/(?:gh pr checks|polling CI|monitoring CI|CI checks?\s+(?:passing|passed|green|failed|pending)|waiting for CI|CI is green)/i.test(clean)) {
      if (advancePhase(state, 7, 'Polling CI checks')) changed = true;
    } else if (/(?:Re-review(?:ing)?\s+(?:the\s+)?PR|reviewing published PR|inspecting PR diff|checking remote PR)/i.test(clean)) {
      if (advancePhase(state, 6, 'Reviewing published PR')) changed = true;
    } else if (/(?:Drafting (?:the )?PR body|pr-body\.md|gh pr create|glab mr create|Creating (?:the )?pull request|Opening (?:the )?PR|Pushed\.\s+Drafting)/i.test(clean)) {
      if (advancePhase(state, 5, 'Creating pull request')) changed = true;
    } else if (/(?:QA is clean|QA clean|Capturing artifacts for the PR|scroll-through recording|Capturing screenshots?|Recording (?:screen|proof|flow)|Playwright screen recording|klaussy-qa-|\.mp4\b|Running QA|QA the change)/i.test(clean)) {
      if (advancePhase(state, 4, 'Running QA & capturing media')) changed = true;
    } else if (/(?:git diff main\.\.\.HEAD|Local review and fix|Self-review pass|Reviewing the working diff|reviewing diff for bugs)/i.test(clean)) {
      if (advancePhase(state, 3, 'Local review & self-review')) changed = true;
    } else if (/(?:Implementing the solution|TDD|test-driven development|Writing implementation|Applying changes|batch of edits)/i.test(clean)) {
      if (advancePhase(state, 2, 'Implementing solution')) changed = true;
    }

    var prMatch = clean.match(/https:\/\/(?:github\.com|gitlab\.com)\/([^\s\n\r/]+)\/([^\s\n\r/]+)\/(?:pull|merge_requests)\/(\d+)/i);
    if (prMatch) {
      var fullUrl = prMatch[0];
      var prNum = prMatch[3];
      if (state.prUrl !== fullUrl) {
        state.prUrl = fullUrl;
        state.prNumber = prNum;
        if (advancePhase(state, 6, 'PR #' + prNum + ' opened')) {
          changed = true;
        }
      }
    }

    // QA media paths mentioned in the stream, skipping app assets.
    var mediaMatch = clean.match(/(?:[a-zA-Z0-9_.~/-]+\.(?:mp4|webm|mov|png|jpg|jpeg|webp))/gi);
    if (mediaMatch) {
      mediaMatch.forEach(function (file) {
        var isVideo = /\.(mp4|webm|mov)$/i.test(file);
        var isImg = /\.(png|jpg|jpeg|webp)$/i.test(file);
        var isQaPath = /(?:Downloads|e2e|qa|screenshot|screen-shot|screen_shot|artifact|test-result|cypress)/i.test(file);
        var isNonAsset = !/(?:node_modules|\.git|src[\\/]assets|public[\\/]|styles[\\/]|icons[\\/]|renderer[\\/])/i.test(file);

        if ((isVideo || (isImg && isQaPath)) && isNonAsset) {
          if (!state.qaArtifacts.some(function (a) { return a.path === file || a.name === file; })) {
            state.qaArtifacts.push({
              name: file.split('/').pop(),
              path: file,
              type: isVideo ? 'video' : 'image',
            });
            if (advancePhase(state, 4, 'QA media recorded')) {
              changed = true;
            }
          }
        }
      });
    }

    if (changed) {
      emitUpdate(id);
    }
  }

  // Hydrates phase state from what's on disk, so a reopened task isn't stuck at Phase 1.
  async function load(worktreePath) {
    if (!worktreePath) {
      currentWorktreePath = null;
      renderActiveView();
      return;
    }
    currentWorktreePath = worktreePath;
    var taskId = activeTaskId();
    var state = getOrCreateState(taskId, 'Active Dev Loop');

    try {
      var docs = [];
      var planRes = await window.klaus.fs.findPlanFile(worktreePath);
      if (planRes && !planRes.error && planRes.content) {
        docs.push({ name: planRes.name || 'plan.md', path: planRes.path || (worktreePath + '/plan.md'), content: planRes.content, type: 'plan' });
      }

      var designRes = await window.klaus.fs.findDesignFile(worktreePath);
      if (designRes && !designRes.error && designRes.content) {
        docs.push({ name: designRes.name || 'design.md', path: designRes.path || (worktreePath + '/design.md'), content: designRes.content, type: 'design' });
      }

      if (window.klaus.fs.listFiles) {
        var filesRes = await window.klaus.fs.listFiles(worktreePath);
        var fileList = (filesRes && filesRes.files) || (Array.isArray(filesRes) ? filesRes : []);
        for (var i = 0; i < fileList.length; i++) {
          var f = fileList[i];
          var rel = typeof f === 'string' ? f : (f.path || f.name || '');
          if (/^(task-.*|REVIEW_OUTPUT)\.md$/i.test(rel)) {
            var fullPath = worktreePath + '/' + rel;
            var readRes = await window.klaus.fs.readFile(fullPath);
            if (readRes && !readRes.error && typeof readRes.content === 'string') {
              if (!docs.some(function (d) { return d.name === rel; })) {
                docs.push({ name: rel, path: fullPath, content: readRes.content, type: 'spec' });
              }
            }
          }
        }
      }

      // Pull from OKF session context sharing folder ($KLAUSSY_SESSION_NOTES_DIR)
      if (window.klaus && window.klaus.sessionContext && window.klaus.sessionContext.listNotes) {
        try {
          var sessionNotes = await window.klaus.sessionContext.listNotes(worktreePath);
          if (Array.isArray(sessionNotes)) {
            sessionNotes.forEach(function (note) {
              var meta = note.metadata || {};
              var tags = Array.isArray(meta.tags) ? meta.tags : [];
              var isPlanOrDesign = tags.some(function (t) {
                return /^(plan|design|spec|architecture|task|devloop)/i.test(String(t));
              }) || /(?:^|[\\/._-])(?:plan|design|spec|task|devloop)/i.test(note.id || '')
                 || /(?:^#+\s*(?:Plan|Design|Implementation Plan|Architecture|Task))/i.test(note.body || '')
                 || (note.title && /(?:Plan|Design|Implementation|Architecture|Spec)/i.test(note.title));

              var displayName = note.title || (meta.title) || (tags.length ? ('OKF: ' + tags.join(', ')) : (note.id + '.md'));
              var agentSuffix = meta.agent ? (' (' + meta.agent + ')') : '';
              var cleanName = '🦉 ' + displayName + agentSuffix;

              if (!docs.some(function (d) { return d.path === note.filePath; })) {
                if (isPlanOrDesign || docs.length === 0) {
                  docs.push({
                    name: cleanName,
                    path: note.filePath,
                    content: note.body || '',
                    type: 'okf-note',
                    metadata: meta,
                    isSessionNote: true,
                    writtenAt: note.writtenAt,
                  });
                }
              }
            });
          }
        } catch (noteErr) {
          console.warn('[dev-loop-panel session notes load]', noteErr);
        }
      }

      cachedDocs = docs;
      if (!selectedDocPath && docs.length > 0) {
        selectedDocPath = docs[0].path;
      }

      var qaMedia = [];
      if (window.klaus && window.klaus.fs && window.klaus.fs.findQaMedia) {
        var qaRes = await window.klaus.fs.findQaMedia(worktreePath);
        if (qaRes && Array.isArray(qaRes.media)) {
          qaMedia = qaRes.media;
        }
      }

      // Fallback in case findQaMedia IPC is not active
      if (!qaMedia.length && window.klaus && window.klaus.fs && window.klaus.fs.listFiles) {
        var allFiles = (filesRes && filesRes.files) || (Array.isArray(filesRes) ? filesRes : []);
        allFiles.forEach(function (f) {
          var rel = typeof f === 'string' ? f : (f.path || f.name || '');
          var isVideo = /\.(mp4|webm|mov)$/i.test(rel);
          var isImg = /\.(png|jpg|jpeg|webp)$/i.test(rel);
          var isQaDir = /^(?:e2e-artifacts|e2e-screenshots|qa-artifacts|qa-screenshots|screenshots|qa|e2e\/screenshots|test-results|playwright-report|cypress\/screenshots|cypress\/videos|tmp\/qa|tmp\/screenshots)\//i.test(rel);
          var isQaName = /(?:^|[\\/._-])(?:screenshot|screen-shot|screen_shot|qa[-_]|test[-_]shot|recording)(?:[\\/._-]|$)/i.test(rel);
          var isNonAsset = !/(?:node_modules|\.git|src[\\/]assets|public[\\/]|styles[\\/]|icons[\\/]|renderer[\\/])/i.test(rel);

          if ((isVideo || isImg) && (isQaDir || isQaName) && isNonAsset) {
            qaMedia.push({
              name: rel.split('/').pop(),
              relPath: rel,
              path: worktreePath + '/' + rel,
              type: isVideo ? 'video' : 'image',
            });
          }
        });
      }

      if (state && state.qaArtifacts) {
        state.qaArtifacts.forEach(function (art) {
          if (!qaMedia.some(function (m) { return m.path === art.path || m.name === art.name; })) {
            qaMedia.push(art);
          }
        });
      }
      cachedQaMedia = qaMedia;

      if (window.klaus.pr && window.klaus.pr.forBranch) {
        var prRes = await window.klaus.pr.forBranch(worktreePath);
        if (prRes && prRes.pr) {
          state.prUrl = prRes.pr.url || (prRes.pr.number ? ('#' + prRes.pr.number) : null);
          state.prNumber = prRes.pr.number;
          advancePhase(state, 6, 'PR #' + (prRes.pr.number || '') + ' active on forge');
        }
      }

      // Artifacts already on disk imply how far a resumed loop got.
      if (state.currentPhase < 4 && qaMedia.length > 0) {
        advancePhase(state, 4, 'QA media captured');
      } else if (state.currentPhase < 4 && docs.some(function (d) { return d.name === 'REVIEW_OUTPUT.md'; })) {
        advancePhase(state, 4, 'Local review output generated');
      } else if (state.currentPhase < 2 && docs.length > 0) {
        advancePhase(state, 2, 'Plan established');
      }

      renderActiveView();
      updateMiniHuds(taskId);
    } catch (err) {
      console.warn('[dev-loop-panel load]', err);
      renderActiveView();
    }
  }

  function init() {
    containerEl = document.getElementById('devloop-tab-content');

    window.addEventListener('load-devloop', function () {
      load(currentWorktreePath || getActiveWorktreePath());
    });

    if (window.Events && window.Events.on) {
      window.Events.on('task:switched', function (detail) {
        var task = detail && detail.task;
        currentWorktreePath = task ? task.worktreePath : null;
        load(currentWorktreePath);
      });
    }

    if (window.klaus && window.klaus.fs && window.klaus.fs.onWorktreeChanged) {
      window.klaus.fs.onWorktreeChanged(function (data) {
        if (!data || !currentWorktreePath || data.worktreePath !== currentWorktreePath) return;
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(function () { load(currentWorktreePath); }, 300);
      });
    }
  }

  function getActiveWorktreePath() {
    var task = AppState.tasks.get(AppState.activeTaskId);
    return task ? task.worktreePath : null;
  }

  function setWorktree(wt) {
    currentWorktreePath = wt;
    load(wt);
  }

  function activeTaskId() {
    return AppState.activeTaskId || null;
  }

  function renderActiveView() {
    if (!containerEl) containerEl = document.getElementById('devloop-tab-content');
    if (!containerEl) return;

    var taskId = activeTaskId();
    var state = getOrCreateState(taskId, 'Active Dev Loop');
    var esc = AppUtils.escHtml;
    var task = AppState.tasks.get(taskId);
    var taskName = (task && task.name) || (currentWorktreePath ? currentWorktreePath.split('/').pop() : 'Active Task');

    var currentPhaseObj = PHASES.find(function (p) { return p.id === state.currentPhase; }) || PHASES[0];

    var html =
      '<div class="devloop-header">' +
        '<div class="devloop-header-title">' +
          '<span class="devloop-header-icon">🦉</span>' +
          '<div class="devloop-header-text">' +
            '<h3>Full Dev Loop: ' + esc(taskName) + '</h3>' +
            '<div class="devloop-phase-badge">' +
              '<span class="devloop-pulse-dot"></span>' +
              'Phase ' + state.currentPhase + ' of 9: ' + esc(currentPhaseObj.name) +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="devloop-header-actions">' +
          '<button class="klaus-btn klaus-btn-secondary devloop-relaunch-btn" type="button" title="Start/Restart Full Dev Loop on this task">🚀 Relaunch Loop</button>' +
        '</div>' +
      '</div>' +
      '<div class="devloop-intro-banner">' +
        '<div class="devloop-intro-owl">🦉</div>' +
        '<div class="devloop-intro-text">' +
          '<strong>Full Dev Loop ("Rest of the Owl")</strong>' +
          '<span>An autonomous 9-phase workflow: Plan ➔ Code with TDD ➔ Local Review ➔ QA Video ➔ Create PR ➔ Pull &amp; Resolve Feedback ➔ Pull &amp; Fix CI ➔ Notify when Green. You retain the merge button.</span>' +
        '</div>' +
      '</div>';

    var docCount = cachedDocs.length;
    var qaCount = cachedQaMedia.length;

    html +=
      '<div class="devloop-subnav">' +
        '<button type="button" class="devloop-subtab ' + (currentSubTab === 'progress' ? 'active' : '') + '" data-sub="progress">📊 Progress (' + state.currentPhase + '/9)</button>' +
        '<button type="button" class="devloop-subtab ' + (currentSubTab === 'design' ? 'active' : '') + '" data-sub="design">📐 Designs &amp; Plan <span class="devloop-badge">' + docCount + '</span></button>' +
        '<button type="button" class="devloop-subtab ' + (currentSubTab === 'qa' ? 'active' : '') + '" data-sub="qa">🎥 QA Screenshots <span class="devloop-badge">' + qaCount + '</span></button>' +
      '</div>';

    html += '<div class="devloop-body">';

    if (currentSubTab === 'progress') {
      html += renderProgressView(state);
    } else if (currentSubTab === 'design') {
      html += renderDesignView();
    } else if (currentSubTab === 'qa') {
      html += renderQaView();
    }

    html += '</div>';

    containerEl.innerHTML = html;

    containerEl.querySelectorAll('.devloop-subtab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        currentSubTab = tab.dataset.sub;
        renderActiveView();
      });
    });

    var relaunchBtn = containerEl.querySelector('.devloop-relaunch-btn');
    if (relaunchBtn) {
      relaunchBtn.addEventListener('click', function () {
        if (window.ActionModal && window.ActionModal.run && taskId) {
          window.ActionModal.run(taskId, 'rest-of-the-owl');
        }
      });
    }

    attachContentListeners(containerEl, state);
  }

  function renderProgressView(state) {
    var esc = AppUtils.escHtml;
    var html = '';

    if (state.prUrl) {
      html +=
        '<div class="devloop-pr-banner">' +
          '<span class="devloop-pr-icon">🚀</span>' +
          '<span class="devloop-pr-text">Pull Request <strong>#' + esc(state.prNumber || '') + '</strong> active on forge.</span>' +
          '<a href="#" class="devloop-pr-link" data-url="' + esc(state.prUrl) + '">View PR ↗</a>' +
        '</div>';
    }

    html += '<div class="devloop-stepper">';
    PHASES.forEach(function (phase) {
      var pState = state.phaseStatuses[phase.id] || { status: 'pending', summary: '' };
      var statusCls = pState.status;
      var statusIcon = statusCls === 'completed' ? '✓' : (statusCls === 'in_progress' ? '⏳' : '○');

      html +=
        '<div class="devloop-step ' + statusCls + '" data-phase="' + phase.id + '">' +
          '<div class="devloop-step-line"></div>' +
          '<div class="devloop-step-indicator">' + statusIcon + '</div>' +
          '<div class="devloop-step-body">' +
            '<div class="devloop-step-header">' +
              '<span class="devloop-step-title">' + phase.icon + ' Phase ' + phase.id + ': ' + esc(phase.name) + '</span>' +
              '<span class="devloop-step-status-tag ' + statusCls + '">' + (statusCls === 'in_progress' ? 'In Progress' : (statusCls === 'completed' ? 'Done' : 'Pending')) + '</span>' +
            '</div>' +
            '<div class="devloop-step-desc">' + esc(phase.description) + '</div>' +
            (pState.summary ? ('<div class="devloop-step-summary">' + esc(pState.summary) + '</div>') : '') +
          '</div>' +
        '</div>';
    });
    html += '</div>';

    html +=
      '<div class="devloop-merge-gate-card">' +
        '<div class="devloop-merge-gate-head">' +
          '<span class="devloop-merge-gate-owl">🦉</span>' +
          '<div>' +
            '<h4>Human Merge Control</h4>' +
            '<p>The agent completes all planning, TDD, code review, QA, and CI polling. The merge button always stays with the human.</p>' +
          '</div>' +
        '</div>' +
        '<div class="devloop-merge-actions">' +
          '<button type="button" class="klaus-btn klaus-btn-primary devloop-btn-merge" id="btn-devloop-merge">Merge PR (When Ready)</button>' +
        '</div>' +
      '</div>';

    return html;
  }

  function renderDesignView() {
    var esc = AppUtils.escHtml;
    if (!cachedDocs || cachedDocs.length === 0) {
      return (
        '<div class="devloop-empty">' +
          '<div class="devloop-empty-icon">📐</div>' +
          '<h3>No Design Documents Found</h3>' +
          '<p>Create a <code>plan.md</code>, <code>design.md</code>, or an OKF session note (tagged <code>plan</code> in <code>$KLAUSSY_SESSION_NOTES_DIR</code>) to view and track requirements here.</p>' +
          '<button class="klaus-btn klaus-btn-primary devloop-create-plan-btn" type="button">+ Plan a Task</button>' +
        '</div>'
      );
    }

    var selectedDoc = cachedDocs.find(function (d) { return d.path === selectedDocPath; }) || cachedDocs[0];

    var html = '<div class="devloop-design-pane">';

    if (cachedDocs.length > 1) {
      html += '<div class="devloop-doc-switch">';
      cachedDocs.forEach(function (doc) {
        var isSel = doc.path === selectedDoc.path;
        html += '<button type="button" class="devloop-doc-btn ' + (isSel ? 'active' : '') + '" data-doc-path="' + esc(doc.path) + '">' + esc(doc.name) + '</button>';
      });
      html += '</div>';
    }

    var renderedMarkdown = '';
    if (window.MarkdownPreview && typeof window.MarkdownPreview.render === 'function') {
      renderedMarkdown = window.MarkdownPreview.render(selectedDoc.content || '');
    } else {
      renderedMarkdown = '<pre class="devloop-raw-doc">' + esc(selectedDoc.content || '') + '</pre>';
    }

    var metaBadges = '';
    if (selectedDoc.isSessionNote && selectedDoc.metadata) {
      var m = selectedDoc.metadata;
      var tags = Array.isArray(m.tags) ? m.tags : [];
      metaBadges = '<div class="devloop-doc-meta-bar">' +
        '<span class="devloop-meta-badge okf">OKF Note</span>' +
        (m.agent ? ('<span class="devloop-meta-badge agent">Agent: ' + esc(m.agent) + (m.provider ? (' / ' + esc(m.provider)) : '') + '</span>') : '') +
        (tags.length ? ('<span class="devloop-meta-badge tags">' + esc(tags.join(', ')) + '</span>') : '') +
      '</div>';
    }

    html +=
      '<div class="devloop-doc-card">' +
        '<div class="devloop-doc-title">' +
          '<span>📄 ' + esc(selectedDoc.name) + '</span>' +
          metaBadges +
        '</div>' +
        '<div class="markdown-body devloop-doc-body">' + renderedMarkdown + '</div>' +
      '</div>' +
    '</div>';

    return html;
  }

  function renderQaView() {
    var esc = AppUtils.escHtml;
    if (!cachedQaMedia || cachedQaMedia.length === 0) {
      return (
        '<div class="devloop-empty">' +
          '<div class="devloop-empty-icon">🎥</div>' +
          '<h3>No QA Screenshots Recorded Yet</h3>' +
          '<p>During <strong>Phase 4 (QA the change)</strong>, the agent captures before/after screenshots, records full-flow responsive walkthrough videos (.mp4), and uploads QA assets for PR comparison tables in <code>Downloads/klaussy-qa-&lt;branch&gt;</code>.</p>' +
        '</div>'
      );
    }

    var html =
      '<div class="devloop-qa-pane">' +
        '<div class="devloop-qa-card-header">' +
          '<h4>Captured QA Recordings &amp; Screenshots (' + cachedQaMedia.length + ')</h4>' +
        '</div>' +
        '<div class="devloop-qa-gallery">';

    cachedQaMedia.forEach(function (art) {
      var fileUrl = (art.path && art.path.startsWith('/'))
        ? ('file://' + esc(art.path))
        : ('file:///' + esc((art.path || '').replace(/\\/g, '/')));

      var nameLower = (art.name || '').toLowerCase();
      var roleBadge = '';
      if (/before/i.test(nameLower)) {
        roleBadge = '<span class="devloop-qa-badge before">Before</span>';
      } else if (/after/i.test(nameLower)) {
        roleBadge = '<span class="devloop-qa-badge after">After</span>';
      } else if (art.type === 'video' || /responsive|flow|record/i.test(nameLower)) {
        roleBadge = '<span class="devloop-qa-badge video">Responsive Flow</span>';
      }

      if (art.type === 'video') {
        html +=
          '<div class="devloop-qa-media-card video-card">' +
            '<div class="devloop-qa-media-head">' +
              '<div class="devloop-qa-media-title">' +
                '<span class="devloop-media-icon">🎥</span>' +
                '<span class="devloop-media-name" title="' + esc(art.path) + '">' + esc(art.name) + '</span>' +
                roleBadge +
              '</div>' +
              '<div class="devloop-qa-media-actions">' +
                '<button type="button" class="klaus-btn klaus-btn-secondary devloop-copy-md-btn" data-path="' + esc(art.path) + '" data-name="' + esc(art.name) + '">Copy MD</button>' +
                '<button type="button" class="klaus-btn klaus-btn-secondary devloop-open-finder-btn" data-path="' + esc(art.path) + '">Reveal</button>' +
              '</div>' +
            '</div>' +
            '<div class="devloop-video-wrap">' +
              '<video src="' + fileUrl + '" controls preload="metadata" style="max-width: 100%; border-radius: 4px;"></video>' +
            '</div>' +
          '</div>';
      } else {
        html +=
          '<div class="devloop-qa-media-card image-card">' +
            '<div class="devloop-qa-media-head">' +
              '<div class="devloop-qa-media-title">' +
                '<span class="devloop-media-icon">🖼️</span>' +
                '<span class="devloop-media-name" title="' + esc(art.path) + '">' + esc(art.name) + '</span>' +
                roleBadge +
              '</div>' +
              '<div class="devloop-qa-media-actions">' +
                '<button type="button" class="klaus-btn klaus-btn-secondary devloop-copy-md-btn" data-path="' + esc(art.path) + '" data-name="' + esc(art.name) + '">Copy MD</button>' +
                '<button type="button" class="klaus-btn klaus-btn-secondary devloop-open-finder-btn" data-path="' + esc(art.path) + '">Reveal</button>' +
              '</div>' +
            '</div>' +
            '<div class="devloop-img-wrap">' +
              '<img src="' + fileUrl + '" alt="' + esc(art.name) + '" style="max-width: 100%; max-height: 360px; border-radius: 4px; object-fit: contain;" />' +
            '</div>' +
          '</div>';
      }
    });

    html +=
        '</div>' +
      '</div>';

    return html;
  }

  function attachContentListeners(container, state) {
    container.querySelectorAll('.devloop-doc-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        selectedDocPath = btn.dataset.docPath;
        renderActiveView();
      });
    });

    var createPlanBtn = container.querySelector('.devloop-create-plan-btn');
    if (createPlanBtn) {
      createPlanBtn.addEventListener('click', function () {
        if (window.ActionModal && window.ActionModal.run && activeTaskId()) {
          window.ActionModal.run(activeTaskId(), 'plan');
        }
      });
    }

    var prLink = container.querySelector('.devloop-pr-link');
    if (prLink) {
      prLink.addEventListener('click', function (e) {
        e.preventDefault();
        var url = prLink.dataset.url;
        if (url && window.klaus && window.klaus.gh) window.klaus.gh.openExternal(url);
      });
    }

    container.querySelectorAll('.devloop-copy-md-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var name = btn.dataset.name || 'screenshot';
        var filePath = btn.dataset.path || '';
        var mdSnippet = '![' + name + '](' + filePath + ')';
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(mdSnippet);
          var origText = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(function () { btn.textContent = origText; }, 1500);
        }
      });
    });

    container.querySelectorAll('.devloop-open-finder-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var filePath = btn.dataset.path;
        if (filePath && window.klaus && window.klaus.fs && window.klaus.fs.revealInFolder) {
          window.klaus.fs.revealInFolder(filePath);
        } else if (filePath && window.klaus && window.klaus.skills && window.klaus.skills.openSkillFile) {
          window.klaus.skills.openSkillFile(filePath);
        }
      });
    });

    var mergeBtn = container.querySelector('#btn-devloop-merge');
    if (mergeBtn) {
      mergeBtn.addEventListener('click', function () {
        var prBtn = document.getElementById('btn-pr-merge');
        if (prBtn && !prBtn.disabled) {
          prBtn.click();
        } else {
          var prTab = document.querySelector('#diff-tabs .diff-tab[data-tab="pr"]');
          if (prTab) prTab.click();
        }
      });
    }
  }

  function renderMiniHud(hostEl, taskId) {
    if (!hostEl) return;
    var state = getOrCreateState(taskId, 'Active Dev Loop');

    var minihud = hostEl.querySelector('.terminal-devloop-minihud');
    if (!minihud) {
      minihud = document.createElement('div');
      minihud.className = 'terminal-devloop-minihud';
      hostEl.insertBefore(minihud, hostEl.firstChild);
    }
    minihud.style.display = 'flex';

    var currentPhaseObj = PHASES.find(function (p) { return p.id === state.currentPhase; }) || PHASES[0];

    var dotsHtml = PHASES.map(function (p) {
      var pState = state.phaseStatuses[p.id] || { status: 'pending' };
      var dotCls = pState.status;
      var dotText = dotCls === 'completed' ? '✓' : (p.id === state.currentPhase ? p.id : '○');
      return '<span class="minihud-dot ' + dotCls + '" title="Phase ' + p.id + ': ' + AppUtils.escHtml(p.name) + '">' + dotText + '</span>';
    }).join('<span class="minihud-connector"></span>');

    minihud.innerHTML =
      '<div class="minihud-label">' +
        '<span class="minihud-icon">🦉</span>' +
        '<span class="minihud-phase">Phase ' + state.currentPhase + '/9: ' + AppUtils.escHtml(currentPhaseObj.shortName) + '</span>' +
      '</div>' +
      '<div class="minihud-stepper">' + dotsHtml + '</div>' +
      '<button class="minihud-expand-btn" title="Open full Dev Loop details" type="button">Details ↗</button>';

    var expandBtn = minihud.querySelector('.minihud-expand-btn');
    if (expandBtn) {
      expandBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        switchDiffTabToDevLoop();
      });
    }
  }

  function updateMiniHuds(taskId) {
    if (!taskId) return;
    var task = AppState.tasks.get(taskId);
    if (task && task.container) {
      renderMiniHud(task.container, taskId);
    }
  }

  return {
    init: init,
    load: load,
    startDevLoop: startDevLoop,
    getState: getState,
    feedTerminalData: feedTerminalData,
    renderActiveView: renderActiveView,
    renderMiniHud: renderMiniHud,
    setWorktree: setWorktree,
    switchDiffTabToDevLoop: switchDiffTabToDevLoop,
  };
})();
