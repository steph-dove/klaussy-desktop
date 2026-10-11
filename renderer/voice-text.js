// Pure text handling for voice input: cleaning a dictated transcript before it
// is pasted into a PTY, and matching a spoken command to a palette entry.

(function (root) {
  'use strict';

  var PASTE_MARKERS = /\x1b\[20[01]~/g;
  var CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;
  var NON_SPEECH = /^[[(](blank_audio|silence|music|inaudible|no speech)[\])]$/i;
  var STOPWORDS = { a: 1, an: 1, the: 1, my: 1, to: 1, or: 1, and: 1, please: 1 };

  // Spoken phrasings that don't share enough words with a palette label to
  // score; each lists labels in preference order, since some are task-only.
  var ALIASES = [
    { re: /^(open |start |show )?(pr|pull request|merge request|mr)( review)?$|^review (pr|pull request|merge request|mr)s?$/,
      labels: ['Review Pull Request / Merge Request…'] },
    { re: /^(view|show|open|see) (changes|diff)$|^(show |open |toggle )?diff( panel)?$/,
      labels: ['Show Changes', 'Toggle Diff Panel'] },
    { re: /^(new|start|create|open) (new )?(session|task|agent)$/, labels: ['New Task'] },
    { re: /^(open )?(settings|preferences|prefs)$/, labels: ['Preferences'] },
    { re: /^clear( terminal| screen)?$/, labels: ['Clear Terminal'] },
  ];
  // No bare "enter": a one-word mishearing could approve an agent's pending tool call.
  var SEND = /^(send|submit|send it|press enter|hit enter)$/;
  var SWITCH = /^(switch|go|jump|change) (to )?(task |tab |session )?(.+)$/;
  // A misheard word must never end an agent session, so these stay keyboard-only.
  var NOT_BY_VOICE = /^(Kill Task|Restart )/;
  var THRESHOLD = 0.6;
  var MIN_LEAD = 0.05;

  function sanitizeDictation(text) {
    var clean = String(text || '')
      .replace(PASTE_MARKERS, '')
      .replace(CONTROL_CHARS, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return NON_SPEECH.test(clean) ? '' : clean;
  }

  function normalize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\bp r\b/g, 'pr')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^(hey |ok |okay )?klaussy /, '')
      .replace(/^please /, '')
      .replace(/ please$/, '');
  }

  function tokens(text) {
    return normalize(text).split(' ').filter(function (w) { return w && !STOPWORDS[w]; });
  }

  function dice(a, b) {
    if (!a.length || !b.length) return 0;
    var setA = new Set(a);
    var setB = new Set(b);
    var shared = 0;
    setA.forEach(function (w) { if (setB.has(w)) shared++; });
    return (2 * shared) / (setA.size + setB.size);
  }

  // Highest-scoring command, or null when nothing clears the threshold or two
  // different labels score too close to call.
  function best(spoken, candidates, labelOf) {
    var words = tokens(spoken);
    var top = null;
    var runnerUp = 0;
    candidates.forEach(function (cmd) {
      var score = dice(words, tokens(labelOf(cmd)));
      if (!top || score > top.score) {
        if (top && top.cmd.label !== cmd.label) runnerUp = top.score;
        top = { cmd: cmd, score: score };
      } else if (cmd.label !== top.cmd.label && score > runnerUp) {
        runnerUp = score;
      }
    });
    if (!top || top.score < THRESHOLD || top.score - runnerUp < MIN_LEAD) return null;
    return top.cmd;
  }

  // Returns { kind: 'send' }, { kind: 'command', command } or null.
  function matchCommand(text, allCommands) {
    var commands = allCommands.filter(function (c) { return !NOT_BY_VOICE.test(c.label); });
    var spoken = normalize(text);
    if (!spoken) return null;
    if (SEND.test(spoken)) return { kind: 'send' };

    for (var i = 0; i < ALIASES.length; i++) {
      if (!ALIASES[i].re.test(spoken)) continue;
      for (var j = 0; j < ALIASES[i].labels.length; j++) {
        var label = ALIASES[i].labels[j];
        var hit = commands.find(function (c) { return c.label === label; });
        if (hit) return { kind: 'command', command: hit };
      }
    }

    var sw = spoken.match(SWITCH);
    if (sw) {
      var switches = commands.filter(function (c) { return c.label.indexOf('Switch to: ') === 0; });
      var target = best(sw[4], switches, function (c) { return c.label.slice('Switch to: '.length); });
      if (target) return { kind: 'command', command: target };
    }

    var cmd = best(spoken, commands, function (c) { return c.label; });
    return cmd ? { kind: 'command', command: cmd } : null;
  }

  var api = { sanitizeDictation: sanitizeDictation, normalize: normalize, matchCommand: matchCommand };
  if (root) root.VoiceText = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
