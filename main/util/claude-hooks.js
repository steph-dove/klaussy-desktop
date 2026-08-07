// Claude Code tells us what it is doing; we no longer have to infer it from a
// repainting screen. Its hooks fire with JSON on stdin — a Notification when it
// wants permission, a Stop when a turn ends — which is exactly the half of this
// that a transcript cannot supply, because prompts are UI, not conversation.

const fs = require('fs');
const os = require('os');
const path = require('path');

const KLAUSSY_DIR = path.join(os.homedir(), '.klaussy');
const CLIENT_PATH = path.join(KLAUSSY_DIR, 'agent-hook-client.js');

// Exits 0 no matter what: a hook that fails must never wedge the agent it is
// reporting on.
const CLIENT_SCRIPT = `// Klaussy agent-hook client — written by Klaussy; edits will be overwritten.
process.on('uncaughtException', () => process.exit(0));
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KDIR = path.join(os.homedir(), '.klaussy');
const socks = [];
function add(s) { if (s && socks.indexOf(s) === -1) socks.push(s); }
add(process.env.KLAUSSY_REVIEW_SOCK);
try {
  const dir = path.join(KDIR, 'sockets');
  for (const f of fs.readdirSync(dir)) {
    if (f.slice(-5) !== '.json') continue;
    try { add(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).socket); } catch (e) {}
  }
} catch (e) {}
if (!socks.length) process.exit(0);

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let payload;
  try { payload = JSON.parse(raw); } catch (e) { process.exit(0); }
  let pending = socks.length;
  const done = () => { if (--pending <= 0) process.exit(0); };
  for (const sock of socks) {
    try {
      const c = net.createConnection(sock, () => {
        c.write(JSON.stringify({ kind: 'claude-hook', payload }) + '\\n');
      });
      c.setTimeout(2000, () => { try { c.destroy(); } catch (e) {} done(); });
      c.on('data', () => { try { c.end(); } catch (e) {} });
      c.on('close', done);
      c.on('error', done);
    } catch (e) { done(); }
  }
});
// Never hold the agent up waiting on us.
setTimeout(() => process.exit(0), 3000).unref();
`;

function writeClient() {
  fs.mkdirSync(KLAUSSY_DIR, { recursive: true });
  fs.writeFileSync(CLIENT_PATH, CLIENT_SCRIPT, { mode: 0o755 });
  return CLIENT_PATH;
}

// Just these two: PreToolUse and friends fire far too often to be worth a message.
const HOOK_EVENTS = ['Notification', 'Stop'];

function hookEntry(clientPath) {
  return {
    hooks: [{ type: 'command', command: `node ${JSON.stringify(clientPath)}` }],
  };
}

function isKlaussyHook(entry) {
  return JSON.stringify(entry || '').includes('agent-hook-client');
}

// Written to the worktree's settings.local.json: that file is per-checkout and
// git-ignored by convention, so this never edits the user's own settings and
// disappears with the worktree.
function installForWorktree(worktreePath) {
  if (!worktreePath) return { ok: false, error: 'no worktree' };
  try {
    const clientPath = writeClient();
    const dir = path.join(worktreePath, '.claude');
    const file = path.join(dir, 'settings.local.json');
    fs.mkdirSync(dir, { recursive: true });

    let settings = {};
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      // Treating an unreadable file as empty would rewrite it as hooks alone,
      // silently discarding permissions and anything else the user keeps there.
      if (err.code !== 'ENOENT') {
        return { ok: false, error: `refusing to overwrite ${file}: ${err.message}` };
      }
    }
    if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};

    for (const event of HOOK_EVENTS) {
      const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
      // Replace only our own entry, so a user's hooks on the same event survive.
      const others = existing.filter((e) => !isKlaussyHook(e));
      settings.hooks[event] = [...others, hookEntry(clientPath)];
    }

    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
    return { ok: true, file };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Reduce a hook payload to the shape the gateway publishes, or null when it is
// not something worth a message.
function interpret(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const event = payload.hook_event_name || payload.event || '';
  const cwd = payload.cwd || '';
  const sessionId = payload.session_id || payload.sessionId || '';
  const transcriptPath = payload.transcript_path || payload.transcriptPath || '';

  if (event === 'Notification') {
    return {
      kind: 'notification',
      cwd,
      sessionId,
      transcriptPath,
      message: payload.message || '',
      title: payload.title || '',
      // Claude labels a permission ask; anything else is informational.
      isPermission: /permission/i.test(payload.notification_type || payload.notificationType || ''),
    };
  }

  if (event === 'Stop') {
    // A Stop raised by a hook's own continuation is not the agent finishing.
    if (payload.stop_hook_active === true) return null;
    return { kind: 'turn-end', cwd, sessionId, transcriptPath };
  }

  return null;
}

module.exports = {
  installForWorktree,
  interpret,
  writeClient,
  HOOK_EVENTS,
  CLIENT_PATH,
};
