// Pure text handling for voice input: cleaning a dictated transcript before it
// is pasted into a PTY, and matching a spoken command to a palette entry.

(function (root) {
  'use strict';

  var PASTE_MARKERS = /\x1b\[20[01]~/g;
  var CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;
  var NON_SPEECH = /^[[(](blank_audio|silence|music|inaudible|no speech)[\])]$/i;
  // Ignored on both sides when scoring, so "open the PR panel" is judged on "pr panel".
  var STOPWORDS = {
    a: 1, an: 1, the: 1, my: 1, to: 1, or: 1, and: 1, for: 1, please: 1, me: 1, i: 1, you: 1,
    can: 1, could: 1, would: 1, want: 1, like: 1, open: 1, show: 1, view: 1, see: 1, display: 1,
  };

  // Spoken phrasings that don't share enough words with a palette label to
  // score; each lists labels in preference order, since some are task-only.
  var ALIASES = [
    { re: /^(open |start |show )?(pr|pull request|merge request|mr)( review)?$|^review (pr|pull request|merge request|mr)s?$/,
      labels: ['Review Pull Request / Merge Request…'] },
    { re: /^(view|show|open|see) (changes|diff)$|^(show |open |toggle )?diff( panel)?$/,
      labels: ['Show Changes', 'Toggle Diff Panel'] },
    { re: /^(new|start|create|open) (a )?(new )?(session|task|agent)$/, labels: ['New Task'] },
    { re: /^(run|start|kick off|launch) (the )?(full )?(dev loop|rest of (the )?owl)$/,
      labels: ['Run Full Dev Loop (Rest of the Owl)…'] },
    // Shows a running loop; with none yet, starts one (that asks for the task first).
    { re: /^((open|show|view|see) )?(the )?(full )?(dev loop|rest of (the )?owl)( panel| tab| progress)?$/,
      labels: ['Show Dev Loop Progress', 'Run Full Dev Loop (Rest of the Owl)…'] },
    { re: /^((open|show|view|see) )?(the )?(pr|pull request|merge request|mr) (panel|tab)$/,
      labels: ['Show Pull Request Panel'] },
    { re: /^(open )?(settings|preferences|prefs)$/, labels: ['Preferences'] },
    { re: /^clear( terminal| screen)?$/, labels: ['Clear Terminal'] },
  ];
  // No bare "enter": a one-word mishearing could approve an agent's pending tool call.
  var SEND = /^(send|submit|send it|press enter|hit enter)$/;
  // "focus on the auth fix session", "go to session billing refactor", "open session auth fix".
  var SWITCH = /^(?:(?:switch|go|jump|change|move|focus)(?: over)?(?: on| to)?|(?:open|show)(?= (?:session|tab|task|window) ))(?: the)? (?:(?:session|tab|task|window) )?(.+?)(?: (?:session|tab|task|window))?$/;
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
      .replace(/^(please |can you |could you |would you |let s |lets |i want to |i d like to |go ahead and )+/, '')
      .replace(/ please$/, '')
      .replace(/\b(a|an) /g, '');
  }

  // Spoken short forms count as the words the palette labels spell out.
  var EXPAND = { pr: ['pull', 'request'], prs: ['pull', 'request'], mr: ['merge', 'request'] };

  function tokens(text) {
    var out = [];
    normalize(text).split(' ').forEach(function (w) {
      if (!w || STOPWORDS[w]) return;
      if (EXPAND[w]) out.push.apply(out, EXPAND[w]);
      else out.push(w);
    });
    return out;
  }

  // Half Dice similarity, half how much of what was said appears in the label:
  // "dev loop" covers "Show Dev Loop Progress" fully even though the label is longer.
  function score(spoken, label) {
    if (!spoken.length || !label.length) return 0;
    var setA = new Set(spoken);
    var setB = new Set(label);
    var shared = 0;
    setA.forEach(function (w) { if (setB.has(w)) shared++; });
    var dice = (2 * shared) / (setA.size + setB.size);
    return (dice + shared / setA.size) / 2;
  }

  // Highest-scoring command, or null when nothing clears the threshold or two
  // different labels score too close to call.
  function best(spoken, candidates, labelOf) {
    var words = tokens(spoken);
    var top = null;
    var runnerUp = 0;
    candidates.forEach(function (cmd) {
      var s = score(words, tokens(labelOf(cmd)));
      if (!top || s > top.score) {
        if (top && top.cmd.label !== cmd.label) runnerUp = top.score;
        top = { cmd: cmd, score: s };
      } else if (cmd.label !== top.cmd.label && s > runnerUp) {
        runnerUp = s;
      }
    });
    if (!top || top.score < THRESHOLD || top.score - runnerUp < MIN_LEAD) return null;
    return top.cmd;
  }

  var PR_WORDS = '(?:pr|prs|pull request|merge request|mr)';
  var PR_REQUEST = [
    // "review pr 103", "open pr review for the login fix"
    new RegExp('^(?:open |start |show )?(?:the )?(?:' + PR_WORDS + ' review|review (?:the )?' + PR_WORDS + ')(?: number| no)?(?: (?:for|of|on|called|about|titled|named|with))? (.+)$'),
    // "review the voice pr"
    new RegExp('^(?:open |start )?review (?:the )?(.+?) ' + PR_WORDS + '$'),
  ];

  // The PR named in a spoken review request ("review pr 103"), or null.
  function parsePrRequest(text) {
    var spoken = normalize(text);
    for (var i = 0; i < PR_REQUEST.length; i++) {
      var m = spoken.match(PR_REQUEST[i]);
      if (m) {
        var query = m[1].replace(/^(number|no|the) /, '').trim();
        // "for me" names no PR.
        if (/^\d+$/.test(query) || tokens(query).length) return query;
      }
    }
    return null;
  }

  var UNDO = /^(delete|scratch|undo|remove|erase) (that|it|this|the last (one|bit|part|thing))$/;
  var DISCARD_TAIL = / (delete|scratch|undo|erase) (that|it|this)$/;
  var STOP = /^(stop listening|stop|that s all|thats all|that s it|i m done|im done|done|we re done|never mind|nevermind|goodbye|bye)$/;
  var RESTORE = /^(put (that|it) back|restore (that|it)|bring (that|it) back|type that|undo (the )?delete)$/;

  // Branch-style text for session names: "Fix the login bug" -> "fix-the-login-bug".
  function toBranchName(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  function endsWithDiscard(text) {
    return DISCARD_TAIL.test(normalize(text));
  }

  // What to look up when someone speaks to the open PR picker: "select the keep focus PR" is "keep focus".
  function prQueryFromPicker(text) {
    return normalize(text)
      .replace(/^(select|pick|choose|open|review|go to|show|take|use)( me)? /, '')
      .replace(/^(the|number|no) /, '')
      .replace(/ (pr|pull request|merge request|mr|one)$/, '')
      .trim();
  }

  // Returns { kind: 'send' | 'undo' | 'restore' | 'stop' }, { kind: 'pr', query }, { kind: 'command', command } or null.
  function matchCommand(text, allCommands) {
    var commands = allCommands.filter(function (c) { return !NOT_BY_VOICE.test(c.label); });
    var spoken = normalize(text);
    if (!spoken) return null;
    if (SEND.test(spoken)) return { kind: 'send' };
    if (UNDO.test(spoken)) return { kind: 'undo' };
    if (RESTORE.test(spoken)) return { kind: 'restore' };
    if (STOP.test(spoken)) return { kind: 'stop' };
    var prQuery = parsePrRequest(text);
    if (prQuery) return { kind: 'pr', query: prQuery };

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
      var target = best(sw[1], switches, function (c) { return c.label.slice('Switch to: '.length); });
      if (target) return { kind: 'command', command: target };
    }

    var cmd = best(spoken, commands, function (c) { return c.label; });
    return cmd ? { kind: 'command', command: cmd } : null;
  }

  var api = { sanitizeDictation: sanitizeDictation, normalize: normalize, matchCommand: matchCommand, parsePrRequest: parsePrRequest,
    prQueryFromPicker: prQueryFromPicker, endsWithDiscard: endsWithDiscard, toBranchName: toBranchName };
  if (root) root.VoiceText = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
