// Conflict resolution panel — 3-pane merge conflict resolver
window.ConflictPanel = (function () {
  var overlay, fileSelect, oursBody, theirsBody, resultBody;
  var currentWorktreePath = null;
  var currentFile = null;
  var currentBlocks = [];

  function init() {
    overlay = document.getElementById('conflict-overlay');
    fileSelect = document.getElementById('conflict-file-select');
    oursBody = document.getElementById('conflict-ours-body');
    theirsBody = document.getElementById('conflict-theirs-body');
    resultBody = document.getElementById('conflict-result-body');

    document.getElementById('btn-conflict-close').addEventListener('click', hide);
    document.getElementById('btn-conflict-resolve').addEventListener('click', resolveAndSave);

    fileSelect.addEventListener('change', function () {
      loadFile(fileSelect.value);
    });

    // Synced scrolling
    var panes = [oursBody, theirsBody, resultBody];
    panes.forEach(function (pane) {
      pane.addEventListener('scroll', function () {
        var top = pane.scrollTop;
        panes.forEach(function (other) {
          if (other !== pane) other.scrollTop = top;
        });
      });
    });

    // Close on overlay click
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) hide();
    });
  }

  async function show(worktreePath) {
    currentWorktreePath = worktreePath;
    overlay.style.display = 'flex';

    var result = await window.klaus.git.conflicts(worktreePath);
    if (!result.files || result.files.length === 0) {
      oursBody.innerHTML = '<div class="conflict-empty">No conflicts found</div>';
      theirsBody.innerHTML = '';
      resultBody.innerHTML = '';
      return;
    }

    // Populate file selector
    fileSelect.innerHTML = '';
    result.files.forEach(function (file) {
      var opt = document.createElement('option');
      opt.value = file;
      opt.textContent = file;
      fileSelect.appendChild(opt);
    });

    loadFile(result.files[0]);
  }

  function hide() {
    overlay.style.display = 'none';
    currentFile = null;
    currentBlocks = [];
  }

  async function loadFile(file) {
    currentFile = file;
    var result = await window.klaus.fs.readConflictFile(currentWorktreePath, file);
    if (result.error) {
      oursBody.innerHTML = '<div class="conflict-empty">Error: ' + escHtml(result.error) + '</div>';
      return;
    }

    currentBlocks = parseConflicts(result.content);
    renderPanes();
  }

  function parseConflicts(content) {
    var blocks = [];
    var lines = content.split('\n');
    var i = 0;
    var commonLines = [];

    while (i < lines.length) {
      if (lines[i].startsWith('<<<<<<<')) {
        // Flush common lines
        if (commonLines.length > 0) {
          blocks.push({ type: 'common', lines: commonLines });
          commonLines = [];
        }

        var oursLines = [];
        var theirsLines = [];
        var inOurs = true;
        i++; // skip <<<<<<< line

        while (i < lines.length) {
          if (lines[i].startsWith('=======')) {
            inOurs = false;
            i++;
            continue;
          }
          if (lines[i].startsWith('>>>>>>>')) {
            i++;
            break;
          }
          if (inOurs) {
            oursLines.push(lines[i]);
          } else {
            theirsLines.push(lines[i]);
          }
          i++;
        }

        blocks.push({
          type: 'conflict',
          ours: oursLines,
          theirs: theirsLines,
          resolved: null, // null = unresolved, 'ours' | 'theirs' | 'both' | 'manual'
          resultLines: null,
        });
      } else {
        commonLines.push(lines[i]);
        i++;
      }
    }

    if (commonLines.length > 0) {
      blocks.push({ type: 'common', lines: commonLines });
    }

    return blocks;
  }

  function renderPanes() {
    oursBody.innerHTML = '';
    theirsBody.innerHTML = '';
    resultBody.innerHTML = '';

    var conflictTotal = currentBlocks.filter(function (b) { return b.type !== 'common'; }).length;
    var conflictNo = 0;
    currentBlocks.forEach(function (block, idx) {
      if (block.type === 'common') {
        var commonHtml = '<div class="conflict-common">' + block.lines.map(escHtml).join('\n') + '</div>';
        oursBody.innerHTML += commonHtml;
        theirsBody.innerHTML += commonHtml;
        resultBody.innerHTML += commonHtml;
        return;
      }

      // Conflict block; the side is named, not just coloured.
      conflictNo++;
      var which = 'conflict ' + conflictNo + ' of ' + conflictTotal;
      var oursHtml = '<div class="conflict-block conflict-ours-highlight" data-idx="' + idx + '" role="group" aria-label="Ours (current branch), ' + which + '">' +
        block.ours.map(escHtml).join('\n') +
        '</div>';
      oursBody.innerHTML += oursHtml;

      var theirsHtml = '<div class="conflict-block conflict-theirs-highlight" data-idx="' + idx + '" role="group" aria-label="Theirs (incoming), ' + which + '">' +
        block.theirs.map(escHtml).join('\n') +
        '</div>';
      theirsBody.innerHTML += theirsHtml;

      var resolvedContent = '';
      var resolvedClass = '';
      if (block.resolved === 'ours') {
        resolvedContent = block.ours.map(escHtml).join('\n');
        resolvedClass = ' conflict-resolved';
      } else if (block.resolved === 'theirs') {
        resolvedContent = block.theirs.map(escHtml).join('\n');
        resolvedClass = ' conflict-resolved';
      } else if (block.resolved === 'both') {
        resolvedContent = block.ours.concat(block.theirs).map(escHtml).join('\n');
        resolvedClass = ' conflict-resolved';
      } else if (block.resolved === 'manual') {
        resolvedContent = (block.resultLines || []).map(escHtml).join('\n');
        resolvedClass = ' conflict-resolved';
      }

      var resultHtml =
        '<div class="conflict-block conflict-result-block' + resolvedClass + '" data-idx="' + idx + '" role="group" aria-label="' + which + (resolvedClass ? ', resolved' : '') + '" data-which="' + which + '">' +
          '<div class="conflict-actions">' +
            '<button class="conflict-action-btn" data-action="ours" data-idx="' + idx + '" aria-label="Use ours for ' + which + '">Ours</button>' +
            '<button class="conflict-action-btn" data-action="theirs" data-idx="' + idx + '" aria-label="Use theirs for ' + which + '">Theirs</button>' +
            '<button class="conflict-action-btn" data-action="both" data-idx="' + idx + '" aria-label="Keep both for ' + which + '">Both</button>' +
          '</div>' +
          '<textarea class="conflict-result-textarea" data-idx="' + idx + '" aria-label="Result for ' + which + '" rows="' + Math.max(3, Math.max(block.ours.length, block.theirs.length)) + '">' +
            resolvedContent +
          '</textarea>' +
        '</div>';
      resultBody.innerHTML += resultHtml;
    });

    // Bind action buttons
    resultBody.querySelectorAll('.conflict-action-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.dataset.idx, 10);
        var action = btn.dataset.action;
        var block = currentBlocks[idx];
        if (!block || block.type !== 'conflict') return;

        var textarea = resultBody.querySelector('.conflict-result-textarea[data-idx="' + idx + '"]');
        if (action === 'ours') {
          block.resolved = 'ours';
          block.resultLines = block.ours.slice();
          textarea.value = block.ours.join('\n');
        } else if (action === 'theirs') {
          block.resolved = 'theirs';
          block.resultLines = block.theirs.slice();
          textarea.value = block.theirs.join('\n');
        } else if (action === 'both') {
          block.resolved = 'both';
          block.resultLines = block.ours.concat(block.theirs);
          textarea.value = block.resultLines.join('\n');
        }

        var resultBlock = textarea.closest('.conflict-result-block');
        if (resultBlock) markResolved(resultBlock);
        var left = currentBlocks.filter(function (b) { return b.type === 'conflict' && !b.resolved; }).length;
        A11y.announce((resultBlock ? resultBlock.dataset.which + ' resolved' : 'Resolved')
          + (left ? ', ' + left + ' left' : ', all conflicts in this file resolved'));
      });
    });

    // Track manual edits in textareas
    resultBody.querySelectorAll('.conflict-result-textarea').forEach(function (textarea) {
      textarea.addEventListener('input', function () {
        var idx = parseInt(textarea.dataset.idx, 10);
        var block = currentBlocks[idx];
        if (block && block.type === 'conflict') {
          block.resolved = 'manual';
          block.resultLines = textarea.value.split('\n');
          var resultBlock = textarea.closest('.conflict-result-block');
          if (resultBlock) markResolved(resultBlock);
        }
      });
    });
  }

  function markResolved(block) {
    block.classList.add('conflict-resolved');
    block.setAttribute('aria-label', block.dataset.which + ', resolved');
  }

  async function resolveAndSave() {
    if (!currentFile || !currentWorktreePath) return;

    // Check all conflicts are resolved
    var conflicts = currentBlocks.filter(function (b) { return b.type === 'conflict'; });
    var unresolvedNos = [];
    conflicts.forEach(function (b, i) { if (!b.resolved) unresolvedNos.push(i + 1); });
    if (unresolvedNos.length > 0) {
      window.toast.error((unresolvedNos.length === 1 ? 'Conflict ' : 'Conflicts ') + unresolvedNos.join(', ') + ' of ' + conflicts.length
        + ' still unresolved. Resolve them before marking the file resolved.');
      var firstIdx = currentBlocks.indexOf(conflicts[unresolvedNos[0] - 1]);
      var firstField = resultBody.querySelector('.conflict-result-textarea[data-idx="' + firstIdx + '"]');
      if (firstField) firstField.focus();
      return;
    }

    // Build result content
    var resultLines = [];
    currentBlocks.forEach(function (block) {
      if (block.type === 'common') {
        resultLines = resultLines.concat(block.lines);
      } else {
        resultLines = resultLines.concat(block.resultLines || []);
      }
    });

    var content = resultLines.join('\n');
    var btn = document.getElementById('btn-conflict-resolve');
    if (btn.getAttribute('aria-busy') === 'true') return;
    btn.setAttribute('aria-disabled', 'true');
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = 'Saving…';

    var result;
    try {
      result = await window.klaus.fs.writeResolvedFile(currentWorktreePath, currentFile, content);
    } catch (err) {
      result = { error: (err && err.message) || String(err) };
    }
    btn.removeAttribute('aria-disabled');
    btn.removeAttribute('aria-busy');
    btn.textContent = 'Mark Resolved';

    if (result.error) {
      window.toast.error('Error resolving: ' + result.error);
      return;
    }

    // Check if more files to resolve
    var remaining = Array.from(fileSelect.options).filter(function (opt) {
      return opt.value !== currentFile;
    });

    if (remaining.length > 0) {
      // Remove resolved file from selector and load next
      fileSelect.querySelector('option[value="' + CSS.escape(currentFile) + '"]').remove();
      A11y.announce('Resolved ' + currentFile + '. ' + remaining.length + ' conflicted file' + (remaining.length === 1 ? '' : 's') + ' left, showing ' + remaining[0].value);
      loadFile(remaining[0].value);
    } else {
      A11y.announce('Resolved ' + currentFile + '. All conflicts resolved');
      hide();
      // Trigger diff panel refresh
      if (window.DiffPanel) window.DiffPanel.refresh();
    }
  }

  function escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  return { init: init, show: show, hide: hide };
})();
