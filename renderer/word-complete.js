// Static word-based inline completion. When the user is typing a
// partial word, this provider scans the current buffer for words that
// start with that prefix and shows the most frequent completion as
// ghost text. Tab accepts (Monaco default for inline completions).
//
// Always on, free, no network. Kicks in naturally alongside LSP
// suggestions — LSP dropdown for semantic matches; this for "that word
// I just typed three lines ago."

window.WordComplete = (function () {
  var registered = false;

  // Ignore completions for very short prefixes (too noisy) or when the
  // match is identical to the prefix.
  var MIN_PREFIX_LEN = 2;
  // Cap scanning cost. Large files: look at ~5k lines around the cursor.
  var SCAN_RADIUS = 2500;

  function register(monaco) {
    if (registered) return;
    registered = true;
    monaco.languages.registerInlineCompletionsProvider({ pattern: '**' }, {
      provideInlineCompletions: function (model, position) {
        var word = model.getWordUntilPosition(position);
        if (!word || !word.word || word.word.length < MIN_PREFIX_LEN) return { items: [] };
        var prefix = word.word;

        // Only suggest when the cursor is actually at the end of the
        // partial word — suggesting mid-identifier feels wrong.
        if (word.endColumn !== position.column) return { items: [] };

        var best = findBestMatch(model, prefix, position);
        if (!best) return { items: [] };
        var remaining = best.slice(prefix.length);
        if (!remaining) return { items: [] };

        return {
          items: [{
            insertText: remaining,
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

  // Scan a window of lines around the cursor, count matches for the given
  // prefix, return the most-frequent match. Proximity to cursor breaks
  // frequency ties — tokens used nearby rank higher than rare ones far away.
  function findBestMatch(model, prefix, position) {
    var lineCount = model.getLineCount();
    var startLine = Math.max(1, position.lineNumber - SCAN_RADIUS);
    var endLine = Math.min(lineCount, position.lineNumber + SCAN_RADIUS);
    var wordRe = /[A-Za-z_$][A-Za-z0-9_$]*/g;
    var counts = Object.create(null);
    var nearest = Object.create(null);
    for (var ln = startLine; ln <= endLine; ln++) {
      var text = model.getLineContent(ln);
      wordRe.lastIndex = 0;
      var m;
      while ((m = wordRe.exec(text))) {
        var w = m[0];
        if (w.length <= prefix.length) continue;
        if (!prefixMatches(w, prefix)) continue;
        if (w === prefix) continue;
        counts[w] = (counts[w] || 0) + 1;
        var dist = Math.abs(ln - position.lineNumber);
        if (nearest[w] === undefined || dist < nearest[w]) nearest[w] = dist;
      }
    }
    var best = null;
    var bestScore = -1;
    for (var w in counts) {
      // Score = frequency minus a small penalty for distance, so a token
      // used 3 times nearby beats one used 3 times across the file.
      var score = counts[w] - nearest[w] * 0.01;
      if (score > bestScore) { best = w; bestScore = score; }
    }
    return best;
  }

  // Case-sensitive prefix check. Case matches how users actually type —
  // `MyClass` shouldn't complete to `myclass`.
  function prefixMatches(word, prefix) {
    if (word.length < prefix.length) return false;
    for (var i = 0; i < prefix.length; i++) {
      if (word.charCodeAt(i) !== prefix.charCodeAt(i)) return false;
    }
    return true;
  }

  // Wait for Monaco, then register.
  if (window.MonacoReady) {
    window.MonacoReady.then(register);
  }

  return { register: register };
})();
