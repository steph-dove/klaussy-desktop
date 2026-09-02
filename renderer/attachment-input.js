// Attachment handling shared by the surfaces that take a task definition: the
// action modal and the New Session dialog's dev-loop field. Both need the same
// thing, prose plus the screenshots it refers to, sent together.
window.AttachmentInput = (function () {
  // Quote for the shell only when there is whitespace, matching the terminal
  // drag-drop behavior.
  function quotePath(p) {
    return /\s/.test(p) ? '"' + p + '"' : p;
  }

  function basename(p) {
    var parts = String(p).split(/[\\/]/);
    return parts[parts.length - 1] || p;
  }

  // Additive, never either/or: attachments follow the text so the agent reads
  // the ask before the files.
  function composeSubmission(text, paths) {
    var body = (text || '').trim();
    if (!paths || !paths.length) return body;
    var attached = 'Attached files/folders for this task (read them):\n' + paths.map(quotePath).join('\n');
    return body ? body + '\n\n' + attached : attached;
  }

  // A Finder drag has a real path; a browser or clipboard image is bytes only.
  // Returns { name, path } on success, { name, error } with the reason on failure.
  async function pathForDropped(file) {
    var fsApi = (window.klaus && window.klaus.fs) || {};
    var name = file.name || 'item';
    try {
      var existing = fsApi.getPathForFile && fsApi.getPathForFile(file);
      if (existing) return { name: name, path: existing };
    } catch (_err) { /* no backing file — fall through to the bytes */ }
    if (!fsApi.saveAttachment || typeof file.arrayBuffer !== 'function') {
      return { name: name, error: 'no file behind it to read' };
    }
    try {
      var buf = await file.arrayBuffer();
      var saved = await fsApi.saveAttachment(name, new Uint8Array(buf));
      if (saved && saved.path) return { name: name, path: saved.path };
      return { name: name, error: (saved && saved.error) || 'could not be saved' };
    } catch (err) {
      return { name: name, error: (err && err.message) || 'could not be read' };
    }
  }

  // Name the reason (a size cap, an unreadable drag) rather than a generic
  // failure, so the user knows whether re-dropping is worth trying.
  function describeErrors(failed) {
    if (!failed.length) return '';
    if (failed.length === 1) return failed[0].name + ' could not be attached: ' + failed[0].error;
    return failed.length + ' items could not be attached — ' + failed[0].name + ': ' + failed[0].error;
  }

  function draggingFiles(e) {
    var types = e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.prototype.indexOf.call(types, 'Files') !== -1;
  }

  // Wires one surface. Every element is optional so a caller can opt out of the
  // picker or the drop zone. Returns the handle the caller reads at submit time.
  function create(opts) {
    var paths = [];
    var emptyText = opts.emptyText || 'No files attached';

    function setError(msg) {
      if (opts.errorEl) opts.errorEl.textContent = msg;
    }

    function render() {
      if (opts.displayEl) {
        opts.displayEl.textContent = paths.length === 0 ? emptyText
          : (paths.length === 1 ? basename(paths[0]) : paths.length + ' items attached');
        opts.displayEl.classList.toggle('has-file', paths.length > 0);
      }
      if (!opts.listEl) return;
      opts.listEl.innerHTML = '';
      paths.forEach(function (p, i) {
        var row = document.createElement('div');
        row.className = 'plan-file-row';
        var nameEl = document.createElement('span');
        nameEl.textContent = basename(p);
        nameEl.title = p;
        var rm = document.createElement('button');
        rm.className = 'plan-file-remove';
        rm.type = 'button';
        rm.textContent = '×';
        rm.title = 'Remove';
        rm.addEventListener('click', function () {
          paths.splice(i, 1);
          render();
        });
        row.appendChild(nameEl);
        row.appendChild(rm);
        opts.listEl.appendChild(row);
      });
    }

    async function add(files) {
      if (!files || files.length === 0) return;
      setError('');
      var results = await Promise.all(files.map(pathForDropped));
      // Dedupe so the same path added twice doesn't appear twice. Use the ×
      // buttons to drop individual items.
      results.forEach(function (r) {
        if (r.path && paths.indexOf(r.path) === -1) paths.push(r.path);
      });
      render();
      setError(describeErrors(results.filter(function (r) { return !r.path; })));
    }

    function clear() {
      paths = [];
      if (opts.fileInput) opts.fileInput.value = '';
      // The error names files that are no longer attached, so it goes too.
      setError('');
      render();
    }

    if (opts.pickButton && opts.fileInput) {
      opts.pickButton.addEventListener('click', function () { opts.fileInput.click(); });
    }
    if (opts.fileInput) {
      opts.fileInput.addEventListener('change', function () {
        add(opts.fileInput.files ? Array.from(opts.fileInput.files) : []);
      });
    }
    // Screenshots reach the clipboard before they reach the disk. Only a paste
    // carrying files is intercepted; text pastes keep their native behavior.
    if (opts.pasteFrom) {
      opts.pasteFrom.addEventListener('paste', function (e) {
        var items = e.clipboardData && e.clipboardData.files;
        if (!items || items.length === 0) return;
        e.preventDefault();
        add(Array.from(items));
      });
    }
    // Only engages for file drags, so text drags into a textarea still work.
    if (opts.dropZone) {
      var zone = opts.dropZone;
      zone.addEventListener('dragover', function (e) {
        if (!draggingFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        zone.classList.add('drag-over');
      });
      zone.addEventListener('dragleave', function (e) {
        // Only clear when the cursor leaves the zone, not when it crosses
        // between children (which also fire dragleave).
        if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over');
      });
      zone.addEventListener('drop', function (e) {
        if (!draggingFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        zone.classList.remove('drag-over');
        var files = Array.from(e.dataTransfer.files);
        if (files.length) add(files);
      });
    }

    render();

    return {
      add: add,
      clear: clear,
      paths: function () { return paths.slice(); },
      compose: function (text) { return composeSubmission(text, paths); },
    };
  }

  return {
    create: create,
    composeSubmission: composeSubmission,
    describeErrors: describeErrors,
    quotePath: quotePath,
  };
})();
