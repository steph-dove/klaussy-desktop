// Voice input: hold a shortcut (or toggle the mic button) to record, then the
// on-device worker transcribes and the text is either typed into the active
// terminal or matched to a command palette entry.

(function () {
  'use strict';

  var RATE = 16000;
  var MIN_SECONDS = 0.3;
  var MAX_SECONDS = 60;

  var enabled = false;
  var button = null;
  var worker = null;
  var loading = null;
  var pending = {};
  var nextId = 0;
  var queue = Promise.resolve();
  var rec = null;

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
    var run = queue.then(startWorker).then(function () {
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

  function setState(state, mode) {
    if (!button) return;
    var recording = state === 'listening';
    button.classList.toggle('recording', recording);
    button.classList.toggle('busy', state === 'transcribing');
    button.setAttribute('aria-pressed', recording ? 'true' : 'false');
    if (state === 'listening') announce(mode === 'command' ? 'Listening for a command' : 'Listening');
    else if (state === 'transcribing') announce('Transcribing');
  }

  function dictate(text) {
    var clean = window.VoiceText.sanitizeDictation(text);
    if (!clean) {
      window.toast.info('Didn’t catch that. Try again a little closer to the mic.');
      return false;
    }
    var target = activeTarget();
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

  function runCommand(text) {
    var match = window.VoiceText.matchCommand(text, window.App.buildPaletteCommands());
    if (!match) {
      var heard = window.VoiceText.sanitizeDictation(text);
      window.toast.info(heard ? 'No command matched “' + heard + '”.' : 'Didn’t catch a command.');
      return false;
    }
    if (match.kind === 'send') {
      var target = activeTarget();
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
  function handleTranscript(text, mode) {
    return mode === 'command' ? runCommand(text) : dictate(text);
  }

  function micError(err) {
    var name = err && err.name;
    if (name === 'NotAllowedError') return 'Microphone access was blocked. Allow Klaussy to use the microphone in your system settings.';
    if (name === 'NotFoundError') return 'No microphone found.';
    return (err && err.message) || String(err);
  }

  function release(session) {
    session.stopped = true;
    if (session.stream) session.stream.getTracks().forEach(function (t) { t.stop(); });
    if (session.ctx) session.ctx.close();
  }

  function start(mode, viaKey) {
    if (!enabled || rec) return;
    var session = rec = { mode: mode, viaKey: viaKey, chunks: [], length: 0, stopped: false };
    setState('listening', mode);
    window.klaus.voice.prepare().then(function (res) {
      if (!res.ok) throw new Error(res.error);
      if (session.stopped) return null;
      return navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    }).then(function (stream) {
      if (!stream) return;
      session.stream = stream;
      if (session.stopped) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        return;
      }
      // Chromium resamples the mic to the context rate, which is what the model expects.
      var ctx = session.ctx = new AudioContext({ sampleRate: RATE });
      var source = ctx.createMediaStreamSource(stream);
      var node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = function (ev) {
        if (session.stopped) return;
        var chunk = new Float32Array(ev.inputBuffer.getChannelData(0));
        session.chunks.push(chunk);
        session.length += chunk.length;
        if (session.length >= RATE * MAX_SECONDS) stop();
      };
      source.connect(node);
      node.connect(ctx.destination);
    }).catch(function (err) {
      if (rec === session) rec = null;
      release(session);
      setState('idle');
      window.toast.error(micError(err));
    });
  }

  function stop() {
    var session = rec;
    if (!session) return;
    rec = null;
    release(session);
    if (session.length < RATE * MIN_SECONDS) {
      setState('idle');
      return;
    }
    var audio = new Float32Array(session.length);
    var offset = 0;
    session.chunks.forEach(function (c) { audio.set(c, offset); offset += c.length; });
    setState('transcribing');
    transcribe(audio).then(function (text) {
      setState('idle');
      try {
        handleTranscript(text, session.mode);
      } catch (err) {
        window.toast.error('Voice command failed: ' + ((err && err.message) || String(err)));
      }
    }, function (err) {
      setState('idle');
      window.toast.error('Voice transcription failed: ' + err.message);
    });
  }

  function shortcutMode(e) {
    if (window.AppUtils.isNamedShortcut(e, 'voiceDictate')) return 'dictate';
    if (window.AppUtils.isNamedShortcut(e, 'voiceCommand')) return 'command';
    return null;
  }

  function setEnabled(on) {
    if (window.App && window.App.isSecondaryWindow) on = false;
    enabled = !!on;
    if (button) button.hidden = !enabled;
    if (enabled) {
      // Warm the model in the background so the first dictation isn't the slow one.
      var warm = function () { if (enabled) startWorker().catch(function () {}); };
      if (window.requestIdleCallback) window.requestIdleCallback(warm);
      else setTimeout(warm, 0);
    } else {
      stop();
      stopWorker('Voice input turned off');
    }
  }

  function init() {
    button = document.getElementById('btn-voice');
    if (button) {
      button.addEventListener('click', function () {
        if (rec) stop();
        else start('dictate', false);
      });
    }
    // Capture phase: Monaco binds Ctrl/Cmd+Shift+Space and stops propagation.
    window.addEventListener('keydown', function (e) {
      if (!enabled) return;
      var mode = shortcutMode(e);
      if (!mode) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) start(mode, true);
    }, true);
    // macOS drops the key's keyup while Cmd is held, so releasing any part of the chord stops.
    window.addEventListener('keyup', function (e) {
      if (!rec || !rec.viaKey) return;
      if (e.code === 'Space' || e.code === 'Semicolon' || e.key === 'Meta' || e.key === 'Control' || e.key === 'Shift') stop();
    }, true);
    window.addEventListener('blur', function () {
      if (rec && rec.viaKey) stop();
    });
  }

  window.Voice = { init: init, setEnabled: setEnabled, start: start, stop: stop, handleTranscript: handleTranscript };
})();
