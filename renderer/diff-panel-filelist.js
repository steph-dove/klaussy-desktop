// Part of the DiffPanel surface (window.DiffPanel); see diff-panel.js for the core.
// file-list + branch file-list rendering.
// Cross-references go through the shared `DP` object; load order only
// needs the core file first, siblings may load in any order after it.

(function (DP) {

  DP.renderFileList = function(files, branch) {
    var staged = files.filter(function (f) { return f.staged; });
    var unstaged = files.filter(function (f) { return !f.staged; });

    var html = DP.renderModeToggle(branch);

    if (files.length === 0) {
      html += '<div class="diff-empty">No changes</div>';
      DP.fileListEl.innerHTML = html;
      DP.bindModeToggle();
      return;
    }

    if (staged.length > 0) {
      html += '<div class="diff-section-header"><span>Staged (' + staged.length + ')</span>';
      html += '<button class="diff-section-btn js-unstage-all" title="Unstage all">Unstage All</button></div>';
      staged.forEach(function (f) { html += DP.renderFileItem(f, true); });
    }

    if (unstaged.length > 0) {
      html += '<div class="diff-section-header"><span>Changes (' + unstaged.length + ')</span>';
      html += '<button class="diff-section-btn js-stage-all" title="Stage all">Stage All</button></div>';
      unstaged.forEach(function (f) { html += DP.renderFileItem(f, false); });
    }

    DP.fileListEl.innerHTML = html;
    DP.bindModeToggle();
    DP.addCheckoutToBranchSelect();
    DP.checkConflicts();

    // Bind section buttons
    var stageAllBtn = DP.fileListEl.querySelector('.js-stage-all');
    if (stageAllBtn) stageAllBtn.addEventListener('click', DP.stageAll);
    var unstageAllBtn = DP.fileListEl.querySelector('.js-unstage-all');
    if (unstageAllBtn) unstageAllBtn.addEventListener('click', DP.unstageAll);

    // Bind file clicks and action buttons
    DP.fileListEl.querySelectorAll('.diff-file').forEach(function (el) {
      var file = el.dataset.file;
      var isStaged = el.dataset.staged === 'true';

      el.addEventListener('click', function (e) {
        if (e.target.closest('.diff-file-action')) return;
        DP.selectedFile = file;
        DP.fileListEl.querySelectorAll('.diff-file').forEach(function (f) { f.classList.remove('selected'); });
        el.classList.add('selected');
        DP.showFileDiff(file, isStaged);
      });

      el.addEventListener('dblclick', function (e) {
        if (e.target.closest('.diff-file-action')) return;
        e.preventDefault();
        e.stopPropagation();
        window.getSelection().removeAllRanges();
        var fab = document.getElementById('explain-selection-btn');
        if (fab) fab.style.display = 'none';
        DP.refreshPaused = true;
        var fullPath = DP.currentWorktreePath + '/' + file;
        setTimeout(function () {
          if (typeof window.openFileViewer === 'function') {
            window.openFileViewer(fullPath, file);
          }
          DP.refreshPaused = false;
        }, 50);
      });
    });

    DP.fileListEl.querySelectorAll('.diff-file-action').forEach(function (btn) {
      btn.addEventListener('click', async function (e) {
        e.stopPropagation();
        var file = btn.dataset.file;
        var action = btn.dataset.action;
        if (action === 'stage') {
          await window.klaus.git.stage(DP.currentWorktreePath, [file]);
        } else if (action === 'unstage') {
          await window.klaus.git.unstage(DP.currentWorktreePath, [file]);
        } else if (action === 'discard') {
          // Use a visible confirmation
          btn.textContent = '?';
          btn.title = 'Click again to confirm discard';
          btn.dataset.action = 'discard-confirm';
        } else if (action === 'discard-confirm') {
          await window.klaus.git.discard(DP.currentWorktreePath, [file]);
        }
        if (action !== 'discard') await DP.refresh();
      });
    });
  };

  DP.renderFileItem = function(f, isStaged) {
    var statusClass = DP.getStatusClass(f.status);
    var statusLabel = DP.getStatusLabel(f.status);
    var sel = f.file === DP.selectedFile ? ' selected' : '';

    var actions = '';
    if (isStaged) {
      actions = '<button class="diff-file-action" data-file="' + DP.escAttr(f.file) + '" data-action="unstage" title="Unstage">\u2212</button>';
    } else {
      actions =
        '<button class="diff-file-action" data-file="' + DP.escAttr(f.file) + '" data-action="stage" title="Stage">+</button>' +
        '<button class="diff-file-action" data-file="' + DP.escAttr(f.file) + '" data-action="discard" title="Discard">\u2715</button>';
    }

    return ('<div class="diff-file' + sel + '" data-file="' + DP.escAttr(f.file) + '" data-staged="' + isStaged + '">' +
      '<span class="diff-file-status ' + statusClass + '">' + statusLabel + '</span>' +
      '<span class="diff-file-name" title="' + DP.escAttr(f.file) + '">' + DP.escHtml(DP.basename(f.file)) + '</span>' +
      '<span class="diff-file-path" title="' + DP.escAttr(f.file) + '">' + DP.escHtml(DP.dirname(f.file)) + '</span>' +
      '<span class="diff-file-actions">' + actions + '</span>' + '</div>');
  };

  DP.showFileDiff = async function(file, staged) {
    var result;
    DP.currentDiffStaged = !!staged;
    DP.selectedLineKeys = new Set();
    if (DP.diffMode === 'branch' && DP.baseBranch) {
      result = await window.klaus.git.branchDiff(DP.currentWorktreePath, DP.baseBranch, file);
    } else {
      result = await window.klaus.git.diff(DP.currentWorktreePath, file, staged);
    }
    if (result.error || !result.diff) {
      // For untracked files, try to show file content
      if (!result.diff) {
        var fileResult = await window.klaus.fs.readFile(DP.currentWorktreePath + '/' + file);
        if (fileResult.content) {
          var lang = DP.detectLang(file);
          var highlighted = null;
          if (typeof hljs !== 'undefined') {
            try {
              highlighted = lang
                ? hljs.highlight(fileResult.content, { language: lang, ignoreIllegals: true })
                : hljs.highlightAuto(fileResult.content);
            } catch (e) {}
          }
          var hLines = null;
          if (highlighted) {
            hLines = DP.splitHighlightedLines(highlighted.value);
            try { hLines = hLines.map(DP.enhanceLine); } catch (e) {}
          }
          var contentLines = fileResult.content.split('\n');
          DP.diffViewEl.innerHTML = DP.renderViewFullFileLink(file) + '<div class="diff-line diff-header">New file: ' + DP.escHtml(file) + '</div>' +
            contentLines.map(function (line, idx) {
              return '<div class="diff-line diff-add"><span class="diff-prefix">+</span><span class="diff-code">' +
                (hLines ? hLines[idx] : DP.escHtml(line)) + '</span></div>';
            }).join('');
          DP.bindViewFullFileLink(file);
          return;
        }
      }
      DP.diffViewEl.innerHTML = '<div class="diff-empty">No diff available</div>';
      return;
    }
    DP.currentRawDiff = result.diff;
    var diffHtml = DP.diffViewMode === 'split' ? DP.renderDiffSplit(result.diff) : DP.renderDiff(result.diff);
    DP.diffViewEl.innerHTML = DP.renderViewFullFileLink(file) + diffHtml;
    DP.bindViewFullFileLink(file);
    DP.bindViewModeToggle(file);
    DP.bindInlineComments(file);
    DP.bindExplainButtons(file);
    DP.bindPartialStaging(file);
  };

  DP.renderViewFullFileLink = function(file) {
    var unifiedActive = DP.diffViewMode === 'unified' ? ' active' : '';
    var splitActive = DP.diffViewMode === 'split' ? ' active' : '';
    var isMd = window.MarkdownPreview && window.MarkdownPreview.isMarkdownPath(file);
    var previewLink = isMd
      ? '<a href="#" class="js-preview-md" title="Render markdown">Preview</a>'
      : '';
    return '<div class="diff-view-full-file">'
      + '<a href="#" class="js-view-full-file">View full file</a>'
      + '<a href="#" class="js-edit-full-file">Edit</a>'
      + previewLink
      + ' <span class="diff-view-full-path">' + DP.escHtml(file) + '</span>'
      + '<div class="diff-view-mode-toggle" role="group" aria-label="Diff view mode">'
        + '<button type="button" class="diff-view-mode-btn js-view-mode-unified' + unifiedActive + '" title="Unified view">Unified</button>'
        + '<button type="button" class="diff-view-mode-btn js-view-mode-split' + splitActive + '" title="Side-by-side view">Split</button>'
      + '</div>'
      + '</div>';
  };

  // Replace the diff view body with the rendered markdown for `file`. The
  // header stays put — its Preview link flips to "Show diff" so the user
  // can return to the diff. Reads the current working-tree file (matches
  // what Edit / View full file would show).
  DP.showMarkdownPreview = async function(file) {
    if (!window.MarkdownPreview) return;
    var fullPath = DP.currentWorktreePath + '/' + file;
    var fileResult = await window.klaus.fs.readFile(fullPath);
    var src = (fileResult && fileResult.content) || '';
    DP.diffViewEl.innerHTML =
      DP.renderViewFullFileLinkInPreviewMode(file) +
      '<div class="diff-md-preview file-md-preview"></div>';
    var previewEl = DP.diffViewEl.querySelector('.diff-md-preview');
    previewEl.innerHTML = window.MarkdownPreview.render(src);
    window.MarkdownPreview.attachLinkInterceptor(previewEl);
    DP.bindPreviewHeader(file);
  };

  DP.renderViewFullFileLinkInPreviewMode = function(file) {
    return '<div class="diff-view-full-file">'
      + '<a href="#" class="js-view-full-file">View full file</a>'
      + '<a href="#" class="js-edit-full-file">Edit</a>'
      + '<a href="#" class="js-show-diff" title="Back to diff">Show diff</a>'
      + ' <span class="diff-view-full-path">' + DP.escHtml(file) + '</span>'
      + '</div>';
  };

  DP.bindPreviewHeader = function(file) {
    DP.bindViewFullFileLink(file);
    var back = DP.diffViewEl.querySelector('.js-show-diff');
    if (back) {
      back.addEventListener('click', function (e) {
        e.preventDefault();
        DP.showFileDiff(file, DP.currentDiffStaged);
      });
    }
  };

  DP.bindViewModeToggle = function(file) {
    var unifiedBtn = DP.diffViewEl.querySelector('.js-view-mode-unified');
    var splitBtn = DP.diffViewEl.querySelector('.js-view-mode-split');
    function setMode(mode) {
      if (DP.diffViewMode === mode) return;
      DP.diffViewMode = mode;
      try { localStorage.setItem('diffViewMode', mode); } catch (_) {}
      DP.selectedLineKeys = new Set();
      if (file && DP.selectedFile === file) DP.showFileDiff(file, DP.currentDiffStaged);
    }
    if (unifiedBtn) unifiedBtn.addEventListener('click', function () { setMode('unified'); });
    if (splitBtn) splitBtn.addEventListener('click', function () { setMode('split'); });
  };

  DP.bindViewFullFileLink = function(file) {
    var link = DP.diffViewEl.querySelector('.js-view-full-file');
    if (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        var fullPath = DP.currentWorktreePath + '/' + file;
        if (typeof window.openFileViewer === 'function') {
          window.openFileViewer(fullPath, file);
        }
      });
    }
    var editLink = DP.diffViewEl.querySelector('.js-edit-full-file');
    if (editLink) {
      editLink.addEventListener('click', function (e) {
        e.preventDefault();
        var fullPath = DP.currentWorktreePath + '/' + file;
        if (typeof window.openFileViewer === 'function') {
          window.openFileViewer(fullPath, file);
        }
      });
    }
    var previewLink = DP.diffViewEl.querySelector('.js-preview-md');
    if (previewLink) {
      previewLink.addEventListener('click', function (e) {
        e.preventDefault();
        DP.showMarkdownPreview(file);
      });
    }
  };

  DP.bindInlineComments = function(file) {
    DP.diffViewEl.querySelectorAll('.diff-line.diff-add, .diff-line.diff-del, .diff-line.diff-context').forEach(function (lineEl) {
      lineEl.addEventListener('click', function () {
        // Don't trigger comment if user is selecting text
        var sel = window.getSelection();
        if (sel && !sel.isCollapsed) return;
        if (!DP.commentCallback) return;
        // Remove any existing inline comment
        var existing = DP.diffViewEl.querySelector('.inline-comment');
        if (existing) existing.remove();

        var wrap = document.createElement('div');
        wrap.className = 'inline-comment';
        wrap.innerHTML = '<input type="text" placeholder="Comment for the agent..." class="inline-comment-input" />';
        lineEl.after(wrap);

        var inp = wrap.querySelector('input');
        inp.focus();
        inp.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            var text = inp.value.trim();
            if (text && DP.commentCallback) DP.commentCallback('Regarding ' + file + ': ' + text);
            wrap.remove();
          }
          if (e.key === 'Escape') wrap.remove();
        });
      });
    });
  };

  DP.bindExplainButtons = function(file) {
    DP.diffViewEl.querySelectorAll('.diff-explain-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var hunkIndex = parseInt(btn.dataset.hunkIndex, 10);
        var hunk = DP.currentParsedHunks[hunkIndex];
        if (!hunk) return;

        var existing = DP.diffViewEl.querySelector('.diff-explanation');
        if (existing) existing.remove();

        DP.runExplainStream({
          file: file,
          text: hunk.lines.join('\n'),
          insertAfter: btn.closest('.diff-hunk'),
          onClose: function () {},
        });
      });
    });
  };

  // D6: Partial-hunk staging
  // Build a unified patch from a subset of selected lines within currentParsedHunks.
  //   Stage   (pre=HEAD, post=working; apply forward): unselected - → context, unselected + → drop
  //   Unstage (pre=HEAD, post=index;   apply with -R): unselected + → context, unselected - → drop
  // The post-image of the patch must match the state we apply against (working tree for
  // stage, index for unstage -R), which is why the rules are swapped.
  DP.buildPartialPatch = function(file, lineKeys, reverse) {
    if (!DP.currentRawDiff || !DP.currentParsedHunks.length) return null;

    // Extract file header: everything from the start of currentRawDiff up to the first @@.
    var rawLines = DP.currentRawDiff.split('\n');
    var headerLines = [];
    for (var i = 0; i < rawLines.length; i++) {
      if (rawLines[i].startsWith('@@')) break;
      headerLines.push(rawLines[i]);
    }
    // Guard: no diff --git header means we synthesize one so git apply knows the path.
    var hasGitHeader = headerLines.some(function (l) { return l.startsWith('diff --git'); });
    if (!hasGitHeader) {
      headerLines = ['diff --git a/' + file + ' b/' + file, '--- a/' + file, '+++ b/' + file];
    }

    var patchHunks = [];
    for (var h = 0; h < DP.currentParsedHunks.length; h++) {
      var hunk = DP.currentParsedHunks[h];
      var header = hunk.lines[0];
      var body = hunk.lines.slice(1);

      // Does this hunk contain any selected lines? If not, skip.
      var anySelected = false;
      for (var k = 1; k <= body.length; k++) {
        if (lineKeys.has(h + ':' + k)) { anySelected = true; break; }
      }
      if (!anySelected) continue;

      // Transform body lines
      var outLines = [];
      var lastKept = false;
      for (var b = 0; b < body.length; b++) {
        var bodyLine = body[b];
        var key = h + ':' + (b + 1);
        var selected = lineKeys.has(key);

        if (bodyLine.startsWith('+')) {
          if (selected) { outLines.push(bodyLine); lastKept = true; }
          else if (reverse) { outLines.push(' ' + bodyLine.substring(1)); lastKept = true; } // unstage: + → context
          else { lastKept = false; } // stage: unselected + → drop
        } else if (bodyLine.startsWith('-')) {
          if (selected) { outLines.push(bodyLine); lastKept = true; }
          else if (reverse) { lastKept = false; } // unstage: unselected - → drop
          else { outLines.push(' ' + bodyLine.substring(1)); lastKept = true; } // stage: - → context
        } else if (bodyLine.startsWith('\\')) {
          // "\ No newline at end of file" applies to the previous line
          if (lastKept) outLines.push(bodyLine);
        } else {
          outLines.push(bodyLine); // context
          lastKept = true;
        }
      }

      // Recompute @@ header: old_count = context + '-' lines; new_count = context + '+' lines.
      var hm = header.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      if (!hm) continue;
      var oldStart = parseInt(hm[1], 10);
      var newStart = parseInt(hm[2], 10);
      var trailing = hm[3] || '';
      var oldCount = 0, newCount = 0;
      for (var o = 0; o < outLines.length; o++) {
        var c = outLines[o].charAt(0);
        if (c === ' ') { oldCount++; newCount++; }
        else if (c === '-') { oldCount++; }
        else if (c === '+') { newCount++; }
      }
      // Skip hunks that became no-ops (all context) — can happen if all selections dropped.
      var hasChange = outLines.some(function (l) {
        return l.charAt(0) === '+' || l.charAt(0) === '-';
      });
      if (!hasChange) continue;

      var newHeader = '@@ -' + oldStart + ',' + oldCount + ' +' + newStart + ',' + newCount + ' @@' + trailing;
      patchHunks.push(newHeader);
      patchHunks = patchHunks.concat(outLines);
    }

    if (patchHunks.length === 0) return null;

    return headerLines.concat(patchHunks).join('\n') + '\n';
  };

  DP.applyPartialPatch = async function(file, lineKeys, reverse) {
    var patch = DP.buildPartialPatch(file, lineKeys, reverse);
    if (!patch) {
      window.toast.error('Nothing to ' + (reverse ? 'unstage' : 'stage') + '.');
      return;
    }
    var result = await window.klaus.git.applyPatch(DP.currentWorktreePath, patch, reverse);
    if (result.error) {
      window.toast.error((reverse ? 'Unstage' : 'Stage') + ' failed:\n' + result.error);
      return;
    }
    DP.selectedLineKeys = new Set();
    await DP.refresh();
  };

  DP.bindPartialStaging = function(file) {
    if (DP.diffMode !== 'working') return;

    // Checkbox selection
    DP.diffViewEl.querySelectorAll('.diff-stage-check').forEach(function (cb) {
      cb.addEventListener('click', function (e) {
        e.stopPropagation(); // don't trigger bindInlineComments click-to-comment
      });
      cb.addEventListener('change', function () {
        var key = cb.dataset.lineKey;
        if (cb.checked) DP.selectedLineKeys.add(key);
        else DP.selectedLineKeys.delete(key);
        DP.updatePartialActionBar(file);
      });
    });

    // "Stage hunk" / "Unstage hunk" buttons
    DP.diffViewEl.querySelectorAll('.diff-stage-hunk-btn').forEach(function (btn) {
      btn.addEventListener('click', async function (e) {
        e.stopPropagation();
        var hi = parseInt(btn.dataset.hunkIndex, 10);
        var hunk = DP.currentParsedHunks[hi];
        if (!hunk) return;
        // Select every +/- line in this hunk.
        var keys = new Set();
        for (var b = 0; b < hunk.lines.length - 1; b++) {
          var line = hunk.lines[b + 1];
          if (line.startsWith('+') || line.startsWith('-')) {
            keys.add(hi + ':' + (b + 1));
          }
        }
        btn.disabled = true;
        btn.textContent = '...';
        await DP.applyPartialPatch(file, keys, DP.currentDiffStaged);
      });
    });

    DP.updatePartialActionBar(file);
  };

  DP.updatePartialActionBar = function(file) {
    var existing = document.getElementById('diff-partial-action-bar');
    if (existing) existing.remove();
    if (DP.selectedLineKeys.size === 0) {
      DP.refreshPaused = false;
      return;
    }
    // Keep auto-refresh from wiping the selection.
    DP.refreshPaused = true;

    var verb = DP.currentDiffStaged ? 'Unstage' : 'Stage';
    var bar = document.createElement('div');
    bar.id = 'diff-partial-action-bar';
    bar.innerHTML =
      '<span class="partial-count">' + DP.selectedLineKeys.size + ' line' + (DP.selectedLineKeys.size === 1 ? '' : 's') + ' selected</span>' +
      '<button class="partial-cancel" type="button">Cancel</button>' +
      '<button class="partial-apply" type="button">' + verb + ' selected</button>';

    // Prefer inserting after the diff-view element inside the diff panel, stuck to bottom
    var diffContent = document.getElementById('diff-content');
    (diffContent || DP.diffViewEl).appendChild(bar);

    bar.querySelector('.partial-cancel').addEventListener('click', function () {
      DP.selectedLineKeys = new Set();
      DP.diffViewEl.querySelectorAll('.diff-stage-check').forEach(function (cb) { cb.checked = false; });
      DP.updatePartialActionBar(file);
    });
    bar.querySelector('.partial-apply').addEventListener('click', async function () {
      bar.querySelector('.partial-apply').disabled = true;
      bar.querySelector('.partial-apply').textContent = '...';
      await DP.applyPartialPatch(file, DP.selectedLineKeys, DP.currentDiffStaged);
    });
  };

  // Parse hunks from raw diff text + bulk-highlight code lines. Shared by
  // unified and split renderers. Populates currentParsedHunks as a side effect.
  DP.parseAndHighlight = function(diffText) {
    var lines = diffText.split('\n');
    var hunks = [];
    var currentHunk = [];
    var hunkStart = -1;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('@@')) {
        if (currentHunk.length > 0) hunks.push({ start: hunkStart, lines: currentHunk.slice() });
        currentHunk = [lines[i]];
        hunkStart = i;
      } else if (hunkStart >= 0) {
        if (lines[i].startsWith('diff ')) {
          hunks.push({ start: hunkStart, lines: currentHunk.slice() });
          currentHunk = [];
          hunkStart = -1;
        } else {
          currentHunk.push(lines[i]);
        }
      }
    }
    if (currentHunk.length > 0) hunks.push({ start: hunkStart, lines: currentHunk.slice() });

    var lang = DP.detectLang(DP.selectedFile);
    var codeLines = [];
    var lineMap = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.startsWith('+') && !line.startsWith('+++')) {
        codeLines.push(line.substring(1));
        lineMap.push({ idx: i, prefix: '+', type: 'add' });
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        codeLines.push(line.substring(1));
        lineMap.push({ idx: i, prefix: '-', type: 'del' });
      } else if (!line.startsWith('@@') && !line.startsWith('diff ') &&
                 !line.startsWith('index ') && !line.startsWith('new file') &&
                 !line.startsWith('deleted file') && !line.startsWith('+++') &&
                 !line.startsWith('---')) {
        codeLines.push(line.length > 0 ? line.substring(1) : '');
        lineMap.push({ idx: i, prefix: ' ', type: 'context' });
      }
    }

    var highlightedLines = {};
    if (typeof hljs !== 'undefined' && codeLines.length > 0) {
      var codeBlock = codeLines.join('\n');
      try {
        var result = lang
          ? hljs.highlight(codeBlock, { language: lang, ignoreIllegals: true })
          : hljs.highlightAuto(codeBlock);
        var hLines = DP.splitHighlightedLines(result.value);
        try { hLines = hLines.map(DP.enhanceLine); } catch (_) {}
        for (var j = 0; j < lineMap.length && j < hLines.length; j++) {
          highlightedLines[lineMap[j].idx] = hLines[j];
        }
      } catch (e) {
        console.error('[hljs] Syntax highlighting failed:', e, e.stack);
      }
    }

    DP.currentParsedHunks = hunks;
    return { lines: lines, hunks: hunks, highlightedLines: highlightedLines };
  };

  DP.renderDiff = function(diffText) {
    var parsed = DP.parseAndHighlight(diffText);
    var lines = parsed.lines;
    var hunks = parsed.hunks;
    var highlightedLines = parsed.highlightedLines;

    // Partial-staging UI only shown in working mode (not branch diff)
    var allowStaging = DP.diffMode === 'working';
    var stageVerb = DP.currentDiffStaged ? 'Unstage' : 'Stage';

    var html = '';
    var oldLn = 0, newLn = 0; // running line counters driven by @@ headers
    var currentHunkIdx = -1;
    var lineInHunk = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var cls = 'diff-line';

      if (line.startsWith('+++') || line.startsWith('---')) {
        cls += ' diff-meta';
        html += '<div class="' + cls + '">' + DP.escHtml(line) + '</div>';
      } else if (line.startsWith('@@')) {
        cls += ' diff-hunk';
        var hm = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hm) { oldLn = parseInt(hm[1], 10) - 1; newLn = parseInt(hm[2], 10) - 1; }
        var hi = hunks.findIndex(function (h) { return h.start === i; });
        currentHunkIdx = hi;
        lineInHunk = 0;
        if (hi >= 0) {
          var stageBtn = allowStaging
            ? '<button class="diff-stage-hunk-btn" data-hunk-index="' + hi + '" title="' + stageVerb + ' this hunk">' + stageVerb + ' hunk</button>'
            : '';
          html += '<div class="' + cls + '" data-hunk-index="' + hi + '">' +
            '<span class="diff-hunk-text">' + DP.escHtml(line) + '</span>' +
            '<button class="diff-explain-btn" data-hunk-index="' + hi + '" title="Explain this change">Explain</button>' +
            stageBtn +
            '</div>';
        } else {
          html += '<div class="' + cls + '">' + DP.escHtml(line) + '</div>';
        }
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        newLn++;
        lineInHunk++;
        cls += ' diff-add';
        html += '<div class="' + cls + '" data-new-ln="' + newLn + '" data-side="RIGHT"><span class="diff-prefix">+</span><span class="diff-code">' + (highlightedLines[i] || DP.escHtml(line.substring(1))) + '</span></div>';
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        oldLn++;
        lineInHunk++;
        cls += ' diff-del';
        html += '<div class="' + cls + '" data-old-ln="' + oldLn + '" data-side="LEFT"><span class="diff-prefix">-</span><span class="diff-code">' + (highlightedLines[i] || DP.escHtml(line.substring(1))) + '</span></div>';
      } else if (line.startsWith('diff ')) {
        cls += ' diff-header';
        html += '<div class="' + cls + '">' + DP.escHtml(line) + '</div>';
      } else if (line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) {
        cls += ' diff-meta';
        html += '<div class="' + cls + '">' + DP.escHtml(line) + '</div>';
      } else {
        oldLn++; newLn++;
        if (currentHunkIdx >= 0) lineInHunk++;
        cls += ' diff-context';
        html += '<div class="' + cls + '" data-old-ln="' + oldLn + '" data-new-ln="' + newLn + '" data-side="RIGHT"><span class="diff-prefix"> </span><span class="diff-code">' + (highlightedLines[i] || DP.escHtml(line.length > 0 ? line.substring(1) : '')) + '</span></div>';
      }
    }

    return html;
  };

})(window.DiffPanel);
