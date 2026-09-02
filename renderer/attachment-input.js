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

  function markerFor(label) {
    return '[' + label + ']';
  }

  // Markers keep long temp paths out of the box; they resolve here, and
  // anything the writer never placed is appended so none are lost.
  function composeSubmission(text, items) {
    var body = (text || '').trim();
    if (!items || !items.length) return body;
    var loose = [];
    items.forEach(function (item) {
      var entry = typeof item === 'string' ? { path: item, marker: null } : item;
      var token = entry.marker ? markerFor(entry.marker) : null;
      if (token && body.indexOf(token) !== -1) {
        body = body.split(token).join(quotePath(entry.path));
      } else if (body.indexOf(entry.path) === -1) {
        loose.push(entry.path);
      }
    });
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

    // Two screenshots often share a name, so the marker gets a counter rather
    // than pointing at whichever file was added first.
    function uniqueMarker(name) {
      var label = name;
      for (var n = 2; items.some(function (it) { return it.marker === label; }); n++) {
        label = name + ' ' + n;
      }
      return label;
    }

    // Drops the marker where the caret is, so the sentence introducing the
    // screenshot stays next to it.
    function insertMarker(marker) {
      if (!editor) return;
      var value = editor.value;
      var at = lastCaret === null || lastCaret > value.length ? value.length : lastCaret;
      var before = value.slice(0, at);
      var after = value.slice(at);
      var lead = before && !/\s$/.test(before) ? ' ' : '';
      var chunk = lead + markerFor(marker);
      editor.value = before + chunk + after;
      lastCaret = (before + chunk).length;
      editor.selectionStart = editor.selectionEnd = lastCaret;
    }

    // Takes back the separator inserted with the marker and nothing else; the
    // prose may hold deliberate indentation.
    function dropMarkerFromText(marker) {
      if (!editor) return;
      var token = markerFor(marker);
      if (editor.value.indexOf(token) === -1) return;
      editor.value = editor.value.split(' ' + token).join('').split(token).join('');
    }

    function render() {
      if (opts.displayEl) {
        opts.displayEl.textContent = items.length === 0 ? emptyText
          : (items.length === 1 ? items[0].marker : items.length + ' items attached');
        opts.displayEl.classList.toggle('has-file', items.length > 0);
      }
      if (!opts.listEl) return;
      opts.listEl.innerHTML = '';
      items.forEach(function (it, i) {
        var row = document.createElement('div');
        row.className = 'plan-file-row';
        var nameEl = document.createElement('span');
        nameEl.textContent = it.marker;
        nameEl.title = it.path;
        var rm = document.createElement('button');
        rm.className = 'plan-file-remove';
        rm.type = 'button';
        rm.textContent = '×';
        rm.title = 'Remove';
        rm.addEventListener('click', function () {
          items.splice(i, 1);
          dropMarkerFromText(it.marker);
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
        if (!r.path || items.some(function (it) { return it.path === r.path; })) return;
        var marker = uniqueMarker(basename(r.path));
        items.push({ path: r.path, marker: marker });
        insertMarker(marker);
      });
      render();
      setError(describeErrors(results.filter(function (r) { return !r.path; })));
    }

    function clear() {
      generation++;
      // Strip the markers too: the New Session dialog keeps its prose across
      // opens, and a marker with nothing behind it ships as literal text.
      items.forEach(function (it) { dropMarkerFromText(it.marker); });
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

    return {
      add: add,
      clear: clear,
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
