// Tiny renderer-side event bus. Decouples modules that need to react to
// cross-cutting state changes (task switch, worktree change, pr load) from
// whoever triggers them — before this, terminal-manager called DiffPanel,
// PRPanel, BranchlessUI, and file-browser directly, which meant every new
// listener required editing the producer.
//
// Usage:
//   var off = Events.on('task:switched', function (detail) { ... });
//   Events.emit('task:switched', { task: t });
//   off();
//
// Known events (keep this list in sync with emit/on call sites):
//   task:switched — detail = { task }  (task may be null if cleared)

window.Events = (function () {
  var target = new EventTarget();
  return {
    on: function (name, cb) {
      var handler = function (e) { cb(e.detail); };
      target.addEventListener(name, handler);
      return function () { target.removeEventListener(name, handler); };
    },
    emit: function (name, payload) {
      target.dispatchEvent(new CustomEvent(name, { detail: payload }));
    },
  };
})();
