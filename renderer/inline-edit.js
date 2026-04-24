// K3: Cmd+K inline AI edit. Select code (or place the cursor on a line),
// press Cmd+K, type an instruction, and claude streams a replacement.
// Accept or Reject the proposal.
//
// UX flow:
//   1. Monaco content widget above the selection: input + Submit.
//   2. View zone below the selection: streams output, then Accept / Reject.
//   3. Esc cancels at any stage (cancels the claude process if streaming).

window.InlineEdit = (function () {
  var session = null; // one active edit at a time

  function start(editor) {
    if (session) { cancel(); }
    var sel = editor.getSelection();
    var model = editor.getModel();
    if (!model) return;

    // If no selection, treat as the full current line — most natural for
    // "rewrite this" prompts when the user just parks the cursor somewhere.
    var range = sel;
    if (!sel || sel.isEmpty()) {
      var line = editor.getPosition().lineNumber;
      range = new monaco.Range(line, 1, line, model.getLineMaxColumn(line));
    }
    var selectionText = model.getValueInRange(range);

    session = {
      editor: editor,
      model: model,
      range: range,
      selectionText: selectionText,
      promptWidget: null,
      panelEl: null,
      requestId: null,
      buffer: '',
      disposeChunk: null,
      disposeDone: null,
      streamEl: null,
      actionsEl: null,
      stage: 'prompt',
    };
    showPromptWidget();
  }

  function showPromptWidget() {
    var s = session;
    if (!s) return;
    var container = document.createElement('div');
    container.className = 'inline-edit-prompt';
    container.innerHTML =
      '<input class="inline-edit-input" type="text" placeholder="Tell Claude what to change…" />' +
      '<button class="inline-edit-submit" type="button" title="Submit (Enter)"></button>' +
      '<button class="inline-edit-dismiss" type="button" title="Cancel (Esc)">×</button>';

    var input = container.querySelector('.inline-edit-input');
    var submitBtn = container.querySelector('.inline-edit-submit');
    var dismissBtn = container.querySelector('.inline-edit-dismiss');

    container.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submit(input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      e.stopPropagation();
    });
    submitBtn.addEventListener('click', function () { submit(input.value); });
    dismissBtn.addEventListener('click', cancel);

    s.promptWidget = {
      getId: function () { return 'inline-edit-prompt'; },
      getDomNode: function () { return container; },
      getPosition: function () {
        return {
          position: { lineNumber: s.range.startLineNumber, column: s.range.startColumn },
          preference: [
            monaco.editor.ContentWidgetPositionPreference.ABOVE,
            monaco.editor.ContentWidgetPositionPreference.BELOW,
          ],
        };
      },
    };
    s.editor.addContentWidget(s.promptWidget);
    setTimeout(function () { input.focus(); }, 30);
  }

  function submit(instruction) {
    if (!session) return;
    instruction = (instruction || '').trim();
    if (!instruction) return;
    var s = session;
    s.stage = 'streaming';

    // Reposition: swap the prompt for a "working…" header above the stream.
    var widgetEl = s.promptWidget.getDomNode();
    widgetEl.innerHTML =
      '<span class="inline-edit-status">⧗ Editing…</span>' +
      '<button class="inline-edit-dismiss" type="button" title="Cancel (Esc)">×</button>';
    widgetEl.querySelector('.inline-edit-dismiss').addEventListener('click', cancel);

    // Panel outside Monaco's DOM entirely — mounted as a sibling of the
    // editor inside `.file-viewer-body`. This sidesteps every Monaco-
    // related event / layout issue (view zones getting covered by the
    // minimap, mousedown being retargeted to the caret, etc.). It's just
    // an absolutely-positioned overlay at the bottom of the editor area.
    var body = document.querySelector('.file-viewer-body');
    if (!body) { cancel(); return; }
    var dom = document.createElement('div');
    dom.className = 'inline-edit-stream';
    dom.innerHTML =
      '<div class="inline-edit-stream-header">Proposed change</div>' +
      '<pre class="inline-edit-stream-body"></pre>' +
      '<div class="inline-edit-stream-actions">' +
        '<button class="inline-edit-reject" type="button">Reject</button>' +
        '<button class="inline-edit-accept" type="button" disabled>Accept ⏎</button>' +
      '</div>';
    body.appendChild(dom);
    s.streamEl = dom.querySelector('.inline-edit-stream-body');
    s.actionsEl = dom.querySelector('.inline-edit-stream-actions');
    s.panelEl = dom;
    dom.querySelector('.inline-edit-accept').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation(); accept();
    });
    dom.querySelector('.inline-edit-reject').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation(); cancel();
    });

    // Start the streaming IPC.
    s.requestId = 'ie-' + Date.now() + '-' + Math.floor(Math.random() * 9999);
    var worktree = typeof fileViewerWorktreeGetter === 'function'
      ? fileViewerWorktreeGetter() : null;
    // Prefer the model's URI path — `window.FileBrowserState` was never
    // actually populated anywhere, so this always landed as null and the
    // prompt lost the `File:` hint.
    var filePath = (s.model && s.model.uri && s.model.uri.fsPath) || null;
    var languageId = s.model.getLanguageId ? s.model.getLanguageId() : undefined;
    s.disposeChunk = window.klaus.ai.onInlineEditChunk(s.requestId, function (chunk) {
      s.buffer += chunk;
      if (s.streamEl) s.streamEl.textContent = s.buffer;
    });
    s.disposeDone = window.klaus.ai.onInlineEditDone(s.requestId, function (msg) {
      s.stage = 'ready';
      var header = s.panelEl && s.panelEl.querySelector('.inline-edit-stream-header');
      var acceptBtn = s.actionsEl && s.actionsEl.querySelector('.inline-edit-accept');
      if (msg && msg.error) {
        if (header) header.textContent = 'Error: ' + msg.error;
        if (acceptBtn) acceptBtn.disabled = true;
        if (widgetEl) {
          var statusEl = widgetEl.querySelector('.inline-edit-status');
          if (statusEl) statusEl.textContent = '✗ Failed';
        }
      } else if (msg && msg.cancelled) {
        cancel();
      } else {
        if (header) header.textContent = 'Proposed change';
        if (acceptBtn) acceptBtn.disabled = false;
        if (s.panelEl) s.panelEl.classList.add('ready');
        // Hide the prompt widget once the proposal is ready — the panel
        // below is now the primary surface. Prevents a leftover "Ready"
        // label floating awkwardly above the selection.
        if (s.promptWidget) {
          try { s.editor.removeContentWidget(s.promptWidget); } catch (_) {}
          s.promptWidget = null;
        }
      }
    });

    window.klaus.ai.inlineEditStart({
      requestId: s.requestId,
      worktreePath: worktree,
      instruction: instruction,
      selection: s.selectionText,
      languageId: languageId,
      filePath: filePath,
    });

    // Global key handlers while the panel is live: Enter accepts, Esc cancels.
    // Capture-phase so we catch the keys before Monaco/anything else consumes
    // them. Scoped only while session is active; cleanup removes the listener.
    s.keyHandler = function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
      else if (e.key === 'Enter' && s.stage === 'ready') {
        e.preventDefault(); e.stopPropagation();
        accept();
      }
    };
    window.addEventListener('keydown', s.keyHandler, true);
  }

  function accept() {
    if (!session) return;
    var s = session;
    if (s.stage !== 'ready' || !s.buffer) { cancel(); return; }
    // Strip any trailing newline so we don't add a gratuitous blank line.
    var replacement = s.buffer.replace(/\n$/, '');
    s.editor.executeEdits('inline-edit', [{
      range: s.range,
      text: replacement,
      forceMoveMarkers: true,
    }]);
    s.editor.focus();
    cleanup();
  }

  function cancel() {
    if (!session) return;
    var s = session;
    if (s.requestId && s.stage === 'streaming') {
      try { window.klaus.ai.inlineEditCancel(s.requestId); } catch (_) {}
    }
    cleanup();
  }

  function cleanup() {
    if (!session) return;
    var s = session;
    if (s.disposeChunk) { try { s.disposeChunk(); } catch (_) {} }
    if (s.disposeDone) { try { s.disposeDone(); } catch (_) {} }
    if (s.promptWidget) { try { s.editor.removeContentWidget(s.promptWidget); } catch (_) {} }
    if (s.panelEl && s.panelEl.parentNode) { s.panelEl.parentNode.removeChild(s.panelEl); }
    if (s.keyHandler) { window.removeEventListener('keydown', s.keyHandler, true); }
    session = null;
  }

  // Convenience helper: called by file-browser to supply the worktree context
  // without tight coupling. File-browser sets this once during init.
  var fileViewerWorktreeGetter = null;
  function setWorktreeGetter(fn) { fileViewerWorktreeGetter = fn; }

  return { start: start, cancel: cancel, setWorktreeGetter: setWorktreeGetter };
})();
