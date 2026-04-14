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

    var result = await window.klaus.gitConflicts(worktreePath);
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
    var result = await window.klaus.readConflictFile(currentWorktreePath, file);
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

    currentBlocks.forEach(function (block, idx) {
      if (block.type === 'common') {
        var commonHtml = '<div class="conflict-common">' + block.lines.map(escHtml).join('\n') + '</div>';
        oursBody.innerHTML += commonHtml;
        theirsBody.innerHTML += commonHtml;
        resultBody.innerHTML += commonHtml;
        return;
      }

      // Conflict block
      var oursHtml = '<div class="conflict-block conflict-ours-highlight" data-idx="' + idx + '">' +
        block.ours.map(escHtml).join('\n') +
        '</div>';
      oursBody.innerHTML += oursHtml;

      var theirsHtml = '<div class="conflict-block conflict-theirs-highlight" data-idx="' + idx + '">' +
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
        '<div class="conflict-block conflict-result-block' + resolvedClass + '" data-idx="' + idx + '">' +
          '<div class="conflict-actions">' +
            '<button class="conflict-action-btn" data-action="ours" data-idx="' + idx + '">Ours</button>' +
            '<button class="conflict-action-btn" data-action="theirs" data-idx="' + idx + '">Theirs</button>' +
            '<button class="conflict-action-btn" data-action="both" data-idx="' + idx + '">Both</button>' +
          '</div>' +
          '<textarea class="conflict-result-textarea" data-idx="' + idx + '" rows="' + Math.max(3, Math.max(block.ours.length, block.theirs.length)) + '">' +
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
        if (resultBlock) resultBlock.classList.add('conflict-resolved');
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
          if (resultBlock) resultBlock.classList.add('conflict-resolved');
        }
      });
    });
  }

  async function resolveAndSave() {
    if (!currentFile || !currentWorktreePath) return;

    // Check all conflicts are resolved
    var unresolved = currentBlocks.filter(function (b) { return b.type === 'conflict' && !b.resolved; });
    if (unresolved.length > 0) {
      alert(unresolved.length + ' conflict(s) still unresolved. Please resolve all conflicts before marking as resolved.');
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
    btn.disabled = true;
    btn.textContent = 'Saving...';

    var result = await window.klaus.writeResolvedFile(currentWorktreePath, currentFile, content);
    btn.disabled = false;
    btn.textContent = 'Mark Resolved';

    if (result.error) {
      alert('Error resolving: ' + result.error);
      return;
    }

    // Check if more files to resolve
    var remaining = Array.from(fileSelect.options).filter(function (opt) {
      return opt.value !== currentFile;
    });

    if (remaining.length > 0) {
      // Remove resolved file from selector and load next
      fileSelect.querySelector('option[value="' + CSS.escape(currentFile) + '"]').remove();
      loadFile(remaining[0].value);
    } else {
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
