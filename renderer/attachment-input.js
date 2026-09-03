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

  // A path dropped into the middle of the prose is already where it belongs,
  // and that placement is the point: this one is the bug, this one is the goal.
  // Only attachments the text never placed get listed at the end.
  function composeSubmission(text, items) {
    var body = (text || '').trim();
    if (!items || !items.length) return body;
    var loose = items
      .map(function (item) { return typeof item === 'string' ? item : item.path; })
      .filter(function (p) { return body.indexOf(p) === -1; });
    if (!loose.length) return body;
    var attached = 'Attached files/folders for this task (read them):\n' + loose.map(quotePath).join('\n');
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
    var items = [];
    var emptyText = opts.emptyText || 'No files attached';
    var editor = opts.insertInto || opts.pasteFrom || null;
    // A drop lands on the container, not the box, so the caret is wherever the
    // user last left it. Null until they have actually put it somewhere.
    var lastCaret = null;
    // Bumped by clear(). Saving bytes is async, so a dialog reopened mid-save
    // would otherwise get the late result written into its fresh prompt.
    var generation = 0;

    if (editor) {
      ['keyup', 'click', 'select', 'focus'].forEach(function (evt) {
        editor.addEventListener(evt, function () { lastCaret = editor.selectionStart; });
      });
    }

    function setError(msg) {
      if (opts.errorEl) opts.errorEl.textContent = msg;
    }

    // Drops the path on its own line where the caret is, so the sentence
    // introducing the screenshot stays next to it.
    function insertPath(p) {
      if (!editor) return;
      var value = editor.value;
      var at = lastCaret === null || lastCaret > value.length ? value.length : lastCaret;
      var before = value.slice(0, at);
      var after = value.slice(at);
      var lead = before && !/\n$/.test(before) ? '\n' : '';
      var chunk = lead + quotePath(p);
      editor.value = before + chunk + after;
      lastCaret = (before + chunk).length;
      editor.selectionStart = editor.selectionEnd = lastCaret;
    }

    // Takes back the newline inserted with the path and nothing else; the prose
    // may hold deliberate indentation.
    function stripPath(text, p) {
      var q = quotePath(p);
      return text.split('\n' + q).join('').split(q).join('');
    }

    function dropPathFromText(p) {
      if (!editor) return;
      editor.value = stripPath(editor.value, p);
    }

    function render() {
      if (opts.displayEl) {
        opts.displayEl.textContent = items.length === 0 ? emptyText
          : (items.length === 1 ? basename(items[0].path) : items.length + ' items attached');
        opts.displayEl.classList.toggle('has-file', items.length > 0);
      }
      if (!opts.listEl) return;
      opts.listEl.innerHTML = '';
      items.forEach(function (it, i) {
        var row = document.createElement('div');
        row.className = 'plan-file-row';
        var nameEl = document.createElement('span');
        nameEl.textContent = basename(it.path);
        nameEl.title = it.path;
        var rm = document.createElement('button');
        rm.className = 'plan-file-remove';
        rm.type = 'button';
        rm.textContent = '×';
        rm.title = 'Remove';
        rm.addEventListener('click', function () {
          items.splice(i, 1);
          dropPathFromText(it.path);
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
      var gen = generation;
      var results = await Promise.all(files.map(pathForDropped));
      if (gen !== generation) return;
      // Dedupe so the same path added twice doesn't appear twice. Use the ×
      // buttons to drop individual items.
      results.forEach(function (r) {
        if (!r.path) return;
        // Referencing one image at two spots is legitimate, so a repeat drop
        // writes the path again rather than looking like it did nothing.
        if (!items.some(function (it) { return it.path === r.path; })) items.push({ path: r.path });
        insertPath(r.path);
      });
      render();
      setError(describeErrors(results.filter(function (r) { return !r.path; })));
    }

    function clear() {
      generation++;
      // Strip the paths too: the New Session dialog keeps its prose across
      // opens, and a path with nothing attached still ships to the agent.
      items.forEach(function (it) { dropPathFromText(it.path); });
      items = [];
      lastCaret = null;
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
        lastCaret = opts.pasteFrom.selectionStart;
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

    // The prose without the inline paths, for callers naming a branch or
    // labelling the loop, where a temp path would otherwise leak through.
    function plain(text) {
      var out = text || '';
      items.forEach(function (it) { out = stripPath(out, it.path); });
      return out.trim();
    }

    return {
      add: add,
      clear: clear,
      plain: plain,
      paths: function () { return items.map(function (it) { return it.path; }); },
      compose: function (text) { return composeSubmission(text, items); },
    };
  }

  return {
    create: create,
    composeSubmission: composeSubmission,
    describeErrors: describeErrors,
    quotePath: quotePath,
  };
})();
