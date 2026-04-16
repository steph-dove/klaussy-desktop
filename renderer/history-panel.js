window.HistoryPanel = (function () {
  var escHtml = AppUtils.escHtml;

  var historyList = document.getElementById('history-list');
  var historyDiffView = document.getElementById('history-diff-view');
  var historySubTabs = document.querySelectorAll('.history-sub-tab');
  var historyCommitsContent = document.getElementById('history-commits-content');
  var historyTagsContent = document.getElementById('history-tags-content');
  var tagsList = document.getElementById('tags-list');
  var tagsCreateForm = document.getElementById('tags-create-form');
  var tagNameInput = document.getElementById('tag-name-input');
  var tagMessageInput = document.getElementById('tag-message-input');
  var tagCommitInput = document.getElementById('tag-commit-input');
  var tagError = document.getElementById('tag-error');

  // ---- Commit History (D4) ----

  window.addEventListener('load-history', function (e) { loadHistory(e.detail && e.detail.worktreePath); });
  window.addEventListener('reload-tab-history', function (e) { loadHistory(e.detail && e.detail.worktreePath); });

  async function loadHistory(overrideWt) {
    var task = AppState.activeTaskId ? AppState.tasks.get(AppState.activeTaskId) : null;
    var wt = overrideWt || (task ? task.worktreePath : null);
    if (!wt) {
      historyList.innerHTML = '<div class="file-tree-empty">No active task</div>';
      return;
    }
    historyList.innerHTML = '<div class="file-tree-empty">Loading...</div>';
    historyDiffView.innerHTML = '';
    var result = await window.klaus.gitLog(wt, 50);
    if (result.error) {
      historyList.innerHTML = '<div class="file-tree-empty">Error: ' + escHtml(result.error) + '</div>';
      return;
    }
    historyList.innerHTML = '';
    result.commits.forEach(function (c) {
      var item = document.createElement('div');
      item.className = 'history-item';
      item.innerHTML =
        '<span class="history-hash">' + escHtml(c.short) + '</span>' +
        '<span class="history-subject">' + escHtml(c.subject) + '</span>' +
        '<span class="history-meta">' + escHtml(c.author) + ' \u00b7 ' + escHtml(c.date) + '</span>';
      item.addEventListener('click', async function () {
        historyList.querySelectorAll('.history-item').forEach(function (el) { el.classList.remove('selected'); });
        item.classList.add('selected');
        historyDiffView.innerHTML = 'Loading...';
        var diff = await window.klaus.gitShow(wt, c.hash);
        historyDiffView.textContent = diff.diff || diff.error || 'No diff';
      });
      historyList.appendChild(item);
    });
  }

  // ---- History Sub-tabs & Tags (Feature 11) ----

  historySubTabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      historySubTabs.forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      var sub = tab.dataset.sub;
      historyCommitsContent.style.display = sub === 'commits' ? '' : 'none';
      historyTagsContent.style.display = sub === 'tags' ? '' : 'none';
      if (sub === 'tags') loadTags();
    });
  });

  document.getElementById('btn-create-tag').addEventListener('click', function () {
    tagsCreateForm.style.display = '';
    tagNameInput.value = '';
    tagMessageInput.value = '';
    tagCommitInput.value = '';
    tagError.textContent = '';
    tagNameInput.focus();
  });

  document.getElementById('btn-tag-cancel').addEventListener('click', function () {
    tagsCreateForm.style.display = 'none';
  });

  document.getElementById('btn-tag-submit').addEventListener('click', async function () {
    var task = AppState.activeTaskId ? AppState.tasks.get(AppState.activeTaskId) : null;
    var wt = task ? task.worktreePath : null;
    if (!wt) return;
    var name = tagNameInput.value.trim();
    if (!name) { tagError.textContent = 'Tag name is required'; return; }
    var message = tagMessageInput.value.trim() || undefined;
    var commit = tagCommitInput.value.trim() || undefined;
    this.disabled = true;
    var result = await window.klaus.gitTagCreate(wt, name, message, commit);
    this.disabled = false;
    if (result.error) {
      tagError.textContent = result.error;
    } else {
      tagsCreateForm.style.display = 'none';
      loadTags();
    }
  });

  async function loadTags() {
    var task = AppState.activeTaskId ? AppState.tasks.get(AppState.activeTaskId) : null;
    var wt = task ? task.worktreePath : null;
    if (!wt) {
      tagsList.innerHTML = '<div class="file-tree-empty">No active task</div>';
      return;
    }
    tagsList.innerHTML = '<div class="file-tree-empty">Loading...</div>';
    var result = await window.klaus.gitTags(wt);
    if (result.error) {
      tagsList.innerHTML = '<div class="file-tree-empty">Error: ' + escHtml(result.error) + '</div>';
      return;
    }
    if (result.tags.length === 0) {
      tagsList.innerHTML = '<div class="file-tree-empty">No tags</div>';
      return;
    }
    tagsList.innerHTML = '';
    result.tags.forEach(function (tag) {
      var item = document.createElement('div');
      item.className = 'tag-item';
      item.innerHTML =
        '<div class="tag-info">' +
          '<span class="tag-name">' + escHtml(tag.name) + '</span>' +
          '<span class="tag-meta">' + escHtml(tag.commit) + (tag.date ? ' \u00b7 ' + escHtml(tag.date) : '') + '</span>' +
          (tag.message ? '<span class="tag-message">' + escHtml(tag.message) + '</span>' : '') +
        '</div>' +
        '<div class="tag-actions">' +
          '<button class="tag-push-btn" title="Push to remote">\u2191</button>' +
          '<button class="tag-delete-btn" title="Delete">&times;</button>' +
        '</div>';
      item.querySelector('.tag-push-btn').addEventListener('click', async function (e) {
        e.stopPropagation();
        this.disabled = true;
        this.textContent = '...';
        var res = await window.klaus.gitTagPush(wt, tag.name);
        this.disabled = false;
        this.textContent = '\u2191';
        if (res.error) alert('Push failed: ' + res.error);
      });
      item.querySelector('.tag-delete-btn').addEventListener('click', async function (e) {
        e.stopPropagation();
        if (!confirm('Delete tag "' + tag.name + '"?')) return;
        var res = await window.klaus.gitTagDelete(wt, tag.name);
        if (res.error) alert('Delete failed: ' + res.error);
        else loadTags();
      });
      tagsList.appendChild(item);
    });
  }

  return {
    loadHistory: loadHistory,
    loadTags: loadTags,
  };
})();
