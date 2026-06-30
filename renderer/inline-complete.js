// Inline AI completion. Two backends share the same Monaco ghost-text
// provider + state machine so the UX (Tab accepts, Esc dismisses) is
// identical regardless of who produced the text:
//
//   - Manual (Cmd+Shift+Space): claude -p. High quality, 1-3s latency.
//   - Passive (~150ms debounce): Ollama qwen2.5-coder:1.5b fill-in-middle,
//     ~50-200ms TTFT; falls back to word-complete.js if the probe fails.
//
// The two paths use different IPC surfaces (window.klaus.ai.inlineComplete*
// for Claude, window.klaus.ai.ollama.* for Ollama) but both end up setting
// `currentCompletion` which the single InlineCompletionsProvider reads.

window.InlineComplete = (function () {
  var registered = false;
  var currentCompletion = null;  // { position, modelUri, text }
  var currentRequest = null;     // { id, disposeChunk, disposeDone, cancel }
  var worktreeGetter = null;

  // Passive-trigger state, keyed by editor so we can clean up on detach.
  var attachedEditors = new WeakSet();
  var ollamaAvailable = null;  // null = unprobed, true/false = cached
  var PASSIVE_DEBOUNCE_MS = 150;
  var MIN_PREFIX_CHARS = 2;    // don't fire for the very first keystroke

  function setWorktreeGetter(fn) { worktreeGetter = fn; }

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

  function gatherContext(editor) {
    var model = editor.getModel();
    if (!model) return null;
    var position = editor.getPosition();
    if (!position) return null;
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
    return {
      model: model, position: position, before: before, after: after,
      filePath: (model.uri && model.uri.fsPath) || null,
      languageId: (model.getLanguageId && model.getLanguageId()) || null,
    };
  }

  // Repo-relative path for the FIM `<|file_sep|>` token (matches Qwen's
  // training format); falls back to the basename when outside the worktree.
  function relPath(abs, worktree) {
    if (!abs) return '';
    if (worktree && abs.indexOf(worktree) === 0) return abs.slice(worktree.length).replace(/^[/\\]/, '');
    return abs.split(/[/\\]/).pop();
  }

  // A few neighbouring open tabs as cross-file FIM context. Newest tabs first
  // (most relevant), current file excluded, each head-truncated so the whole
  // set stays well inside the model's context budget.
  function gatherSnippets(currentFilePath, worktree) {
    var MAX_FILES = 3;
    var MAX_CHARS = 2000;
    var out = [];
    try {
      if (!window.FileBrowser || !window.FileBrowser.listOpenFiles) return out;
      var open = window.FileBrowser.listOpenFiles();
      for (var i = open.length - 1; i >= 0 && out.length < MAX_FILES; i--) {
        var f = open[i];
        if (!f || !f.filePath || !f.content || f.filePath === currentFilePath) continue;
        out.push({
          path: relPath(f.filePath, worktree),
          content: f.content.length > MAX_CHARS ? f.content.slice(0, MAX_CHARS) : f.content,
        });
      }
    } catch (_) {}
    return out;
  }

  // Finalizes the completion and pokes Monaco to re-query the provider. The
  // cursor/model checks guard against staleness when the user has kept
  // typing while the request was in flight.
  function applyCompletion(editor, ctx, text) {
    text = (text || '').replace(/^\s*\n/, '');
    if (!text.trim()) return;
    text = text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/, '');
    var nowPos = editor.getPosition();
    if (!nowPos || nowPos.lineNumber !== ctx.position.lineNumber || nowPos.column !== ctx.position.column) return;
    if (editor.getModel() !== ctx.model) return;
    currentCompletion = {
      position: ctx.position,
      modelUri: ctx.model.uri.toString(),
      text: text,
    };
    editor.trigger('inline-complete', 'editor.action.inlineSuggest.trigger', {});
  }

  // Claude-backed manual trigger (Cmd+Shift+Space). High-quality, slow.
  async function trigger(editor) {
    registerProvider();
    var ctx = gatherContext(editor);
    if (!ctx) return;
    if (currentRequest) cancel();
    currentCompletion = null;

    var requestId = 'ic-' + Date.now() + '-' + Math.floor(Math.random() * 9999);
    var buffer = '';
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
      applyCompletion(editor, ctx, buffer);
    });

    currentRequest = {
      id: requestId,
      disposeChunk: disposeChunk,
      disposeDone: disposeDone,
      cancel: function () { try { window.klaus.ai.inlineCompleteCancel(requestId); } catch (_) {} },
    };

    window.klaus.ai.inlineCompleteStart({
      requestId: requestId,
      worktreePath: worktree,
      before: ctx.before,
      after: ctx.after,
      languageId: ctx.languageId,
      filePath: ctx.filePath,
    });
  }

  // Ollama-backed passive trigger. Same provider, different backend.
  function triggerPassive(editor) {
    registerProvider();
    var ctx = gatherContext(editor);
    if (!ctx) return;
    if (currentRequest) cancel();
    currentCompletion = null;

    var requestId = 'op-' + Date.now() + '-' + Math.floor(Math.random() * 9999);
    var buffer = '';

    var disposeChunk = window.klaus.ai.ollama.onCompleteChunk(requestId, function (chunk) {
      buffer += chunk;
    });
    var disposeDone = window.klaus.ai.ollama.onCompleteDone(requestId, function (msg) {
      if (disposeChunk) disposeChunk();
      currentRequest = null;
      if (msg && msg.error) {
        console.warn('[ollama] completion failed:', msg.error);
        return;
      }
      if (msg && msg.cancelled) return;
      applyCompletion(editor, ctx, buffer);
    });

    currentRequest = {
      id: requestId,
      disposeChunk: disposeChunk,
      disposeDone: disposeDone,
      cancel: function () { try { window.klaus.ai.ollama.completeCancel(requestId); } catch (_) {} },
    };

    var worktree = typeof worktreeGetter === 'function' ? worktreeGetter() : null;
    window.klaus.ai.ollama.completeStart({
      requestId: requestId,
      prefix: ctx.before,
      suffix: ctx.after,
      filePath: relPath(ctx.filePath, worktree) || ctx.filePath || null,
      repoName: worktree ? worktree.split(/[/\\]/).filter(Boolean).pop() : null,
      snippets: gatherSnippets(ctx.filePath, worktree),
    });
  }

  function cancel() {
    if (!currentRequest) return;
    try { currentRequest.cancel && currentRequest.cancel(); } catch (_) {}
    try { currentRequest.disposeChunk && currentRequest.disposeChunk(); } catch (_) {}
    try { currentRequest.disposeDone && currentRequest.disposeDone(); } catch (_) {}
    currentRequest = null;
    setStatus('');
  }

  // Runs the consent+install flow if needed, then probes. Caches the result
  // in `ollamaAvailable` so later opens skip the round-trip. Returns true iff
  // the passive trigger should activate.
  async function probeOllamaOnce() {
    if (ollamaAvailable !== null) return ollamaAvailable;
    try {
      // Consent gate — modal shows only when not ready and not declined.
      // { ok: true } means pipeline succeeded or Ollama already set up;
      // { ok: false, declined: true } means the user opted out.
      if (window.OllamaConsent && typeof window.OllamaConsent.openIfNeeded === 'function') {
        var consent = await window.OllamaConsent.openIfNeeded();
        if (!(consent && consent.ok)) {
          ollamaAvailable = false;
          return false;
        }
      }
      var r = await window.klaus.ai.ollama.probe();
      ollamaAvailable = !!(r && r.running && r.modelPresent);
      if (ollamaAvailable) {
        try { window.klaus.ai.ollama.warmup(); } catch {}
      }
    } catch {
      ollamaAvailable = false;
    }
    return ollamaAvailable;
  }

  // Attaches passive ghost-text to an editor. Idempotent per editor. Does
  // nothing if Ollama isn't available — word-complete.js stays as the
  // always-on fallback in that case.
  async function attach(editor) {
    if (!editor || attachedEditors.has(editor)) return;
    attachedEditors.add(editor);
    registerProvider();

    var available = await probeOllamaOnce();
    if (!available) return;

    var debounceTimer = null;

    function scheduleRequest() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        debounceTimer = null;
        var ctx = gatherContext(editor);
        if (!ctx) return;
        // Don't fire on near-empty prefixes — usually not useful and just
        // warms the KV cache for nothing.
        if (ctx.before.replace(/\s+/g, '').length < MIN_PREFIX_CHARS) return;
        triggerPassive(editor);
      }, PASSIVE_DEBOUNCE_MS);
    }

    editor.onDidChangeModelContent(function () {
      if (currentRequest) cancel();
      currentCompletion = null;
      scheduleRequest();
    });

    // Cursor moves without a content change cancel in-flight requests + hide
    // ghost text, but must NOT clear debounceTimer: Monaco also fires this on
    // ordinary typing, and clearing it each keystroke stopped debounce firing.
    editor.onDidChangeCursorPosition(function () {
      if (currentRequest) cancel();
      currentCompletion = null;
    });
  }

  return {
    trigger: trigger,
    cancel: cancel,
    setWorktreeGetter: setWorktreeGetter,
    attach: attach,
  };
})();
