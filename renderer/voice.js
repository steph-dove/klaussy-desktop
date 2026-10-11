// Hold a voice shortcut to record; the on-device worker transcribes, then the text is typed into the active terminal or matched to a palette command.

(function () {
  'use strict';

  var RATE = 16000;
  var MIN_SECONDS = 0.3;
  var MAX_SECONDS = 60;
  // Keep capturing briefly after release so the last word isn't cut off.
  var TAIL_MS = 150;
  // The loaded model holds 100+ MB in this renderer, so drop it when unused.
  var IDLE_MS = 10 * 60 * 1000;

  var enabled = false;
  var button = null;
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

  // The live terminal input would go to: the active Shell/split sub-tab when
  // one is open, otherwise the task's own terminal.
  function activeTarget() {
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

  // preparing: mic requested but not live yet; listening: audio is being captured.
  function setState(state, mode) {
    if (!button) return;
    button.classList.toggle('recording', state === 'listening');
    button.classList.toggle('busy', state === 'preparing' || state === 'transcribing');
    if (state === 'listening') announce(mode === 'command' ? 'Listening for a command' : 'Listening');
    else if (state === 'transcribing') announce('Transcribing');
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
    // paste() lets xterm add bracketed-paste markers when the agent asked for
    // them, so the text is inserted, not submitted.
    target.terminal.paste(clean + ' ');
    announce('Inserted ' + clean);
    return true;
  }

  function runCommand(text, target) {
    var match = window.VoiceText.matchCommand(text, window.App.buildPaletteCommands());
    if (!match) {
      var heard = window.VoiceText.sanitizeDictation(text);
      window.toast.info(heard ? 'No command matched “' + heard + '”.' : 'Didn’t catch a command.');
      return false;
    }
    if (match.kind === 'send') {
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

  // Entry point after transcription; e2e tests call it directly since CI has no mic.
  // target is the terminal that was active when recording ended.
  function handleTranscript(text, mode, target) {
    if (target === undefined) target = activeTarget();
    return mode === 'command' ? runCommand(text, target) : dictate(text, target);
  }

  function micError(err) {
    var name = err && err.name;
    if (name === 'NotAllowedError') return 'Microphone access was blocked. Allow Klaussy to use the microphone in your system settings.';
    if (name === 'NotFoundError') return 'No microphone found.';
    return (err && err.message) || String(err);
  }

  function release(session) {
    session.closed = true;
    if (session.stream) session.stream.getTracks().forEach(function (t) { t.stop(); });
    if (session.ctx) session.ctx.close();
  }

  function start(mode) {
    if (!enabled || rec) return;
    var session = rec = { mode: mode, chunks: [], length: 0, released: false, closed: false };
    setState('preparing', mode);
    clearTimeout(idleTimer);
    // Load the model while the user is still talking.
    startWorker().catch(function () {});
    window.klaus.voice.prepare().then(function (res) {
      if (!res.ok) throw new Error(res.error);
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
        if (session.length >= RATE * MAX_SECONDS && rec === session) stop();
      };
      source.connect(node);
      node.connect(ctx.destination);
      if (rec === session) setState('listening', mode);
    }).catch(function (err) {
      if (rec === session) rec = null;
      release(session);
      idleUnlessBusy();
      if (!session.cancelled) window.toast.error(micError(err));
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
    setState('idle');
  }

  function shortcutMode(e) {
    if (window.AppUtils.isNamedShortcut(e, 'voiceDictate')) return 'dictate';
    if (window.AppUtils.isNamedShortcut(e, 'voiceCommand')) return 'command';
    return null;
  }

  function renderButton() {
    if (!button) return;
    var dictate = window.AppUtils.appShortcutLabel('voiceDictate');
    var command = window.AppUtils.appShortcutLabel('voiceCommand');
    button.classList.toggle('on', enabled);
    button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    button.title = enabled
      ? 'Voice input is on. Hold ' + dictate + ' to dictate or ' + command + ' for a command. Click to turn it off.'
      : 'Voice input is off. Click to turn it on.';
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

  function init() {
    button = document.getElementById('btn-voice');
    if (button && window.App && window.App.isSecondaryWindow) button.hidden = true;
    if (button) {
      // Saving the pref broadcasts it back here and to an open Preferences window.
      button.addEventListener('click', function () {
        var on = !enabled;
        setEnabled(on);
        announce(on ? 'Voice input on' : 'Voice input off');
        window.klaus.ui.setPreferences({ voiceInput: on }).catch(function (err) {
          setEnabled(!on);
          window.toast.error('Could not save the voice setting: ' + ((err && err.message) || String(err)));
        });
      });
    }
    // Capture phase: Monaco binds Ctrl/Cmd+Shift+Space and stops propagation.
    window.addEventListener('keydown', function (e) {
      if (!enabled) return;
      var mode = shortcutMode(e);
      if (!mode) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) start(mode);
    }, true);
    // macOS drops the key's keyup while Cmd is held, so releasing any part of the chord stops.
    window.addEventListener('keyup', function (e) {
      if (!rec) return;
      if (e.code === 'Space' || e.code === 'Semicolon' || e.key === 'Meta' || e.key === 'Control' || e.key === 'Shift') stop();
    }, true);
    // The first-use macOS mic prompt also blurs the window; say why nothing was recorded.
    window.addEventListener('blur', function () {
      if (!rec) return;
      if (!rec.ctx) rec.interrupted = true;
      stop();
    });
  }

  window.Voice = { init: init, setEnabled: setEnabled, handleTranscript: handleTranscript };
})();
