// Inline AI completion. Two backends share the same Monaco ghost-text
// provider + state machine so the UX (Tab accepts, Esc dismisses) is
// identical regardless of who produced the text:
//
//   - Manual (Cmd+Shift+Space): claude -p. High quality, 1-3s latency.
//   - Passive (typing pause, ~150ms debounce): Ollama fill-in-middle with
//     qwen2.5-coder:1.5b running locally. ~50-200ms TTFT. Only activates
//     if a probe succeeds — otherwise word-complete.js keeps running as
//     the always-on fallback.
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
    return { model: model, position: position, before: before, after: after };
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
      languageId: ctx.model.getLanguageId && ctx.model.getLanguageId(),
      filePath: null,
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

    window.klaus.ai.ollama.completeStart({
      requestId: requestId,
      prefix: ctx.before,
      suffix: ctx.after,
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

  // Runs the consent+install flow if the user hasn't set Ollama up yet,
  // then probes. Caches the result in `ollamaAvailable` so subsequent editor
  // opens skip the round-trip. Returns true iff the passive trigger should
  // activate on this editor.
  async function probeOllamaOnce() {
    if (ollamaAvailable !== null) return ollamaAvailable;
    try {
      // Consent gate — shows modal only when state is not-ready-and-not-
      // declined. Returns { ok: true } when the full pipeline succeeds (or
      // when Ollama was already set up), { ok: false, declined: true } if
      // the user opted out.
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

    // Cursor moves without a content change (e.g. arrow keys, click) should
    // cancel in-flight requests + hide ghost text. We intentionally do NOT
    // clear debounceTimer here — Monaco fires cursor-position events during
    // ordinary typing too, with a source string that's not reliably 'model',
    // and clearing the timer on each keystroke was stopping the debounce
    // from ever firing. The content-change handler already schedules fresh
    // debounce on every edit, so leaving any pending timer alone is safe.
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
