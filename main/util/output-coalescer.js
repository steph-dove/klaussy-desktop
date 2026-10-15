// Merges PTY chunks read in the same event-loop turn into one IPC message; a timer here delayed every keystroke echo.

function createOutputCoalescer({
  send,
  maxBytes = 64 * 1024,
  schedule = (fn) => setImmediate(fn),
  cancel = (handle) => clearImmediate(handle),
} = {}) {
  const pending = new Map(); // channel -> { parts: string[], size: number }
  let handle = null;

  function stopSchedule() {
    if (handle) { cancel(handle); handle = null; }
  }

  function flush(channel) {
    const entry = pending.get(channel);
    if (!entry) return;
    pending.delete(channel);
    if (pending.size === 0) stopSchedule();
    send(channel, entry.parts.length === 1 ? entry.parts[0] : entry.parts.join(''));
  }

  function flushAll() {
    stopSchedule();
    for (const channel of Array.from(pending.keys())) {
      // One bad subscriber must not strand every other terminal's output.
      try { flush(channel); } catch (err) { console.error('[output-coalescer]', channel, err); }
    }
  }

  function push(channel, data) {
    if (!data) return;
    let entry = pending.get(channel);
    if (!entry) { entry = { parts: [], size: 0 }; pending.set(channel, entry); }
    entry.parts.push(data);
    entry.size += data.length;
    if (entry.size >= maxBytes) { flush(channel); return; }
    if (!handle) handle = schedule(flushAll);
  }

  return { push, flush };
}

module.exports = { createOutputCoalescer };
