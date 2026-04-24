// K6: manual-trigger AI completion. Cmd+Shift+Space fires claude with the
// text around the cursor; the response shows as Monaco ghost text.
// Tab accepts, Esc dismisses (Monaco's built-in behaviors for inline
// completions do both for free once a provider is registered).
//
// Not auto/passive: claude -p has 1–3s latency, which would feel terrible
// as a keystroke-triggered autocomplete. Manual trigger gives the user
// control over when they pay that cost. Future: swap claude for a faster
// model and add an opt-in passive mode.

window.InlineComplete = (function () {
  var registered = false;
  var currentCompletion = null;  // { position, modelUri, text, requestToken }
  var currentRequest = null;     // { id, disposeChunk, disposeDone, buffer, editor, model, position }
  var worktreeGetter = null;

  function setWorktreeGetter(fn) { worktreeGetter = fn; }

  // Monaco calls the provider on every keystroke / cursor move. We return
  // null unless we have a freshly-triggered completion at the current
  // position — otherwise the provider would either do nothing useful or
  // (worse) fire claude on every keystroke.
  function registerProvider() {
    if (registered) return;
    registered = true;
    var monaco = window.monaco;
    if (!monaco) return;
    monaco.languages.registerInlineCompletionsProvider({ pattern: '**' }, {
      provideInlineCompletions: function (model, position) {
        if (!currentCompletion) return { items: [] };
        if (currentCompletion.modelUri !== model.uri.toString()) return { items: [] };
        if (currentCompletion.position.lineNumber !== position.lineNumber ||
            currentCompletion.position.column !== position.column) {
          return { items: [] };
        }
        return {
          items: [{
            insertText: currentCompletion.text,
            range: new monaco.Range(
              position.lineNumber, position.column,
              position.lineNumber, position.column
            ),
          }],
        };
      },
      freeInlineCompletions: function () {},
    });
  }

  function setStatus(text) {
    var el = document.querySelector('.file-viewer-status-ai');
    if (!el) {
      // Inject into the status bar — small right-side indicator.
      var right = document.querySelector('.file-viewer-statusbar .statusbar-right');
      if (!right) return;
      el = document.createElement('span');
      el.className = 'statusbar-item file-viewer-status-ai';
      right.insertBefore(el, right.firstChild);
    }
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = text;
  }

  async function trigger(editor) {
    registerProvider();
    var monaco = window.monaco;
    var model = editor.getModel();
    if (!model) return;
    var position = editor.getPosition();
    if (!position) return;

    // Cancel any in-flight request.
    if (currentRequest) cancel();

    // Clear any prior completion — stale ghost text from an old trigger
    // would be confusing.
    currentCompletion = null;

    // Gather context: ~80 lines before, ~20 after. Monaco fills this in
    // cheaply from the model.
    var before = model.getValueInRange({
      startLineNumber: Math.max(1, position.lineNumber - 80),
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: position.column,
    });
    var after = model.getValueInRange({
      startLineNumber: position.lineNumber,
      startColumn: position.column,
      endLineNumber: Math.min(model.getLineCount(), position.lineNumber + 20),
      endColumn: model.getLineMaxColumn(Math.min(model.getLineCount(), position.lineNumber + 20)),
    });

    var requestId = 'ic-' + Date.now() + '-' + Math.floor(Math.random() * 9999);
    var buffer = '';
    var modelUri = model.uri.toString();
    var worktree = typeof worktreeGetter === 'function' ? worktreeGetter() : null;

    setStatus('⧗ completing…');

    var disposeChunk = window.klaus.ai.onInlineCompleteChunk(requestId, function (chunk) {
      buffer += chunk;
    });
    var disposeDone = window.klaus.ai.onInlineCompleteDone(requestId, function (msg) {
      if (disposeChunk) disposeChunk();
      if (disposeDone) disposeDone();
      currentRequest = null;
      if (msg && msg.error) {
        setStatus('✗ ' + (msg.error || 'completion failed'));
        setTimeout(function () { setStatus(''); }, 3000);
        return;
      }
      if (msg && msg.cancelled) { setStatus(''); return; }
      setStatus('');
      var text = (buffer || '').replace(/^\s*\n/, '');
      if (!text.trim()) return;
      // Strip code fences if claude wrapped them despite the prompt asking
      // it not to — belt-and-suspenders.
      text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/, '');
      // Check the cursor hasn't moved. If it has, skip rendering — stale.
      var nowPos = editor.getPosition();
      if (!nowPos || nowPos.lineNumber !== position.lineNumber || nowPos.column !== position.column) return;
      if (editor.getModel() !== model) return;
      currentCompletion = {
        position: position,
        modelUri: modelUri,
        text: text,
      };
      // Poke Monaco to refresh its inline suggestion — it won't re-query
      // the provider on its own just because our state changed.
      editor.trigger('inline-complete', 'editor.action.inlineSuggest.trigger', {});
    });

    currentRequest = { id: requestId, disposeChunk: disposeChunk, disposeDone: disposeDone };

    window.klaus.ai.inlineCompleteStart({
      requestId: requestId,
      worktreePath: worktree,
      before: before,
      after: after,
      languageId: model.getLanguageId && model.getLanguageId(),
      filePath: null,
    });
  }

  function cancel() {
    if (!currentRequest) return;
    try { window.klaus.ai.inlineCompleteCancel(currentRequest.id); } catch (_) {}
    try { currentRequest.disposeChunk && currentRequest.disposeChunk(); } catch (_) {}
    try { currentRequest.disposeDone && currentRequest.disposeDone(); } catch (_) {}
    currentRequest = null;
    setStatus('');
  }

  return {
    trigger: trigger,
    cancel: cancel,
    setWorktreeGetter: setWorktreeGetter,
  };
})();
