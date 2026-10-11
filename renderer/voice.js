// Click the mic button (or hold a voice shortcut) to record; the on-device worker transcribes, then the text runs as a palette command or is typed into the active terminal.

(function () {
  'use strict';

  var RATE = 16000;
  var MIN_SECONDS = 0.3;
  var MAX_SECONDS = 60;
  // Keep capturing briefly after release so the last word isn't cut off.
  var TAIL_MS = 150;
  // Click-to-talk handles each phrase after this much quiet, and keeps listening
  // until the user stops it, says so, or goes quiet for CONVERSATION_IDLE_MS.
  var SILENCE_MS = 1300;
  var NO_SPEECH_MS = 8000;
  var CONVERSATION_IDLE_MS = 20000;
  var PRE_ROLL_SECONDS = 0.5;
  var SPEECH_RMS = 0.015;
  // The loaded model holds 100+ MB in this renderer, so drop it when unused.
  var IDLE_MS = 10 * 60 * 1000;

  var enabled = false;
  var buttons = [];
  var worker = null;
  var loading = null;
  var pending = {};
  var nextId = 0;
  var queue = Promise.resolve();
  var rec = null;
  var inFlight = 0;
  var idleTimer = null;
  // What the last dictation typed and where, so "delete that" can take it back.
  var lastInsert = null;
  // What "delete that" / "scratch that" removed, kept briefly in case the words were meant literally.
  var lastRemoved = null;
  // The last 50 phrases and what each did, in memory only (dictation can hold anything).
  var history = [];
  var lastOutcome = null;
  var micId = '';
  var RESTORE_MS = 10000;

  function outcome(text) {
    lastOutcome = text;
  }

  function forgetInsert() {
    if (lastInsert && lastInsert.watch) lastInsert.watch.dispose();
    lastInsert = null;
  }

  function remember(target, text, spoken) {
    lastRemoved = { at: Date.now(), target: target, text: text, spoken: spoken };
  }

  function announce(msg) {
    if (window.A11y) window.A11y.announce(msg);
  }

  function call(msg, transfer) {
    var id = ++nextId;
    msg.id = id;
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      worker.postMessage(msg, transfer || []);
    });
  }

  function stopWorker(reason) {
    if (!worker) return;
    worker.terminate();
    worker = null;
    loading = null;
    var waiting = pending;
    pending = {};
    Object.keys(waiting).forEach(function (id) { waiting[id].reject(new Error(reason)); });
  }

  function startWorker() {
    if (loading) return loading;
    worker = new Worker('voice-worker.js', { type: 'module' });
    worker.onmessage = function (e) {
      var d = e.data;
      var p = pending[d.id];
      if (!p) return;
      delete pending[d.id];
      if (d.type === 'error') p.reject(new Error(d.error));
      else p.resolve(d);
    };
    worker.onerror = function (e) {
      if (e && e.preventDefault) e.preventDefault();
      stopWorker('Voice engine crashed: ' + ((e && e.message) || 'unknown error'));
    };
    var loadingNow = call({ type: 'load' });
    loading = loadingNow;
    loadingNow.catch(function (err) {
      if (loading === loadingNow) stopWorker(err.message);
    });
    return loadingNow;
  }

  // One transcription at a time: the ONNX session can't run two concurrently.
  function transcribe(audio) {
    var run = queue.then(function () {
      if (!enabled) throw new Error('Voice input turned off');
      return startWorker();
    }).then(function () {
      return call({ type: 'transcribe', audio: audio }, [audio.buffer]);
    }).then(function (d) { return d.text; });
    queue = run.catch(function () {});
    return run;
  }

  function focusedField() {
    var el = document.activeElement;
    if (!el || el.disabled || el.readOnly || el.closest('[inert]')) return null;
    if (el.closest('.xterm, .monaco-editor')) return null;
    if (el.tagName === 'TEXTAREA') return el;
    // setRangeText throws on other input types (email, number).
    if (el.tagName === 'INPUT' && /^(text|search|url|)$/.test(el.type || '')) return el;
    return el.isContentEditable ? el : null;
  }

  function terminalTarget() {
    var state = window.AppState;
    var id = state && state.activeTaskId;
    var entry = id != null && state.tasks.get(id);
    if (!entry) return null;
    if (entry.activeSubId != null) {
      var sub = (entry.subTerminals || []).find(function (s) { return s.subId === entry.activeSubId; });
      if (sub && sub.alive) return { id: id, subId: sub.subId, terminal: sub.terminal, shell: sub.mode === 'shell' };
    }
    return entry.alive ? { id: id, subId: null, terminal: entry.terminal, shell: entry.mode === 'shell' } : null;
  }

  function activeTarget() {
    var field = focusedField();
    return field ? { field: field } : terminalTarget();
  }

  // Red while the mic is live; amber while it is opening or a phrase is being worked out.
  function renderState() {
    var live = !!(rec && rec.live);
    var busy = !!(rec && !rec.live) || inFlight > 0;
    buttons.forEach(function (button) {
      button.classList.toggle('recording', live);
      button.classList.toggle('busy', busy);
      button.setAttribute('aria-pressed', live ? 'true' : 'false');
    });
  }

  function scheduleIdleStop() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      if (!rec && !inFlight) stopWorker('Voice engine idle');
    }, IDLE_MS);
  }

  function dictate(text, target) {
    var clean = window.VoiceText.sanitizeDictation(text);
    // Empty phrases are usually background noise between sentences; say nothing.
    if (!clean) return false;
    if (!target) {
      window.toast.error('Open an agent tab to dictate into.');
      return false;
    }
    if (target.field && !target.field.isConnected) {
      window.toast.info('The text box closed before your words could be typed into it.');
      return false;
    }
    if (target.field) return typeInto(target.field, clean);
    // paste() lets xterm add bracketed-paste markers when the agent asked for
    // them, so the text is inserted, not submitted.
    forgetInsert();
    if (target.shell) clean = window.VoiceText.shellText(clean);
    target.terminal.paste(clean + ' ');
    outcome('typed into the agent');
    // Any keystroke after this means the backspaces would hit something else.
    var watch = target.terminal.onData(forgetInsert);
    lastInsert = { terminal: target, text: clean + ' ', watch: watch };
    announce('Inserted ' + clean);
    return true;
  }

  function undoLastInsert(spoken) {
    var last = lastInsert;
    forgetInsert();
    if (last && last.field && last.field.isConnected
        && last.field.value.slice(last.start, last.start + last.text.length) === last.text) {
      last.field.setRangeText('', last.start, last.start + last.text.length, 'end');
      last.field.dispatchEvent(new Event('input', { bubbles: true }));
      remember({ field: last.field }, last.text, spoken);
      announce('Deleted. Say put that back to restore it.');
      return true;
    }
    if (last && last.terminal) {
      // Backspaces only reach text still on the agent's input line, which is where dictation lands.
      window.klaus.terminal.write(last.terminal.id, '\x7f'.repeat(last.text.length), last.terminal.subId);
      remember(last.terminal, last.text, spoken);
      announce('Deleted. Say put that back to restore it.');
      return true;
    }
    window.toast.info('Nothing to delete.');
    return false;
  }

  // Puts back what was just removed plus the words that removed it, typed literally.
  function restoreRemoved() {
    var last = lastRemoved;
    lastRemoved = null;
    if (!last || Date.now() - last.at > RESTORE_MS) {
      window.toast.info('Nothing to put back.');
      return false;
    }
    var words = (last.text.trim() + ' ' + last.spoken).trim();
    if (last.target && last.target.field) {
      if (!last.target.field.isConnected) {
        window.toast.info('The text box closed, so there is nothing to put back.');
        return false;
      }
      return typeInto(last.target.field, words);
    }
    return dictate(words, last.target);
  }

  function typeInto(el, text) {
    el.focus();
    if (typeof el.setRangeText === 'function') {
      var start = el.selectionStart;
      var before = el.value.slice(0, start);
      // Session-name boxes become branch names, so dictation joins with dashes.
      var branch = el.dataset.voiceFormat === 'branch';
      if (branch) text = window.VoiceText.toBranchName(text);
      var gap = branch ? (before && !/-$/.test(before) ? '-' : '') : (before && !/\s$/.test(before) ? ' ' : '');
      var inserted = gap + text;
      el.setRangeText(inserted, start, el.selectionEnd, 'end');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      forgetInsert();
      lastInsert = { field: el, start: start, text: inserted };
      outcome('typed into a text box');
    } else {
      document.execCommand('insertText', false, text);
      forgetInsert();
    }
    announce('Inserted ' + text);
    return true;
  }

  var PR_ROW = '.pr-picker-item[data-url]';

  // Resolves 'loaded', 'failed' (an error or still loading after 15s) or 'closed'.
  function pickerLoaded(overlay) {
    return new Promise(function (resolve) {
      var waited = 0;
      (function poll() {
        if (!overlay.isConnected) return resolve('closed');
        if (overlay.querySelector('.pr-picker-error')) return resolve('failed');
        if (!overlay.querySelector('.pr-picker-loading')) return resolve('loaded');
        if (waited >= 15000) return resolve('failed');
        waited += 200;
        setTimeout(poll, 200);
      })();
    });
  }

  // Opens the PR the user named, from the picker's loaded list; with several matches it filters the list instead.
  function reviewPr(query) {
    if (!document.querySelector('.pr-picker-overlay')) window.App.showPrPicker();
    var overlay = document.querySelector('.pr-picker-overlay');
    if (!overlay) return false;
    pickerLoaded(overlay).then(function (state) {
      if (state === 'closed') return;
      if (state === 'failed') {
        window.toast.info('Couldn’t load the open pull requests to pick from. Choose one in the picker once it loads.');
        return;
      }
      // The picker's own search does the matching, so voice and typing find the same PRs.
      var search = overlay.querySelector('.pr-picker-search');
      if (!search) return;
      search.value = query;
      search.dispatchEvent(new Event('input', { bubbles: true }));
      var seen = {};
      var hits = Array.prototype.filter.call(overlay.querySelectorAll(PR_ROW), function (r) {
        if (r.style.display === 'none' || seen[r.dataset.url]) return false;
        seen[r.dataset.url] = true;
        return true;
      });
      if (hits.length === 1) {
        var num = hits[0].querySelector('.pr-picker-num');
        announce('Opening pull request ' + (num ? num.textContent : ''));
        hits[0].click();
        return;
      }
      search.focus();
      if (hits.length) window.toast.info(hits.length + ' pull requests match. Say the number of the one you want.');
      else window.toast.info('No open pull request matches that.');
    });
    return true;
  }

  function run(match, target, heard) {
    outcome(match.kind === 'command' ? 'ran ' + match.command.label : match.kind === 'pr' ? 'looked up PR “' + match.query + '”' : match.kind);
    if (match.kind === 'pr') return reviewPr(match.query);
    if (match.kind === 'dismiss') return dismissDialog();
    if (match.kind === 'next') {
      if (target && target.field && focusNext(target.field)) return true;
      announce('No text box to move on from');
      return false;
    }
    // "Done" while filling in a text box means done with that box, not done talking.
    if (match.kind === 'stop' && target && target.field && focusNext(target.field)) return true;
    if (match.kind === 'undo') return undoLastInsert(heard);
    if (match.kind === 'restore') return restoreRemoved();
    if (match.kind === 'stop') return stopListening();
    forgetInsert();
    if (match.kind === 'send') {
      if (target && target.field && pressNearbySend(target.field)) return true;
      if (target && target.field) target = terminalTarget();
      if (!target) {
        window.toast.error('Open an agent tab first.');
        return false;
      }
      window.klaus.terminal.write(target.id, '\r', target.subId);
      announce('Sent');
      return true;
    }
    announce(match.command.label);
    match.command.action();
    return true;
  }

  var CONTROL_SELECTOR = 'button, [role="tab"], [role="button"], [role="menuitem"], a[href]';

  function visibleControls() {
    return Array.prototype.filter.call(document.querySelectorAll(CONTROL_SELECTOR), function (el) {
      if (el.classList.contains('voice-btn') || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      if (el.closest('[inert]') || !el.getClientRects().length) return false;
      var name = controlName(el);
      return name && name.length <= 60;
    });
  }

  function controlName(el) {
    return (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // exactOnly needs the control's whole name said, so it can safely run before palette commands.
  function pressControl(text, exactOnly) {
    var controls = visibleControls();
    var names = controls.map(controlName);
    var i = exactOnly
      ? window.VoiceText.exactControl(text, names)
      : window.VoiceText.pickControl(text, names, window.AppUtils.fuzzyMatch);
    if (i < 0) return false;
    forgetInsert();
    outcome('pressed ' + controlName(controls[i]));
    announce(controlName(controls[i]));
    controls[i].click();
    return true;
  }

  function dialogOpen() {
    return document.body.classList.contains('dialog-open') || !!document.querySelector('.pr-picker-overlay');
  }

  function dismissDialog() {
    if (!dialogOpen()) {
      announce('Nothing to close');
      return false;
    }
    if (pressControl('click cancel') || pressControl('click close')) return true;
    var el = document.activeElement || document.body;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    if (!dialogOpen()) {
      announce('Closed');
      return true;
    }
    window.toast.info('Couldn’t close this dialog by voice. Use its Cancel button or press Esc.');
    return false;
  }

  function focusNext(from) {
    var scope = (from && from.closest('[role="dialog"], .pr-picker-overlay, .modal, #modal-overlay')) || document;
    var items = Array.prototype.filter.call(
      scope.querySelectorAll('input, textarea, select, button, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'),
      function (el) { return !el.disabled && !el.closest('[inert]') && el.getClientRects().length && !el.classList.contains('voice-btn'); });
    var i = items.indexOf(from);
    var next = items[i + 1] || items[0];
    if (!next || next === from) return false;
    next.focus();
    forgetInsert();
    announce('Next');
    return true;
  }

  function pressNearbySend(field) {
    var scope = field.parentElement;
    for (var up = 0; scope && up < 4; up++, scope = scope.parentElement) {
      var btn = Array.prototype.find.call(scope.querySelectorAll('button'), function (b) {
        return /^send\b/i.test(controlName(b)) && !b.disabled && b.getClientRects().length;
      });
      if (btn) {
        btn.click();
        announce('Sent');
        return true;
      }
    }
    return false;
  }

  // With the agents list open, "the completed one" or "the second one" opens that row.
  function pickAgentRow(text) {
    var panel = document.getElementById('agents-panel');
    if (!panel || !panel.getClientRects().length) return false;
    var want = window.VoiceText.listPick(text);
    if (!want) return false;
    var rows = Array.prototype.slice.call(panel.querySelectorAll('.agent-item'));
    var stateOf = function (row) {
      var dot = row.querySelector('.agent-item-status');
      return dot ? (dot.getAttribute('aria-label') || '') : '';
    };
    var row = null;
    if (want.index !== undefined) row = rows[want.index < 0 ? rows.length - 1 : want.index];
    else if (want.state === 'done') {
      row = rows.find(function (r) { return r.classList.contains('unread') && stateOf(r) === 'done'; })
        || rows.find(function (r) { return stateOf(r) === 'done'; });
    } else row = rows.find(function (r) { return stateOf(r) === want.state; });
    if (!row) {
      window.toast.info(rows.length ? 'No agent in the list matches that.' : 'There are no agents in the list yet.');
      return true;
    }
    var open = row.querySelector('button[data-action="open"]');
    outcome('opened agent ' + ((row.querySelector('.agent-item-title') || row).textContent || '').trim());
    (open || row).click();
    return true;
  }

  // What a local model may pick from: palette commands and up to 40 controls in view (the dialog's when one is open).
  function offeredActions() {
    var palette = window.App.buildPaletteCommands().filter(function (c) { return !/^(Kill Task|Restart )/.test(c.label); });
    var inDialog = dialogOpen();
    var controls = visibleControls().filter(function (el) { return inDialog || !el.closest('#sidebar'); }).slice(0, 40);
    var actions = [];
    palette.forEach(function (c) { actions.push({ name: c.label, run: c.action }); });
    controls.forEach(function (el) { actions.push({ name: 'Press "' + controlName(el) + '"', run: function () { el.click(); } }); });
    var seen = {};
    return actions.filter(function (a) { return !seen[a.name] && (seen[a.name] = true); });
  }

  // Last resort when nothing matched: let a local Ollama model pick one of the offered actions.
  function askOllama(heard, fallback) {
    var actions = offeredActions();
    inFlight++;
    renderState();
    window.klaus.voice.interpret(heard, actions.map(function (a) { return a.name; })).then(function (res) {
      inFlight--;
      renderState();
      var pick = res && res.action && actions.find(function (a) { return a.name === res.action; });
      var entry = history.find(function (h) { return h.heard === heard; });
      if (!pick) {
        if (entry) entry.did = res && res.unavailable ? 'nothing matched (no suitable Ollama model)' : 'nothing matched (Ollama found nothing either)';
        return fallback();
      }
      announce(pick.name);
      if (entry) entry.did = 'Ollama chose ' + pick.name;
      pick.run();
    }, function () {
      inFlight--;
      renderState();
      fallback();
    });
    outcome('asked Ollama');
    return true;
  }

  function runCommand(text, target) {
    var heard = window.VoiceText.sanitizeDictation(text);
    var match = heard && window.VoiceText.matchCommand(text, window.App.buildPaletteCommands());
    if (heard && (!match || match.kind === 'command') && pressControl(heard, true)) return true;
    if (!match && heard && pressControl(heard)) return true;
    if (!match && heard) {
      return askOllama(heard, function () { window.toast.info('That didn’t match a command.'); });
    }
    if (!match) {
      window.toast.info('Didn’t catch a command.');
      return false;
    }
    return run(match, target, heard);
  }

  function isPickerBox(target) {
    return !!(target && target.field && target.field.closest('.pr-picker-overlay'));
  }

  // Something that would run as a command or press a control, rather than be typed.
  function isActionable(text) {
    var names = visibleControls().map(controlName);
    return !!window.VoiceText.matchCommand(text, window.App.buildPaletteCommands())
      || window.VoiceText.pickControl(text, names, window.AppUtils.fuzzyMatch) >= 0
      || !!window.VoiceText.listPick(text);
  }

  // Runs "X and then Y" one step at a time, giving each step's UI a moment to appear.
  function runChain(parts) {
    var step = function (i) {
      if (i >= parts.length) return;
      var ok = routeTranscript(parts[i], 'auto', activeTarget());
      if (ok === false && i < parts.length - 1) {
        window.toast.info('A step didn’t work, so the rest of that request was skipped.');
        return;
      }
      setTimeout(function () { step(i + 1); }, 400);
    };
    var first = routeTranscript(parts[0], 'auto', activeTarget());
    if (first === false) return false;
    outcome('chain of ' + parts.length + ' steps: ' + parts.join(' → '));
    setTimeout(function () { step(1); }, 400);
    return true;
  }

  function runAuto(text, target) {
    var heard = window.VoiceText.sanitizeDictation(text);
    var parts = heard ? window.VoiceText.splitChain(heard) : [];
    if (parts.length > 1 && parts.slice(0, -1).every(isActionable)) return runChain(parts);
    if (heard && window.VoiceText.endsWithDiscard(heard)) {
      remember(target || terminalTarget(), '', heard);
      announce('Discarded. Say put that back to type it after all.');
      return false;
    }
    if (heard && pickAgentRow(heard)) return true;
    var match = heard && window.VoiceText.matchCommand(text, window.App.buildPaletteCommands());
    // An on-screen control named exactly what was said beats a similar palette command; with a dialog open, any of its controls do.
    // A deliberately mapped phrase ("review" -> PR picker) still wins outside dialogs.
    var preferControl = !match || (match.kind === 'command' && (!match.alias || dialogOpen()));
    if (heard && preferControl && pressControl(heard, true)) return true;
    if (heard && dialogOpen() && preferControl && pressControl(heard)) return true;
    if (match) return run(match, target, heard);
    // With the PR picker open, anything but a URL names the PR to open.
    if (heard && isPickerBox(target) && !/^(https?:|www\.)|github|gitlab/i.test(heard)) {
      return reviewPr(window.VoiceText.prQueryFromPicker(heard));
    }
    if (heard && pressControl(heard)) return true;
    if (heard && !target) {
      return askOllama(heard, function () {
        window.toast.info('That didn’t match a command, and there’s no agent tab to type it into.');
      });
    }
    // In a dialog with no text box focused there's nothing to type into, so it was meant as an action.
    if (heard && dialogOpen() && !target.field) {
      return askOllama(heard, function () { window.toast.info('That didn’t match anything in this dialog.'); });
    }
    return dictate(text, target);
  }

  // Entry point after transcription; e2e tests call it directly since CI has no mic.
  // target is the terminal that was active when recording ended.
  function handleTranscript(text, mode, target) {
    lastOutcome = null;
    try {
      return routeTranscript(text, mode, target);
    } finally {
      var heard = window.VoiceText.sanitizeDictation(text);
      if (heard) {
        history.unshift({ at: new Date(), heard: heard, did: lastOutcome || 'nothing matched' });
        history.length = Math.min(history.length, 50);
      }
    }
  }

  function routeTranscript(text, mode, target) {
    if (target === undefined) target = activeTarget();
    if (mode === 'command') return runCommand(text, target);
    if (mode === 'auto') return runAuto(text, target);
    var heard = window.VoiceText.sanitizeDictation(text);
    var edit = window.VoiceText.matchCommand(text, []);
    if (edit && edit.kind === 'undo') return undoLastInsert(heard);
    if (edit && edit.kind === 'restore') return restoreRemoved();
    if (window.VoiceText.endsWithDiscard(heard)) {
      remember(target || terminalTarget(), '', heard);
      announce('Discarded. Say put that back to type it after all.');
      return false;
    }
    return dictate(text, target);
  }

  function showMicDenied(message) {
    window.klaus.voice.micHelp().then(function (help) {
      var msg = message || help.message;
      if (help.canOpenSettings) {
        window.toast.action('error', msg, 'Open microphone settings', function () {
          window.klaus.voice.openMicSettings().then(function (r) {
            if (!r.ok) window.toast.error('Could not open microphone settings' + (r.error ? ': ' + r.error : '') + '.');
          });
        });
      } else {
        window.toast.error(msg, { sticky: true });
      }
    }, function () {
      window.toast.error(message || 'Klaussy can’t use the microphone.');
    });
  }

  function reportStartError(err) {
    var name = err && err.name;
    if (err && err.code === 'mic-denied') return showMicDenied(err.message);
    if (name === 'NotAllowedError' || name === 'SecurityError') return showMicDenied(null);
    if (name === 'NotFoundError') return window.toast.error('No microphone found. Connect one and try again.');
    window.toast.error((err && err.message) || String(err));
  }

  function release(session) {
    session.closed = true;
    clearInterval(session.idleCheck);
    if (session.stream) session.stream.getTracks().forEach(function (t) { t.stop(); });
    if (session.ctx) session.ctx.close();
  }

  function rms(chunk) {
    var sum = 0;
    for (var i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
    return Math.sqrt(sum / chunk.length);
  }

  function start(mode, byClick) {
    if (!enabled || rec) return;
    var session = rec = {
      mode: mode, byClick: byClick, chunks: [], length: 0, released: false, closed: false,
      live: false, heardSpeech: false, spokeAtAll: false, quietMs: 0, lastSpeechAt: Date.now(),
    };
    renderState();
    clearTimeout(idleTimer);
    // Load the model while the user is still talking.
    startWorker().catch(function () {});
    window.klaus.voice.prepare().then(function (res) {
      if (!res.ok) {
        var e = new Error(res.error);
        e.code = res.code;
        throw e;
      }
      if (session.interrupted) window.toast.info('Microphone ready. Hold the shortcut again to talk.');
      if (session.released) return null;
      var audio = { channelCount: 1, echoCancellation: true, noiseSuppression: true };
      if (!micId) return navigator.mediaDevices.getUserMedia({ audio: audio });
      return navigator.mediaDevices.getUserMedia({ audio: Object.assign({ deviceId: { exact: micId } }, audio) }).catch(function (err) {
        if (!err || !/Overconstrained|NotFound|NotReadable/.test(err.name)) throw err;
        window.toast.info('The chosen microphone isn’t available, so Klaussy is using the default.');
        return navigator.mediaDevices.getUserMedia({ audio: audio });
      });
    }).then(function (stream) {
      if (!stream) return;
      session.stream = stream;
      if (session.released) {
        release(session);
        return;
      }
      // Chromium resamples the mic to the context rate, which is what the model expects.
      var ctx = session.ctx = new AudioContext({ sampleRate: RATE });
      var source = ctx.createMediaStreamSource(stream);
      var node = ctx.createScriptProcessor(1024, 1, 1);
      node.onaudioprocess = function (ev) {
        if (session.closed) return;
        var chunk = new Float32Array(ev.inputBuffer.getChannelData(0));
        session.chunks.push(chunk);
        session.length += chunk.length;
        if (rec !== session) return;
        if (!session.byClick) {
          if (session.length >= RATE * MAX_SECONDS) stop();
          return;
        }
        if (rms(chunk) >= SPEECH_RMS) {
          session.heardSpeech = true;
          session.spokeAtAll = true;
          session.quietMs = 0;
          session.lastSpeechAt = Date.now();
        } else if (session.heardSpeech) {
          session.quietMs += (chunk.length / RATE) * 1000;
          if (session.quietMs >= SILENCE_MS) handlePhrase(session);
        } else {
          // Before anyone speaks, keep only a short lead-in so long silences aren't transcribed.
          while (session.length > RATE * PRE_ROLL_SECONDS && session.chunks.length > 1) {
            session.length -= session.chunks.shift().length;
          }
        }
        if (session.length >= RATE * MAX_SECONDS) handlePhrase(session);
      };
      source.connect(node);
      node.connect(ctx.destination);
      if (session.byClick) {
        session.idleCheck = setInterval(function () {
          if (rec !== session || session.heardSpeech) return;
          var quiet = Date.now() - session.lastSpeechAt;
          if (!session.spokeAtAll && quiet >= NO_SPEECH_MS) {
            cancel();
            window.toast.info('Didn’t hear anything. Click the mic and try again.');
          } else if (session.spokeAtAll && quiet >= CONVERSATION_IDLE_MS) {
            cancel();
            announce('Stopped listening');
          }
        }, 1000);
      }
      if (rec === session) {
        session.live = true;
        renderState();
        announce('Listening');
      }
    }).catch(function (err) {
      if (rec === session) rec = null;
      release(session);
      renderState();
      if (!session.cancelled) reportStartError(err);
    });
  }

  function takeAudio(session) {
    var audio = new Float32Array(session.length);
    var offset = 0;
    session.chunks.forEach(function (c) { audio.set(c, offset); offset += c.length; });
    session.chunks = [];
    session.length = 0;
    session.heardSpeech = false;
    session.quietMs = 0;
    return audio;
  }

  function transcribeAndHandle(audio, mode, target) {
    if (audio.length < RATE * MIN_SECONDS) return;
    inFlight++;
    renderState();
    transcribe(audio).then(function (text) {
      inFlight--;
      renderState();
      scheduleIdleStop();
      if (!enabled) return;
      try {
        handleTranscript(text, mode, target);
      } catch (err) {
        window.toast.error('Voice command failed: ' + ((err && err.message) || String(err)));
      }
    }, function (err) {
      inFlight--;
      renderState();
      if (enabled) window.toast.error('Voice transcription failed: ' + err.message);
    });
  }

  // A pause in click-to-talk: handle the phrase and keep listening.
  function handlePhrase(session) {
    transcribeAndHandle(takeAudio(session), session.mode, activeTarget());
  }

  function finish(session) {
    release(session);
    renderState();
    scheduleIdleStop();
    transcribeAndHandle(takeAudio(session), session.mode, session.target);
  }

  function stopListening() {
    if (rec && rec.byClick) cancel();
    announce('Stopped listening');
    return true;
  }

  function stop() {
    var session = rec;
    if (!session) return;
    rec = null;
    session.released = true;
    session.target = activeTarget();
    if (!session.ctx) {
      release(session);
      renderState();
      return;
    }
    setTimeout(function () { finish(session); }, TAIL_MS);
  }

  function cancel() {
    var session = rec;
    if (!session) return;
    rec = null;
    session.released = true;
    session.cancelled = true;
    release(session);
    renderState();
  }

  var EXAMPLES = [
    ['open pr review', 'pick a pull request to review'],
    ['review pr 103', 'open that pull request'],
    ['run review', 'AI review in PR review, or review this session'],
    ['new session', 'start a session'],
    ['select agent gemini', 'press a button or tab by its name'],
    ['open the dev loop', 'show or start the dev loop'],
    ['open agent list', 'running and finished agents'],
    ['switch to auth fix', 'focus a session by name'],
    ['delete that / put that back', 'undo the last dictation, or restore it'],
    ['next / done naming', 'leave the text box'],
    ['close / cancel', 'close the dialog'],
    ['send', 'press Enter in the agent'],
    ['stop listening', 'end click-to-talk'],
  ];

  function showHelp() {
    var items = EXAMPLES.map(function (e) {
      return { label: '“' + e[0] + '” — ' + e[1], action: function () { if (!/\//.test(e[0])) handleTranscript(e[0], 'auto'); } };
    });
    window.App.buildPaletteCommands().forEach(function (c) {
      items.push({ label: '“' + c.label.replace(/…$/, '') + '”', action: c.action });
    });
    items.push({ label: 'Or say the name of any button or tab on screen', action: function () {} });
    window.CommandPalette.show(items);
  }

  function showHistory() {
    if (!history.length) {
      window.toast.info('Nothing said yet.');
      return;
    }
    window.CommandPalette.show(history.map(function (h) {
      var line = h.at.toLocaleTimeString() + '  “' + h.heard + '” → ' + h.did;
      return { label: line, action: function () {
        navigator.clipboard.writeText(line).then(function () { announce('Copied'); }, function (err) {
          window.toast.error('Copy failed: ' + ((err && err.message) || String(err)));
        });
      } };
    }));
  }

  function chooseMic() {
    navigator.mediaDevices.enumerateDevices().then(function (devices) {
      var mics = devices.filter(function (d) { return d.kind === 'audioinput' && d.deviceId !== 'default'; });
      if (!mics.length || !mics.some(function (d) { return d.label; })) {
        window.toast.info('Use voice once so Klaussy can list your microphones, then try again.');
        return;
      }
      var save = function (id, name) {
        setMicId(id);
        announce('Using ' + name);
        window.klaus.ui.setPreferences({ voiceMicId: id }).catch(function (err) {
          window.toast.error('Could not save the microphone choice: ' + ((err && err.message) || String(err)));
        });
      };
      var items = [{ label: (micId ? '' : '✓ ') + 'System default', action: function () { save('', 'the system default microphone'); } }];
      mics.forEach(function (d, i) {
        var name = d.label || 'Microphone ' + (i + 1);
        items.push({ label: (d.deviceId === micId ? '✓ ' : '') + name, action: function () { save(d.deviceId, name); } });
      });
      window.CommandPalette.show(items);
    }, function (err) {
      window.toast.error('Could not list microphones: ' + ((err && err.message) || String(err)));
    });
  }

  function setMicId(id) {
    micId = id || '';
  }

  function shortcutMode(e) {
    if (window.AppUtils.isNamedShortcut(e, 'voiceDictate')) return 'dictate';
    if (window.AppUtils.isNamedShortcut(e, 'voiceCommand')) return 'command';
    return null;
  }

  function renderButton() {
    var title = enabled
      ? 'Click and say a command ("open pr review", "open the dev loop") or what to type into the agent. Or hold '
        + window.AppUtils.appShortcutLabel('voiceDictate') + ' to dictate, '
        + window.AppUtils.appShortcutLabel('voiceCommand') + ' for a command.'
      : 'Voice input is off. Click to turn it on and talk.';
    buttons.forEach(function (button) {
      button.classList.toggle('on', enabled);
      button.setAttribute('aria-label', enabled ? 'Voice input: click to talk' : 'Voice input is off: click to turn it on and talk');
      button.title = title;
    });
  }

  function setEnabled(on) {
    if (window.App && window.App.isSecondaryWindow) on = false;
    enabled = !!on;
    renderButton();
    window.AppUtils.setShortcutActive('voiceDictate', enabled);
    window.AppUtils.setShortcutActive('voiceCommand', enabled);
    if (!enabled) {
      cancel();
      clearTimeout(idleTimer);
      stopWorker('Voice input turned off');
    }
  }

  function onButtonClick() {
    if (rec) {
      if (rec.byClick) stop();
      return;
    }
    if (enabled) return start('auto', true);
    // Main checks the saved pref before opening the mic, so listen only once it's saved.
    setEnabled(true);
    window.klaus.ui.setPreferences({ voiceInput: true }).then(function () {
      start('auto', true);
    }, function (err) {
      setEnabled(false);
      window.toast.error('Could not save the voice setting: ' + ((err && err.message) || String(err)));
    });
  }

  function init() {
    buttons = [document.getElementById('btn-voice'), document.getElementById('voice-float')].filter(Boolean);
    buttons.forEach(function (button) {
      if (window.App && window.App.isSecondaryWindow) button.hidden = true;
      // Keep focus in the text box being dictated into rather than moving it to the button.
      button.addEventListener('mousedown', function (e) { e.preventDefault(); });
      button.addEventListener('click', onButtonClick);
    });
    // Capture phase: Monaco binds Ctrl/Cmd+Shift+Space and stops propagation.
    window.addEventListener('keydown', function (e) {
      if (!enabled) return;
      var mode = shortcutMode(e);
      if (!mode) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) start(mode, false);
    }, true);
    // macOS drops the key's keyup while Cmd is held, so releasing any part of the chord stops.
    window.addEventListener('keyup', function (e) {
      if (!rec || rec.byClick) return;
      if (e.code === 'Space' || e.code === 'Semicolon' || e.key === 'Meta' || e.key === 'Control' || e.key === 'Shift') stop();
    }, true);
    // The first-use macOS mic prompt also blurs the window; say why nothing was recorded.
    window.addEventListener('blur', function () {
      if (!rec || rec.byClick) return;
      if (!rec.ctx) rec.interrupted = true;
      stop();
    });
  }

  window.Voice = {
    init: init, setEnabled: setEnabled, setMicId: setMicId, handleTranscript: handleTranscript,
    isEnabled: function () { return enabled; }, showHelp: showHelp, showHistory: showHistory, chooseMic: chooseMic,
  };
})();
