// Renderer-side LSP orchestration (Phase I4).
//
// Responsibilities:
//   - Start a language server for a (worktree, languageId) pair on demand
//   - Send textDocument/didOpen, didChange, didClose, didSave for each file
//   - Register Monaco providers (completion, hover, definition) that forward
//     to the server
//   - Translate publishDiagnostics into Monaco model markers
//
// The translation layer between LSP types and Monaco types is deliberately
// minimal — just enough to cover the four features we ship in I4. Richer
// surfaces (signature help, refs, rename, code actions) come later.

(function () {
  // One session per (languageId, worktreePath). Keyed "python:/abs/path".
  var sessions = new Map();
  // One provider registration per (languageId, kind). Providers are global
  // in Monaco, so we register once per language and dispatch to the right
  // session based on the model's worktree.
  var providerRegistered = new Map(); // `${languageId}:${kind}` -> true

  // Maps a Monaco model URI to the session it belongs to. didOpen/didChange
  // lookup is cheap this way and we can ignore models outside any session.
  var modelToSession = new WeakMap();

  // For each open document URI, a function that fires any pending debounced
  // didChange immediately. Save paths call this before didSave so the server
  // never sees "saved" notifications out of order with the actual content.
  var pendingFlushes = new Map();

  var LANGUAGE_PATTERNS = [
    { re: /\.py$/i, languageId: 'python' },
    { re: /\.rs$/i, languageId: 'rust' },
    { re: /\.go$/i, languageId: 'go' },
    // Ruby + Rails: ruby-lsp handles .rb source, .erb templates (Rails views),
    // and .rake task files under the same 'ruby' languageId. Rails-specific
    // intel activates automatically via the ruby-lsp-rails add-on.
    { re: /\.(rb|erb|rake)$/i, languageId: 'ruby' },
    { re: /\.java$/i, languageId: 'java' },
    // clangd covers both C and C++ from one binary. Headers too.
    { re: /\.(c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|h\+\+)$/i, languageId: 'cpp' },
    { re: /\.(php|phtml)$/i, languageId: 'php' },
    { re: /\.cs$/i, languageId: 'csharp' },
    { re: /\.swift$/i, languageId: 'swift' },
    { re: /\.(kt|kts)$/i, languageId: 'kotlin' },
    { re: /\.vue$/i, languageId: 'vue' },
    { re: /\.svelte$/i, languageId: 'svelte' },
    { re: /\.astro$/i, languageId: 'astro' },
    // Dockerfile detection is filename-based, not extension-based. Match
    // `Dockerfile`, `Dockerfile.dev`, `Dockerfile.prod`, and `foo.dockerfile`.
    { re: /(^|\/)Dockerfile(\.[^/]+)?$|\.dockerfile$/i, languageId: 'dockerfile' },
    { re: /\.(yaml|yml)$/i, languageId: 'yaml' },
    { re: /\.(md|markdown)$/i, languageId: 'markdown' },
    { re: /\.lua$/i, languageId: 'lua' },
  ];

  function languageIdForPath(filePath) {
    for (var i = 0; i < LANGUAGE_PATTERNS.length; i++) {
      if (LANGUAGE_PATTERNS[i].re.test(filePath)) return LANGUAGE_PATTERNS[i].languageId;
    }
    return null;
  }

  function sessionKey(languageId, worktreePath) {
    return languageId + ':' + worktreePath;
  }

  function fileUri(absPath) {
    // Monaco uses `file:///…` URIs; LSP wants the same string form.
    return 'file://' + encodeURI(absPath).replace(/#/g, '%23').replace(/\?/g, '%3F');
  }

  // Find the session a given Monaco model belongs to (if any).
  function sessionForModel(model) {
    return modelToSession.get(model) || null;
  }

  // ---- Monaco ↔ LSP type conversions (narrow subset) ----

  function lspPositionToMonaco(pos) {
    return { lineNumber: (pos.line || 0) + 1, column: (pos.character || 0) + 1 };
  }

  function monacoPositionToLsp(pos) {
    return { line: pos.lineNumber - 1, character: pos.column - 1 };
  }

  function lspRangeToMonaco(range) {
    if (!range) return null;
    return {
      startLineNumber: (range.start.line || 0) + 1,
      startColumn: (range.start.character || 0) + 1,
      endLineNumber: (range.end.line || 0) + 1,
      endColumn: (range.end.character || 0) + 1,
    };
  }

  function lspSeverityToMonaco(monaco, sev) {
    // LSP: 1=Error, 2=Warning, 3=Info, 4=Hint
    var M = monaco.MarkerSeverity;
    if (sev === 1) return M.Error;
    if (sev === 2) return M.Warning;
    if (sev === 3) return M.Info;
    return M.Hint;
  }

  // ---- Session lifecycle ----

  async function ensureSession(languageId, worktreePath) {
    var key = sessionKey(languageId, worktreePath);
    var existing = sessions.get(key);
    if (existing && !existing.failed) return existing;

    var startResult = await window.klaus.lspStart(worktreePath, languageId);
    // If the binary isn't installed, try to auto-install it with a visible
    // inline banner, then retry the start once. Happens once per language per
    // app run; subsequent opens skip straight through because the binary is
    // already on PATH.
    if (startResult.error && startResult.missing) {
      var installResult = await runAutoInstall(languageId);
      if (installResult.ok) {
        startResult = await window.klaus.lspStart(worktreePath, languageId);
      } else {
        showInstallBanner(friendlyName(languageId), {
          message: installResult.error || 'Install failed.',
          hint: installResult.installHint,
          isError: true,
        });
        sessions.set(key, { failed: true });
        return null;
      }
    }
    if (startResult.error) {
      console.warn('[lsp] start failed:', startResult.error);
      sessions.set(key, { failed: true });
      return null;
    }

    var session = {
      serverId: startResult.serverId,
      languageId: languageId,
      worktreePath: worktreePath,
      initialized: false,
      openDocs: new Set(), // URIs we've sent didOpen for
      disposeMessageHandler: null,
      diagnosticsByUri: new Map(),
    };
    sessions.set(key, session);

    session.disposeMessageHandler = window.klaus.onLspMessage(session.serverId, function (msg) {
      if (!msg) return;
      if (msg.type === 'notification') handleServerNotification(session, msg);
      if (msg.type === 'exit') teardownSession(session, /*serverExited*/true);
    });

    // LSP initialize handshake. Capabilities advertised are the minimum we
    // actually consume back; declaring more would trigger more inbound
    // traffic we'd then have to ignore.
    var initResult = await window.klaus.lspRequest(session.serverId, 'initialize', {
      processId: null,
      rootUri: fileUri(worktreePath),
      rootPath: worktreePath,
      workspaceFolders: [{ uri: fileUri(worktreePath), name: worktreePath.split('/').pop() }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: true, willSave: false, willSaveWaitUntil: false, dynamicRegistration: false },
          completion: {
            completionItem: { snippetSupport: false, documentationFormat: ['markdown', 'plaintext'] },
            contextSupport: true,
          },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: true },
          publishDiagnostics: { relatedInformation: true, versionSupport: false },
        },
        workspace: {
          workspaceFolders: true,
          configuration: true,
          didChangeConfiguration: { dynamicRegistration: false },
          // Without this, pyright won't re-read a file from disk after the
          // user saves it — stale cross-file diagnostics are the symptom.
          didChangeWatchedFiles: { dynamicRegistration: false },
        },
      },
      initializationOptions: {},
    });
    if (initResult && initResult.error) {
      console.warn('[lsp] initialize error:', initResult.error);
      teardownSession(session);
      return null;
    }
    await window.klaus.lspNotify(session.serverId, 'initialized', {});
    session.initialized = true;
    // Push initial settings. Pyright specifically will NOT scan the workspace
    // or publish diagnostics until it sees a workspace/didChangeConfiguration
    // — even though it also advertises pull-via-workspace/configuration. The
    // pull never happens because pyright's internal queue is gated on the
    // push. Without this, didOpen goes silent forever. Confirmed via standalone
    // LSP repro (`scripts/pyright-repro.js`).
    await window.klaus.lspNotify(session.serverId, 'workspace/didChangeConfiguration', {
      settings: settingsForLanguage(languageId),
    });

    // Register Monaco providers once per language on first successful init.
    var monaco = await window.MonacoReady;
    registerProvidersForLanguage(monaco, languageId);

    return session;
  }

  var FRIENDLY_NAMES = {
    python: 'pyright',
    rust: 'rust-analyzer',
    go: 'gopls',
    ruby: 'ruby-lsp',
    java: 'jdtls',
    cpp: 'clangd',
    php: 'intelephense',
    csharp: 'csharp-ls',
    swift: 'sourcekit-lsp',
    kotlin: 'kotlin-language-server',
    vue: '@vue/language-server',
    svelte: 'svelte-language-server',
    astro: '@astrojs/language-server',
    dockerfile: 'docker-langserver',
    yaml: 'yaml-language-server',
    markdown: 'marksman',
    lua: 'lua-language-server',
  };

  function friendlyName(languageId) {
    return FRIENDLY_NAMES[languageId] || languageId;
  }

  // Config envelope pushed after `initialized`. For pyright this is load-
  // bearing (pyright's analysis pipeline gates on the push arriving — see I4
  // notes); for the rest it's a cheap belt-and-suspenders that mirrors VS
  // Code's own behavior. Settings are mostly empty — defaults are fine.
  var CONFIG_SECTION_KEYS = {
    rust: 'rust-analyzer',
    go: 'gopls',
    ruby: 'rubyLsp',
    java: 'java',
    cpp: 'clangd',
    php: 'intelephense',
    csharp: 'csharp',
    swift: 'sourcekit-lsp',
    kotlin: 'kotlin',
    vue: 'vue',
    svelte: 'svelte',
    astro: 'astro',
    dockerfile: 'docker',
    yaml: 'yaml',
    markdown: 'marksman',
    lua: 'Lua',
  };

  function settingsForLanguage(languageId) {
    if (languageId === 'python') {
      return {
        python: {
          analysis: {
            diagnosticMode: 'openFilesOnly',
            useLibraryCodeForTypes: true,
            autoSearchPaths: true,
          },
        },
      };
    }
    var key = CONFIG_SECTION_KEYS[languageId];
    if (!key) return {};
    var settings = {};
    settings[key] = {};
    return settings;
  }

  // Drive the auto-install flow end to end: stream pipx/npm lines into the
  // banner so the user sees it's making progress, then tear the banner down
  // on success. On failure we leave a sticky error message with the hint.
  async function runAutoInstall(languageId) {
    var name = friendlyName(languageId);
    showInstallBanner(name, { message: 'Installing ' + name + '…' });
    var unsubscribe = window.klaus.onLspInstallProgress(languageId, function (msg) {
      if (!msg) return;
      if (msg.type === 'log') {
        updateInstallBanner({ detail: msg.line });
      } else if (msg.type === 'start') {
        updateInstallBanner({ message: 'Running: ' + msg.command });
      }
    });
    var result = await window.klaus.lspInstall(languageId);
    unsubscribe();
    if (result && result.ok) {
      showInstallBanner(name, { message: name + ' installed.', isSuccess: true });
      setTimeout(hideInstallBanner, 2000);
    }
    return result;
  }

  // Banner DOM lives under the file viewer so it sits right above where the
  // editor will render. Single global instance; multiple pending installs
  // share it — only one LSP language installs at a time in practice.
  var bannerEl = null;
  function ensureBannerMount() {
    if (bannerEl) return bannerEl;
    var host = document.getElementById('file-viewer-view');
    if (!host) return null;
    bannerEl = document.createElement('div');
    bannerEl.className = 'lsp-install-banner';
    bannerEl.hidden = true;
    host.insertBefore(bannerEl, host.firstChild);
    return bannerEl;
  }
  function showInstallBanner(name, opts) {
    var el = ensureBannerMount();
    if (!el) return;
    opts = opts || {};
    el.hidden = false;
    el.className = 'lsp-install-banner' + (opts.isError ? ' error' : '') + (opts.isSuccess ? ' success' : '');
    el.innerHTML = '';
    var msg = document.createElement('div');
    msg.className = 'lsp-install-banner-message';
    msg.textContent = opts.message || ('Installing ' + name + '…');
    el.appendChild(msg);
    if (opts.hint) {
      var hint = document.createElement('pre');
      hint.className = 'lsp-install-banner-hint';
      hint.textContent = opts.hint;
      el.appendChild(hint);
    }
    var detail = document.createElement('div');
    detail.className = 'lsp-install-banner-detail';
    el.appendChild(detail);
  }
  function updateInstallBanner(opts) {
    if (!bannerEl || bannerEl.hidden) return;
    if (opts.message) {
      var msg = bannerEl.querySelector('.lsp-install-banner-message');
      if (msg) msg.textContent = opts.message;
    }
    if (opts.detail) {
      var detail = bannerEl.querySelector('.lsp-install-banner-detail');
      if (detail) detail.textContent = opts.detail;
    }
  }
  function hideInstallBanner() {
    if (bannerEl) { bannerEl.hidden = true; bannerEl.innerHTML = ''; }
  }

  function teardownSession(session, serverExited) {
    if (!session) return;
    var key = sessionKey(session.languageId, session.worktreePath);
    sessions.delete(key);
    if (session.disposeMessageHandler) session.disposeMessageHandler();
    // Clear diagnostics on all models that belonged to this session.
    if (window.monaco && session.diagnosticsByUri) {
      session.diagnosticsByUri.forEach(function (_, uri) {
        var model = window.monaco.editor.getModel(window.monaco.Uri.parse(uri));
        if (model) window.monaco.editor.setModelMarkers(model, 'lsp-' + session.languageId, []);
      });
    }
    if (!serverExited) {
      window.klaus.lspStop(session.serverId).catch(function () {});
    }
  }

  // ---- didOpen / didChange / didSave / didClose plumbing ----

  async function attachModel(model, filePath, worktreePath) {
    if (!model || model.isDisposed()) return;
    var languageId = languageIdForPath(filePath);
    if (!languageId) return;
    var session = await ensureSession(languageId, worktreePath);
    if (!session) return;

    // If this exact model is already attached to this session, don't re-send
    // didOpen — pyright treats it as redundant and refuses to (re)analyze.
    // openFileViewer can trigger attachModel more than once for the same
    // Monaco model when tabs re-render without the model actually changing.
    if (modelToSession.get(model) === session) {
      console.log('[lsp] attachModel skipped — model already attached');
      return;
    }

    // Use the model's own URI so any diagnostics pyright echoes back match
    // what `monaco.editor.getModel(Uri.parse(...))` can look up. Mixing our
    // own fileUri() encoder with Monaco's parse has produced subtle mismatches
    // (trailing slashes, case folding on macOS) that silently drop diagnostics.
    var uri = model.uri.toString();
    // Only reset if we think pyright has this URI open under a prior model.
    // Sending didClose on a file pyright has never seen can interfere with
    // pyright's first analysis pass on open.
    if (session.openDocs.has(uri)) {
      window.klaus.lspNotify(session.serverId, 'textDocument/didClose', {
        textDocument: { uri: uri },
      });
      session.openDocs.delete(uri);
    }

    modelToSession.set(model, session);
    session.openDocs.add(uri);

    // If pyright already published diagnostics for this URI before the model
    // existed (common on first-open race), replay them now.
    if (session.pendingDiagnostics && session.pendingDiagnostics.has(uri)) {
      var stashed = session.pendingDiagnostics.get(uri);
      session.pendingDiagnostics.delete(uri);
      // Schedule after the microtask so the model lookup in applyDiagnostics
      // sees the model we're about to register.
      Promise.resolve().then(function () { applyDiagnostics(session, stashed); });
    }

    window.klaus.lspNotify(session.serverId, 'textDocument/didOpen', {
      textDocument: {
        uri: uri,
        languageId: languageId,
        version: 1,
        text: model.getValue(),
      },
    });

    // Stream content changes, debounced so we don't flood the server on fast
    // typing. Full-document sync (simpler than incremental) is fine for files
    // of this size; switching to incremental would require tracking version
    // numbers and diffing ranges, which pyright doesn't need for correctness.
    var version = 1;
    var changeTimer = null;
    function sendChangeNow() {
      if (changeTimer) { clearTimeout(changeTimer); changeTimer = null; }
      if (model.isDisposed()) return;
      version += 1;
      window.klaus.lspNotify(session.serverId, 'textDocument/didChange', {
        textDocument: { uri: uri, version: version },
        contentChanges: [{ text: model.getValue() }],
      });
    }
    var disposable = model.onDidChangeContent(function () {
      if (changeTimer) clearTimeout(changeTimer);
      changeTimer = setTimeout(sendChangeNow, 250);
    });
    pendingFlushes.set(uri, sendChangeNow);

    model.onWillDispose(function () {
      pendingFlushes.delete(uri);
      if (changeTimer) {
        clearTimeout(changeTimer);
        changeTimer = null;
        try { sendChangeNow(); } catch (_) {}
      }
      try { disposable.dispose(); } catch (_) {}
      if (session.openDocs.has(uri)) {
        session.openDocs.delete(uri);
        window.klaus.lspNotify(session.serverId, 'textDocument/didClose', {
          textDocument: { uri: uri },
        });
        // Nudge pyright to treat the file as "possibly changed on disk" when
        // anyone references it next. Without this, pyright's cached analysis
        // tree can hold the pre-rename view and downstream files (importers)
        // won't see stale-import errors on their next open.
        window.klaus.lspNotify(session.serverId, 'workspace/didChangeWatchedFiles', {
          changes: [{ uri: uri, type: 2 }],
        });
      }
      modelToSession.delete(model);
    });
  }

  function notifyDidSave(filePath) {
    var uri = fileUri(filePath);
    // Flush any debounced didChange so the server's view matches what just
    // hit disk — otherwise a fast ⌘S after typing leaves the server with
    // stale content and cross-file diagnostics will reference the old names.
    var flush = pendingFlushes.get(uri);
    if (flush) try { flush(); } catch (_) {}
    sessions.forEach(function (session) {
      if (session && session.openDocs && session.openDocs.has(uri)) {
        window.klaus.lspNotify(session.serverId, 'textDocument/didSave', {
          textDocument: { uri: uri },
        });
      }
      window.klaus.lspNotify(session.serverId, 'workspace/didChangeWatchedFiles', {
        changes: [{ uri: uri, type: 2 }],
      });
    });
  }
  // ---- Server → client notifications ----

  function handleServerNotification(session, msg) {
    if (msg.method === 'textDocument/publishDiagnostics') {
      applyDiagnostics(session, msg.params);
    }
  }

  async function applyDiagnostics(session, params) {
    var monaco = await window.MonacoReady;
    if (!params || !params.uri) return;
    var model = monaco.editor.getModel(monaco.Uri.parse(params.uri));
    if (!model) {
      // Race: diagnostics arrived before attachModel registered the model.
      // Stash and replay when the model is registered.
      session.pendingDiagnostics = session.pendingDiagnostics || new Map();
      session.pendingDiagnostics.set(params.uri, params);
      return;
    }
    var markers = (params.diagnostics || []).map(function (d) {
      var r = lspRangeToMonaco(d.range) || { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
      return {
        severity: lspSeverityToMonaco(monaco, d.severity),
        message: d.message || '',
        source: d.source || session.languageId,
        code: d.code != null ? String(d.code) : undefined,
        startLineNumber: r.startLineNumber,
        startColumn: r.startColumn,
        endLineNumber: r.endLineNumber,
        endColumn: r.endColumn,
      };
    });
    monaco.editor.setModelMarkers(model, 'lsp-' + session.languageId, markers);
    session.diagnosticsByUri.set(params.uri, markers);
  }

  // ---- Monaco provider registrations ----

  function registerProvidersForLanguage(monaco, languageId) {
    ['completion', 'hover', 'definition'].forEach(function (kind) {
      var key = languageId + ':' + kind;
      if (providerRegistered.get(key)) return;
      providerRegistered.set(key, true);
      if (kind === 'completion') registerCompletion(monaco, languageId);
      if (kind === 'hover') registerHover(monaco, languageId);
      if (kind === 'definition') registerDefinition(monaco, languageId);
    });
  }

  function registerCompletion(monaco, languageId) {
    monaco.languages.registerCompletionItemProvider(languageId, {
      triggerCharacters: ['.', '(', '"', "'", '[', '@'],
      provideCompletionItems: async function (model, position) {
        var session = sessionForModel(model);
        if (!session) return { suggestions: [] };
        var uri = model.uri.toString();
        var resp = await window.klaus.lspRequest(session.serverId, 'textDocument/completion', {
          textDocument: { uri: uri },
          position: monacoPositionToLsp(position),
          context: { triggerKind: 1 },
        });
        if (!resp || resp.error || !resp.result) return { suggestions: [] };
        var items = Array.isArray(resp.result) ? resp.result : resp.result.items || [];
        var word = model.getWordUntilPosition(position);
        var range = {
          startLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: word.endColumn,
        };
        return {
          suggestions: items.map(function (it) {
            return {
              label: it.label,
              kind: lspCompletionKindToMonaco(monaco, it.kind),
              detail: it.detail || '',
              documentation: it.documentation && it.documentation.value ? { value: it.documentation.value } : it.documentation,
              insertText: it.insertText || it.label,
              filterText: it.filterText || it.label,
              sortText: it.sortText || it.label,
              range: range,
            };
          }),
        };
      },
    });
  }

  function lspCompletionKindToMonaco(monaco, kind) {
    // LSP's CompletionItemKind enum roughly lines up with Monaco's; this
    // covers the commonly-used values. Anything unmapped falls back to Text.
    var K = monaco.languages.CompletionItemKind;
    var map = {
      1: K.Text, 2: K.Method, 3: K.Function, 4: K.Constructor, 5: K.Field,
      6: K.Variable, 7: K.Class, 8: K.Interface, 9: K.Module, 10: K.Property,
      11: K.Unit, 12: K.Value, 13: K.Enum, 14: K.Keyword, 15: K.Snippet,
      16: K.Color, 17: K.File, 18: K.Reference, 19: K.Folder, 20: K.EnumMember,
      21: K.Constant, 22: K.Struct, 23: K.Event, 24: K.Operator, 25: K.TypeParameter,
    };
    return map[kind] || K.Text;
  }

  function registerHover(monaco, languageId) {
    monaco.languages.registerHoverProvider(languageId, {
      provideHover: async function (model, position) {
        var session = sessionForModel(model);
        if (!session) return null;
        var resp = await window.klaus.lspRequest(session.serverId, 'textDocument/hover', {
          textDocument: { uri: model.uri.toString() },
          position: monacoPositionToLsp(position),
        });
        if (!resp || resp.error || !resp.result) return null;
        var r = resp.result;
        var contents = [];
        if (r.contents) {
          if (Array.isArray(r.contents)) {
            r.contents.forEach(function (c) {
              contents.push(typeof c === 'string' ? { value: c } : { value: c.value || '' });
            });
          } else if (typeof r.contents === 'string') {
            contents.push({ value: r.contents });
          } else if (r.contents.value) {
            contents.push({ value: r.contents.value });
          }
        }
        return { range: lspRangeToMonaco(r.range), contents: contents };
      },
    });
  }

  function registerDefinition(monaco, languageId) {
    monaco.languages.registerDefinitionProvider(languageId, {
      provideDefinition: async function (model, position) {
        var session = sessionForModel(model);
        if (!session) return null;
        var resp = await window.klaus.lspRequest(session.serverId, 'textDocument/definition', {
          textDocument: { uri: model.uri.toString() },
          position: monacoPositionToLsp(position),
        });
        if (!resp || resp.error || !resp.result) return null;
        var items = Array.isArray(resp.result) ? resp.result : [resp.result];
        return items
          .map(function (loc) {
            // LSP can return either Location or LocationLink; normalize both.
            var uri = loc.uri || loc.targetUri;
            var range = loc.range || loc.targetSelectionRange || loc.targetRange;
            if (!uri || !range) return null;
            return { uri: monaco.Uri.parse(uri), range: lspRangeToMonaco(range) };
          })
          .filter(Boolean);
      },
    });
  }

  // ---- Public surface ----

  window.LspClient = {
    attachModel: attachModel,
    notifyDidSave: notifyDidSave,
    sessionForWorktree: function (languageId, worktreePath) {
      return sessions.get(sessionKey(languageId, worktreePath)) || null;
    },
    unloadWorktree: function (worktreePath) {
      sessions.forEach(function (session, key) {
        if (session && session.worktreePath === worktreePath) {
          teardownSession(session);
        }
      });
    },
  };
})();
