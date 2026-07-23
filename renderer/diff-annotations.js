// Aggregation + prompt-formatting helpers for inline diff annotations.
// Deliberately free of DOM/Electron access so it can be unit-tested from Node
// by stubbing `window`, the same pattern finding-parser.js uses.
(function () {

  // Re-commenting the same file+side+line edits in place rather than stacking.
  function keyFor(a) {
    return a.filePath + '::' + a.side + '::' + a.line;
  }

  // Returns a new array (callers reassign) so state is never mutated in place.
  function upsert(list, annotation) {
    var key = keyFor(annotation);
    var next = list.filter(function (a) { return keyFor(a) !== key; });
    next.push(annotation);
    return next;
  }

  function removeById(list, id) {
    return list.filter(function (a) { return a.id !== id; });
  }

  // Groups by file in insertion order so the agent reads one tidy block
  // instead of one message per line.
  function formatPrompt(list) {
    if (!list || list.length === 0) return '';
    var groups = [];
    var indexByFile = {};
    list.forEach(function (a) {
      if (!(a.filePath in indexByFile)) {
        indexByFile[a.filePath] = groups.length;
        groups.push({ file: a.filePath, items: [] });
      }
      groups[indexByFile[a.filePath]].items.push(a);
    });

    var out = ['Review feedback on the current diff:', ''];
    groups.forEach(function (group) {
      out.push(group.file + ':');
      group.items.forEach(function (a) {
        var loc = (a.line != null && a.line !== '') ? 'line ' + a.line : 'general';
        out.push('  - ' + loc + ': ' + String(a.text).trim());
      });
      out.push('');
    });
    out.push('Please address this feedback.');
    return out.join('\n');
  }

  window.DiffAnnotations = {
    keyFor: keyFor,
    upsert: upsert,
    removeById: removeById,
    formatPrompt: formatPrompt,
  };

})();
