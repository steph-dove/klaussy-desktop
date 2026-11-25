// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Asks the person, somewhere the page can't answer, before a setting changes what
// the app runs or where it sends data: an agent's binary path, an MCP server's
// command, kimi's autonomous bash, a notification webhook or bot, who may reply
// through it, a Nemesis gateway. A script injected into the page can call
// set-preferences like the Preferences window does, so the check can't live in
// the page.
//
// One function, confirm(), with a swappable way of asking:
//   - the desktop app: a native dialog, which belongs to the OS, not the page;
//   - browser mode: web/helper.js swaps in a y/N prompt in the terminal running
//     `npm run web`, because there `dialog` is answered by the page itself.
// When the helper someday runs without a terminal, it swaps in a native dialog
// of its own and nothing else changes.
//
// Asks one at a time; anything undecided after ASK_TIMEOUT_MS counts as no.

const ASK_TIMEOUT_MS = 2 * 60 * 1000;

// ask({ title, lines }) -> Promise<boolean>
let asker = nativeDialogAsker;
let queue = Promise.resolve();

function nativeDialogAsker({ title, lines }) {
  const { dialog, BrowserWindow } = require('electron');
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const opts = {
    type: 'warning',
    buttons: ['Allow', 'Don’t allow'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: 'Maussian',
    message: title,
    detail: lines.join('\n') + '\n\nIf you didn’t just change this in Preferences, choose Don’t allow.',
  };
  const p = win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
  return p.then((r) => r.response === 0);
}

function setAsker(fn) {
  asker = typeof fn === 'function' ? fn : nativeDialogAsker;
}

// An asker's promise may carry cancel(), which a timeout calls so nothing it set
// up (the terminal's stdin listener) outlives the question.
function withTimeout(p, ms) {
  let timer;
  return Promise.race([
    p,
    new Promise((resolve) => {
      timer = setTimeout(() => { if (typeof p.cancel === 'function') p.cancel(); resolve(false); }, ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

// Lines quote values the page sent (a URL, a path), so control characters go:
// a newline could forge a line in the prompt, an escape sequence rewrite the terminal.
function clean(s, max = 300) {
  const t = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '\u2026' : t;
}

function askOnce(q) {
  try {
    const p = asker(q);
    return p && typeof p.then === 'function' ? p : Promise.resolve(p);
  } catch (err) {
    return Promise.reject(err);
  }
}

// True only if the person allowed it. Never rejects.
function confirm({ title, lines = [] }) {
  title = clean(title, 200);
  lines = lines.slice(0, 20).map((l) => clean(l));
  const run = () => withTimeout(askOnce({ title, lines }), confirm.timeoutMs || ASK_TIMEOUT_MS)
    .then((ok) => ok === true)
    .catch((err) => {
      console.warn('[confirm] asking failed, so it counts as no:', err && err.message);
      return false;
    });
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}

// The terminal asker web/helper.js installs: prints the request and reads one line.
// Only y or yes allows. No terminal on stdin means no. The promise's cancel()
// takes the stdin listener off again, so a timed-out question leaves nothing behind.
function terminalAsker({ input = process.stdin, output = process.stderr } = {}) {
  return ({ title, lines }) => {
    let onData = null;
    let settle = null;
    const p = new Promise((resolve) => { settle = resolve; });
    p.cancel = () => {
      if (!onData) return;
      input.off('data', onData);
      input.pause();
      onData = null;
    };
    if (!input.isTTY) {
      output.write(`\n[maussian] Refused (no terminal to ask in): ${title}\n`);
      settle(false);
      return p;
    }
    output.write([
      '',
      '\u2500\u2500 Maussian needs your OK \u2500\u2500',
      title,
      ...lines.map((l) => `  ${l}`),
      'If you didn\u2019t just change this in the browser, answer n.',
      'Allow? [y/N] ',
    ].join('\n'));
    let buf = '';
    onData = (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      p.cancel();
      settle(/^\s*y(es)?\s*$/i.test(buf.slice(0, nl)));
    };
    input.on('data', onData);
    input.resume();
    return p;
  };
}

module.exports = { confirm, setAsker, terminalAsker, clean, ASK_TIMEOUT_MS };
