// Click the mic button (or hold a voice shortcut) to record; the on-device worker transcribes, then the text runs as a palette command or is typed into the active terminal.

(function () {
  'use strict';

  var RATE = 16000;
  var MIN_SECONDS = 0.3;
  var MAX_SECONDS = 60;
  // Keep capturing briefly after release so the last word isn't cut off.
  var TAIL_MS = 150;
  // Click-to-talk stops by itself after this much quiet following speech.
  var SILENCE_MS = 1300;
  var NO_SPEECH_MS = 8000;
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
      if (sub && sub.alive) return { id: id, subId: sub.subId, terminal: sub.terminal };
    }
    return entry.alive ? { id: id, subId: null, terminal: entry.terminal } : null;
  }

  function activeTarget() {
    var field = focusedField();
    return field ? { field: field } : terminalTarget();
  }

  // preparing: mic requested but not live yet; listening: audio is being captured; transcribing: working out what was said.
  function setState(state) {
    buttons.forEach(function (button) {
      button.classList.toggle('recording', state === 'listening');
      button.classList.toggle('busy', state === 'preparing' || state === 'transcribing');
      button.setAttribute('aria-pressed', state === 'listening' ? 'true' : 'false');
    });
    if (state === 'listening') announce('Listening');
    else if (state === 'transcribing') announce('Processing');
  }

  // A newer recording or a queued transcription may still own the button.
  function idleUnlessBusy() {
    if (!rec) setState(inFlight ? 'transcribing' : 'idle');
  }

  function scheduleIdleStop() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      if (!rec && !inFlight) stopWorker('Voice engine idle');
    }, IDLE_MS);
  }

  function dictate(text, target) {
    var clean = window.VoiceText.sanitizeDictation(text);
    if (!clean) {
      window.toast.info('Didn’t catch that. Try again a little closer to the mic.');
      return false;
    }
    if (!target) {
      window.toast.error('Open an agent tab to dictate into.');
      return false;
    }
    if (target.field && !target.field.isConnected) {
      window.toast.info('The text box closed before “' + clean + '” could be typed into it.');
      return false;
    }
    if (target.field) return typeInto(target.field, clean);
    // paste() lets xterm add bracketed-paste markers when the agent asked for
    // them, so the text is inserted, not submitted.
    target.terminal.paste(clean + ' ');
    announce('Inserted ' + clean);
    return true;
  }

  function typeInto(el, text) {
    el.focus();
    if (typeof el.setRangeText === 'function') {
      var start = el.selectionStart;
      var before = el.value.slice(0, start);
      el.setRangeText((before && !/\s$/.test(before) ? ' ' : '') + text, start, el.selectionEnd, 'end');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      document.execCommand('insertText', false, text);
    }
    announce('Inserted ' + text);
    return true;
  }

  function run(match, heard, target) {
    if (match.kind === 'send') {
      if (target && target.field) target = terminalTarget();
      if (!target) {
        window.toast.error('Open an agent tab first.');
        return false;
      }
      window.klaus.terminal.write(target.id, '\r', target.subId);
      window.toast.info('Heard “' + heard + '” → Enter');
      return true;
    }
    window.toast.info('Heard “' + heard + '” → ' + match.command.label);
    match.command.action();
    return true;
  }

  function runCommand(text, target) {
    var heard = window.VoiceText.sanitizeDictation(text);
    var match = window.VoiceText.matchCommand(text, window.App.buildPaletteCommands());
    if (!match) {
      window.toast.info(heard ? 'No command matched “' + heard + '”.' : 'Didn’t catch a command.');
      return false;
    }
    return run(match, heard, target);
  }

  function runAuto(text, target) {
    var heard = window.VoiceText.sanitizeDictation(text);
    var match = heard && window.VoiceText.matchCommand(text, window.App.buildPaletteCommands());
    if (match) return run(match, heard, target);
    if (heard && !target) {
      window.toast.info('No command matched “' + heard + '”, and there’s no agent tab to type it into.');
      return false;
    }
    return dictate(text, target);
  }

  // Entry point after transcription; e2e tests call it directly since CI has no mic.
  // target is the terminal that was active when recording ended.
  function handleTranscript(text, mode, target) {
    if (target === undefined) target = activeTarget();
    if (mode === 'command') return runCommand(text, target);
    if (mode === 'auto') return runAuto(text, target);
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
    clearTimeout(session.noSpeechTimer);
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
    var session = rec = { mode: mode, byClick: byClick, chunks: [], length: 0, released: false, closed: false, heardSpeech: false, quietMs: 0 };
    setState('preparing');
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
      return navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
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
        if (session.length >= RATE * MAX_SECONDS) return stop();
        if (!session.byClick) return;
        if (rms(chunk) >= SPEECH_RMS) {
          session.heardSpeech = true;
          session.quietMs = 0;
        } else if (session.heardSpeech) {
          session.quietMs += (chunk.length / RATE) * 1000;
          if (session.quietMs >= SILENCE_MS) stop();
        }
      };
      source.connect(node);
      node.connect(ctx.destination);
      if (session.byClick) {
        session.noSpeechTimer = setTimeout(function () {
          if (rec === session && !session.heardSpeech) {
            cancel();
            window.toast.info('Didn’t hear anything. Click the mic and try again.');
          }
        }, NO_SPEECH_MS);
      }
      if (rec === session) setState('listening');
    }).catch(function (err) {
      if (rec === session) rec = null;
      release(session);
      idleUnlessBusy();
      if (!session.cancelled) reportStartError(err);
    });
  }

  function finish(session) {
    release(session);
    if (session.length < RATE * MIN_SECONDS) {
      idleUnlessBusy();
      scheduleIdleStop();
      return;
    }
    var audio = new Float32Array(session.length);
    var offset = 0;
    session.chunks.forEach(function (c) { audio.set(c, offset); offset += c.length; });
    inFlight++;
    idleUnlessBusy();
    transcribe(audio).then(function (text) {
      inFlight--;
      idleUnlessBusy();
      scheduleIdleStop();
      if (!enabled) return;
      try {
        handleTranscript(text, session.mode, session.target);
      } catch (err) {
        window.toast.error('Voice command failed: ' + ((err && err.message) || String(err)));
      }
    }, function (err) {
      inFlight--;
      idleUnlessBusy();
      if (enabled) window.toast.error('Voice transcription failed: ' + err.message);
    });
  }

  function stop() {
    var session = rec;
    if (!session) return;
    rec = null;
    session.released = true;
    session.target = activeTarget();
    if (!session.ctx) {
      release(session);
      idleUnlessBusy();
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
    idleUnlessBusy();
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

  window.Voice = { init: init, setEnabled: setEnabled, handleTranscript: handleTranscript };
})();
