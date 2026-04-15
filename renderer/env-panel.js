// Env panel module — view and edit .env files
window.EnvPanel = (function () {
  var fileSelectorEl, editorEl, saveBtn, statusEl;
  var currentWorktreePath = null;
  var currentFilename = null;
  var currentRows = []; // { enabled, key, value, comment }

  function init() {
    fileSelectorEl = document.getElementById('env-file-selector');
    editorEl = document.getElementById('env-editor');
    saveBtn = document.getElementById('btn-env-save');
    statusEl = document.getElementById('env-status');

    saveBtn.addEventListener('click', save);
    window.addEventListener('load-env', load);
    window.addEventListener('reload-tab-env', load);
  }

  function setWorktree(wt) {
    currentWorktreePath = wt;
    currentFilename = null;
    currentRows = [];
  }

  async function load() {
    if (!currentWorktreePath) {
      editorEl.innerHTML = '<div class="env-empty">No active task</div>';
      return;
    }

    fileSelectorEl.innerHTML = '';
    var result = await window.klaus.listEnvFiles(currentWorktreePath);
    if (result.error || result.files.length === 0) {
      fileSelectorEl.innerHTML = '';
      editorEl.innerHTML = '<div class="env-empty">No .env files found</div>';
      return;
    }

    result.files.forEach(function (filename) {
      var btn = document.createElement('button');
      btn.className = 'env-file-btn' + (filename === currentFilename ? ' active' : '');
      btn.textContent = filename;
      btn.addEventListener('click', function () {
        fileSelectorEl.querySelectorAll('.env-file-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        loadFile(filename);
      });
      fileSelectorEl.appendChild(btn);
    });

    // Auto-select first file if none selected
    if (!currentFilename || result.files.indexOf(currentFilename) === -1) {
      loadFile(result.files[0]);
      fileSelectorEl.querySelector('.env-file-btn').classList.add('active');
    }
  }

  async function loadFile(filename) {
    currentFilename = filename;
    var result = await window.klaus.readEnvFile(currentWorktreePath, filename);
    if (result.error) {
      editorEl.innerHTML = '<div class="env-empty">Error: ' + escHtml(result.error) + '</div>';
      return;
    }

    currentRows = parseEnvContent(result.content);
    renderEditor();
  }

  function parseEnvContent(content) {
    var rows = [];
    content.split('\n').forEach(function (line) {
      var trimmed = line.trim();
      if (trimmed === '') {
        rows.push({ type: 'blank' });
        return;
      }
      // Pure comment line (not a toggled-off variable)
      if (trimmed.startsWith('#') && !trimmed.match(/^#\s*[A-Za-z_][A-Za-z0-9_]*\s*=/)) {
        rows.push({ type: 'comment', text: trimmed });
        return;
      }
      // Toggled-off variable: # KEY=VALUE
      if (trimmed.startsWith('#')) {
        var rest = trimmed.replace(/^#\s*/, '');
        var eqIdx = rest.indexOf('=');
        if (eqIdx !== -1) {
          rows.push({ type: 'var', enabled: false, key: rest.substring(0, eqIdx), value: rest.substring(eqIdx + 1) });
          return;
        }
      }
      // Active variable: KEY=VALUE
      var eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        rows.push({ type: 'var', enabled: true, key: trimmed.substring(0, eqIdx), value: trimmed.substring(eqIdx + 1) });
      } else {
        rows.push({ type: 'comment', text: trimmed });
      }
    });
    return rows;
  }

  function renderEditor() {
    editorEl.innerHTML = '';
    currentRows.forEach(function (row, idx) {
      if (row.type === 'blank') return;
      if (row.type === 'comment') {
        var div = document.createElement('div');
        div.className = 'env-row env-comment-row';
        div.innerHTML = '<span class="env-comment-text">' + escHtml(row.text) + '</span>';
        editorEl.appendChild(div);
        return;
      }

      var div = document.createElement('div');
      div.className = 'env-row' + (row.enabled ? '' : ' env-disabled');
      div.innerHTML =
        '<label class="env-toggle"><input type="checkbox" ' + (row.enabled ? 'checked' : '') + ' data-idx="' + idx + '" /></label>' +
        '<input type="text" class="env-key-input" value="' + escAttr(row.key) + '" data-idx="' + idx + '" spellcheck="false" />' +
        '<span class="env-eq">=</span>' +
        '<div class="env-value-wrap">' +
          '<input type="password" class="env-value-input" value="' + escAttr(row.value) + '" data-idx="' + idx + '" spellcheck="false" />' +
          '<button class="env-toggle-vis" title="Show/hide value" data-idx="' + idx + '">&#128065;</button>' +
        '</div>';

      // Toggle enable/disable
      div.querySelector('input[type="checkbox"]').addEventListener('change', function () {
        currentRows[idx].enabled = this.checked;
        div.classList.toggle('env-disabled', !this.checked);
      });

      // Key editing
      div.querySelector('.env-key-input').addEventListener('input', function () {
        currentRows[idx].key = this.value;
      });

      // Value editing
      div.querySelector('.env-value-input').addEventListener('input', function () {
        currentRows[idx].value = this.value;
      });

      // Show/hide value
      div.querySelector('.env-toggle-vis').addEventListener('click', function () {
        var input = div.querySelector('.env-value-input');
        input.type = input.type === 'password' ? 'text' : 'password';
      });

      editorEl.appendChild(div);
    });
  }

  async function save() {
    if (!currentWorktreePath || !currentFilename) return;
    saveBtn.disabled = true;

    var lines = currentRows.map(function (row) {
      if (row.type === 'blank') return '';
      if (row.type === 'comment') return row.text;
      if (!row.enabled) return '# ' + row.key + '=' + row.value;
      return row.key + '=' + row.value;
    });

    var content = lines.join('\n');
    // Ensure trailing newline
    if (!content.endsWith('\n')) content += '\n';

    var result = await window.klaus.writeEnvFile(currentWorktreePath, currentFilename, content);
    saveBtn.disabled = false;

    if (result.error) {
      statusEl.textContent = 'Error: ' + result.error;
      statusEl.className = 'env-status-error';
    } else {
      statusEl.textContent = 'Saved';
      statusEl.className = 'env-status-ok';
      setTimeout(function () { statusEl.textContent = ''; }, 2000);
    }
  }

  function escHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function escAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  return { init: init, setWorktree: setWorktree, load: load };
})();
