// Batches PTY output per channel into one IPC message per tick, since the renderer's input handling shares that thread.

function createOutputCoalescer({
  send,
  flushMs = 4,
  maxBytes = 64 * 1024,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
} = {}) {
  const pending = new Map(); // channel -> { parts: string[], size: number }
  let timer = null;

  function stopTimer() {
    if (timer) { clearTimer(timer); timer = null; }
  }

  function flush(channel) {
    const entry = pending.get(channel);
    if (!entry) return;
    pending.delete(channel);
    if (pending.size === 0) stopTimer();
    send(channel, entry.parts.length === 1 ? entry.parts[0] : entry.parts.join(''));
  }

  function flushAll() {
    stopTimer();
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
    if (!timer) timer = setTimer(flushAll, flushMs);
  }

  return { push, flush };
}

module.exports = { createOutputCoalescer };
