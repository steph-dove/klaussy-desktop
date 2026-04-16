window.StashPanel = (function () {
  var escHtml = AppUtils.escHtml;

  var stashList = document.getElementById('stash-list');
  var stashMessage = document.getElementById('stash-message');
  var btnStashPush = document.getElementById('btn-stash-push');

  window.addEventListener('load-stash', function (e) { loadStash(e.detail && e.detail.worktreePath); });
  window.addEventListener('reload-tab-stash', function (e) { loadStash(e.detail && e.detail.worktreePath); });

  btnStashPush.addEventListener('click', async function () {
    var task = AppState.activeTaskId ? AppState.tasks.get(AppState.activeTaskId) : null;
    var wt = task ? task.worktreePath : null;
    if (!wt) return;
    btnStashPush.disabled = true;
    var result = await window.klaus.gitStashPush(wt, stashMessage.value.trim() || undefined);
    btnStashPush.disabled = false;
    stashMessage.value = '';
    if (result.error) {
      alert('Stash failed: ' + result.error);
    }
    loadStash();
    DiffPanel.refresh();
  });

  async function loadStash(overrideWt) {
    var task = AppState.activeTaskId ? AppState.tasks.get(AppState.activeTaskId) : null;
    var wt = overrideWt || (task ? task.worktreePath : null);
    if (!wt) {
      stashList.innerHTML = '<div class="file-tree-empty">No active task</div>';
      return;
    }
    var statusResult = await window.klaus.gitStatus(wt);
    var currentBranch = statusResult.branch || '';
    var result = await window.klaus.gitStashList(wt);
    var filtered = result.stashes.filter(function (s) {
      var match = s.message.match(/^(?:WIP )?[Oo]n ([^:]+):/);
      if (!match) return true;
      return match[1] === currentBranch;
    });
    if (filtered.length === 0) {
      stashList.innerHTML = '<div class="file-tree-empty">No stashes on ' + escHtml(currentBranch) + '</div>';
      return;
    }
    stashList.innerHTML = '';
    filtered.forEach(function (s, idx) {
      var item = document.createElement('div');
      item.className = 'stash-item';
      item.innerHTML =
        '<div class="stash-info"><span class="stash-ref">' + escHtml(s.ref) + '</span>' +
        '<span class="stash-msg">' + escHtml(s.message) + '</span></div>' +
        '<button class="stash-pop-btn" title="Pop this stash">Pop</button>';
      item.querySelector('.stash-pop-btn').addEventListener('click', async function (e) {
        e.stopPropagation();
        var refMatch = s.ref.match(/\{(\d+)\}/);
        var originalIdx = refMatch ? parseInt(refMatch[1], 10) : idx;
        var res = await window.klaus.gitStashPop(wt, originalIdx);
        if (res.error) {
          alert('Stash pop failed: ' + res.error);
        }
        loadStash();
        DiffPanel.refresh();
      });
      stashList.appendChild(item);
    });
  }

  return {
    loadStash: loadStash,
  };
})();
