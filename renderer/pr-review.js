// Phase G: PR review surface. Shared renderer module, mounted in two hosts:
//   - main window: host = #pr-review-root, coexists with the rest of app.js
//   - pop-out:     host = document.body inside pr-review.html (see init call
//                  at the bottom of that file)
//
// State lives in the main process (activePrReview). We pull initial state on
// mount and subscribe to pr-review-state broadcasts so both hosts stay in sync
// without duplicating fetches.

window.PrReview = (function () {
  var escHtml = (window.AppUtils && window.AppUtils.escHtml) || function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  var hostEl = null;
  var isPopout = false;
  var unsubState = null;
  var lastState = null;
  var selectedFile = null;

  function mount(options) {
    hostEl = options.host;
    isPopout = !!options.isPopout;
    hostEl.classList.add('pr-review-host');
    renderLoading();

    unsubState = window.klaus.onPrReviewState(function (state) {
      if (!state) {
        // In the pop-out, no state = the review was closed elsewhere, so the
        // window has nothing left to show. In the main window, app.js owns
        // mount/unmount and will call unmount() on us — do nothing here.
        if (isPopout) window.close();
        return;
      }
      render(state);
    });

    window.klaus.prReviewState().then(function (state) {
      if (!state) {
        renderEmpty();
        return;
      }
      render(state);
    });
  }

  function unmount() {
    if (unsubState) { try { unsubState(); } catch (_) {} unsubState = null; }
    if (hostEl) {
      hostEl.innerHTML = '';
      hostEl.classList.remove('pr-review-host');
    }
    lastState = null;
    selectedFile = null;
  }

  function renderLoading() {
    hostEl.innerHTML = '<div class="pr-review-loading">Loading PR\u2026</div>';
  }

  function renderEmpty() {
    hostEl.innerHTML = '<div class="pr-review-loading">No active PR review.</div>';
  }

  function render(state) {
    // Preserve selection across updates unless the PR number changed.
    if (lastState && lastState.number !== state.number) selectedFile = null;
    lastState = state;

    var files = parseDiffFiles(state.diff || '');
    if (!selectedFile && files.length > 0) selectedFile = files[0].path;

    var meta = state.meta || {};
    var author = (meta.author && (meta.author.login || meta.author.name)) || 'unknown';
    var stateBadge = meta.isDraft ? 'DRAFT' : (meta.state || '').toUpperCase();
    var reviewDecision = meta.reviewDecision || '';

    hostEl.innerHTML =
      '<div class="pr-review-header">'
        + '<div class="pr-review-title">'
          + '<span class="pr-review-num">#' + escHtml(state.number) + '</span> '
          + '<span class="pr-review-title-text">' + escHtml(meta.title || '') + '</span>'
        + '</div>'
        + '<div class="pr-review-meta">'
          + '<span class="pr-review-state pr-state-' + escHtml((stateBadge || 'open').toLowerCase()) + '">' + escHtml(stateBadge || 'OPEN') + '</span>'
          + (reviewDecision ? '<span class="pr-review-decision pr-decision-' + escHtml(reviewDecision.toLowerCase()) + '">' + escHtml(reviewDecision.replace('_', ' ')) + '</span>' : '')
          + '<span class="pr-review-author">' + escHtml(author) + '</span>'
          + '<span class="pr-review-branch">' + escHtml(meta.headRefName || '') + ' \u2192 ' + escHtml(meta.baseRefName || '') + '</span>'
        + '</div>'
        + '<div class="pr-review-actions">'
          + '<a href="#" class="pr-review-external" data-url="' + escHtml(meta.url || '') + '">Open on GitHub</a>'
          + (isPopout
              ? '<button class="pr-review-btn js-pop-in" title="Return to main window">\u21B2 Pop back in</button>'
              : '<button class="pr-review-btn js-pop-out" title="Open in a separate window">Pop out \u2197</button>')
          + (isPopout
              ? ''
              : '<button class="pr-review-btn js-close" title="Close review">\u2190 Back to tasks</button>')
        + '</div>'
      + '</div>'
      + '<div class="pr-review-body">'
        + '<div class="pr-review-file-list">' + renderFileList(files) + '</div>'
        + '<div class="pr-review-diff">' + renderSelectedFileDiff(files) + '</div>'
      + '</div>';

    bindHeader(state);
    bindFileList();
  }

  function renderFileList(files) {
    if (files.length === 0) return '<div class="pr-review-empty">No files.</div>';
    return files.map(function (f) {
      var isSelected = f.path === selectedFile ? ' selected' : '';
      return '<div class="pr-review-file' + isSelected + '" data-file="' + escHtml(f.path) + '">'
        + '<span class="pr-review-file-path">' + escHtml(f.path) + '</span>'
        + '<span class="pr-review-file-stats">'
          + (f.adds ? '<span class="pr-file-add">+' + f.adds + '</span>' : '')
          + (f.dels ? '<span class="pr-file-del">\u2212' + f.dels + '</span>' : '')
        + '</span>'
      + '</div>';
    }).join('');
  }

  function renderSelectedFileDiff(files) {
    var file = files.find(function (f) { return f.path === selectedFile; });
    if (!file) return '<div class="pr-review-empty">Select a file.</div>';
    return '<pre class="pr-review-diff-pre">' + renderUnifiedDiff(file.raw) + '</pre>';
  }

  // Parse a `gh pr diff` unified diff into per-file blocks.
  function parseDiffFiles(diffText) {
    if (!diffText) return [];
    var lines = diffText.split('\n');
    var files = [];
    var current = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.startsWith('diff --git ')) {
        if (current) files.push(current);
        // "diff --git a/foo b/foo" — take the b/ side.
        var m = line.match(/^diff --git a\/.* b\/(.*)$/);
        current = { path: m ? m[1] : line, raw: line + '\n', adds: 0, dels: 0 };
      } else if (current) {
        current.raw += line + '\n';
        if (line.startsWith('+') && !line.startsWith('+++')) current.adds++;
        else if (line.startsWith('-') && !line.startsWith('---')) current.dels++;
      }
    }
    if (current) files.push(current);
    return files;
  }

  // Minimal unified-diff renderer — enough for G1+G2. Syntax highlighting and
  // inline comment hooks land in G3/G4.
  function renderUnifiedDiff(diffText) {
    return diffText.split('\n').map(function (line) {
      var cls = 'diff-line';
      if (line.startsWith('+++') || line.startsWith('---')) cls += ' diff-meta';
      else if (line.startsWith('@@')) cls += ' diff-hunk';
      else if (line.startsWith('+')) cls += ' diff-add';
      else if (line.startsWith('-')) cls += ' diff-del';
      else if (line.startsWith('diff ')) cls += ' diff-header';
      else if (line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) cls += ' diff-meta';
      else cls += ' diff-context';
      return '<div class="' + cls + '">' + escHtml(line) + '</div>';
    }).join('');
  }

  function bindHeader(state) {
    var extBtn = hostEl.querySelector('.pr-review-external');
    if (extBtn) extBtn.addEventListener('click', function (e) {
      e.preventDefault();
      var url = extBtn.dataset.url;
      if (url) window.klaus.openExternal(url);
    });
    var popOut = hostEl.querySelector('.js-pop-out');
    if (popOut) popOut.addEventListener('click', function () { window.klaus.popOutPrReview(); });
    var popIn = hostEl.querySelector('.js-pop-in');
    if (popIn) popIn.addEventListener('click', function () { window.klaus.popInPrReview(); });
    var closeBtn = hostEl.querySelector('.js-close');
    if (closeBtn) closeBtn.addEventListener('click', function () { window.klaus.prReviewClose(); });
  }

  function bindFileList() {
    hostEl.querySelectorAll('.pr-review-file').forEach(function (row) {
      row.addEventListener('click', function () {
        selectedFile = row.dataset.file;
        if (lastState) render(lastState);
      });
    });
  }

  return { mount: mount, unmount: unmount };
})();
