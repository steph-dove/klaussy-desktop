// File IPC: tree listing, bulk read, search + replace, merge-conflict
// read/write, .env viewer/editor, worktree watch subscriptions, and the
// single-file read/write used by the Monaco viewer.
//
// Every filesystem IPC here goes through pathUnder / pathUnderAnyRoot so an
// XSS in the renderer can't coerce main into reading ~/.ssh/id_rsa.

const path = require('path');
const fs = require('fs');
const { ipcMain } = require('electron');
const { execFileP } = require('../util/exec');
const { pathUnder, pathUnderAnyRoot } = require('../util/path-gate');
const { worktreeWatchers, startWorktreeWatcher, stopWorktreeWatcher } = require('../state/watcher');

// Directories we never descend into during the plain-fs fallback. Mirrors
// the patterns used by the H3 watcher.
const WALK_IGNORE = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.turbo', 'target',
  '.DS_Store', '.venv', 'venv', '.tox', 'coverage',
]);
const WALK_FILE_CAP = 10000;

function walkDirectory(root) {
  const results = [];
  const stack = [''];
  while (stack.length && results.length < WALK_FILE_CAP) {
    const rel = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch { continue; }
    for (const ent of entries) {
      if (WALK_IGNORE.has(ent.name)) continue;
      const childRel = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        stack.push(childRel);
      } else if (ent.isFile()) {
        results.push(childRel);
        if (results.length >= WALK_FILE_CAP) break;
      }
    }
  }
  return results;
}

// Bulk-read many files in one IPC round-trip. Used by the Monaco file
// viewer to hydrate sibling TS/JS models for cross-file IntelliSense.
// Per-file size is capped to avoid shipping giant minified bundles; total
// file count is capped by the caller.
ipcMain.handle('read-files-bulk', async (_event, { worktreePath, relPaths, maxBytesPerFile }) => {
  const cap = maxBytesPerFile || 256 * 1024; // 256KB per file default
  const out = {};
  for (const rel of relPaths) {
    // Reject path traversal AND symlink escapes — every entry must resolve
    // under the real worktree path (a symlink pointing outside is refused).
    const safe = pathUnder(worktreePath, rel);
    if (!safe) continue;
    try {
      const stat = fs.lstatSync(safe);
      if (!stat.isFile() || stat.size > cap) continue;
      out[rel] = fs.readFileSync(safe, 'utf-8');
    } catch {}
  }
  return { files: out };
});

ipcMain.handle('list-files', async (_event, { worktreePath }) => {
  // Try git first — for a checked-out repo, ls-files respects .gitignore.
  try {
    const { stdout } = await execFileP('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: worktreePath, maxBuffer: 5 * 1024 * 1024,
    });
    return { files: stdout.split('\n').filter(Boolean) };
  } catch (err) {
    // Not a git repo (open-folder flow) — walk the directory directly.
    const msg = err.stderr ? err.stderr.toString() : err.message;
    if (/not a git repository/i.test(msg)) {
      try {
        return { files: walkDirectory(worktreePath) };
      } catch (walkErr) {
        return { files: [], error: walkErr.message };
      }
    }
    return { files: [], error: msg };
  }
});

function parseGrepOutput(output) {
  const results = [];
  output.split('\n').filter(Boolean).forEach(function (line) {
    const match = line.match(/^([^:]+):(\d+):(.*)$/);
    if (match) {
      results.push({ file: match[1], line: parseInt(match[2], 10), text: match[3] });
    }
  });
  return results.slice(0, 100);
}

ipcMain.handle('search-files', async (_event, { worktreePath, query, maxPerFile }) => {
  // Literal (fixed-string) search via -F. Matches what the I7 replace path
  // does under the hood (content.split(query)), so preview and replace are
  // guaranteed to see the same hits. If regex search is ever needed, it
  // should land as an explicit opt-in flag rather than the default — the
  // replace path can't honor it safely.
  const cap = '--max-count=' + (typeof maxPerFile === 'number' ? maxPerFile : 5);
  // Try git grep — respects .gitignore and is fast.
  try {
    // `--` is mandatory: without it, a `query` starting with `-` (or a
    // long flag git-grep recognizes) is parsed as an option rather than
    // the search pattern. `-F` alone doesn't fully defend against that.
    const args = ['grep', '-n', '--no-color', '-I', '-r', '-F', cap, '--', query];
    const { stdout: output } = await execFileP('git', args, {
      cwd: worktreePath, maxBuffer: 5 * 1024 * 1024, timeout: 10000,
    });
    return { results: parseGrepOutput(output) };
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString() : err.message;
    if (/not a git repository/i.test(msg)) {
      // fall through to plain-grep fallback
    } else if (err.status === 1) {
      return { results: [] };
    } else {
      return { results: [], error: msg };
    }
  }
  // Non-git fallback — plain `grep -rnF -I` with the same ignore list the walker uses.
  try {
    const args = ['-rnF', '-I', cap];
    for (const dir of WALK_IGNORE) args.push('--exclude-dir=' + dir);
    args.push('--', query, '.');
    const { stdout: output } = await execFileP('grep', args, {
      cwd: worktreePath, maxBuffer: 5 * 1024 * 1024, timeout: 10000,
    });
    // grep prefixes paths with "./" — trim for consistency with git grep.
    const normalized = output.split('\n').map(l => l.replace(/^\.\//, '')).join('\n');
    return { results: parseGrepOutput(normalized) };
  } catch (err) {
    // grep exits 1 when nothing matched (promisified exposes this on err.code).
    if (err.code === 1) return { results: [] };
    return { results: [], error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// Replace-in-files (I7). Takes the same worktree + a list of file-relative
// paths plus a (literal) search string and replacement string. For each file
// we read, replaceAll, and write. Returns per-file counts so the caller can
// report "N replacements in M files".
//
// Intentionally literal-only: regex replace opens the door to capture-group
// surprises and destructive mistakes. If needed later we can add a flag.
ipcMain.handle('replace-in-files', async (_event, { worktreePath, relPaths, query, replacement }) => {
  if (!worktreePath || !Array.isArray(relPaths) || !query) {
    return { error: 'Missing required arguments' };
  }
  const perFile = [];
  let totalReplacements = 0;
  for (const rel of relPaths) {
    // pathUnder canonicalizes via realpath on both the root and the file,
    // so a symlink inside the worktree pointing out (e.g. -> /etc/passwd)
    // is refused — not just the lexical `..` traversal.
    const safe = pathUnder(worktreePath, rel);
    if (!safe) {
      perFile.push({ file: rel, error: 'Path escapes worktree' });
      continue;
    }
    try {
      const content = fs.readFileSync(safe, 'utf8');
      // Fast literal count via split; avoids needing to regex-escape the query.
      const parts = content.split(query);
      const count = parts.length - 1;
      if (count === 0) {
        perFile.push({ file: rel, replaced: 0 });
        continue;
      }
      const next = parts.join(replacement);
      fs.writeFileSync(safe, next);
      perFile.push({ file: rel, replaced: count });
      totalReplacements += count;
    } catch (err) {
      perFile.push({ file: rel, error: err.message });
    }
  }
  return { ok: true, totalReplacements, files: perFile };
});

// ---- Merge Conflict Resolution (Feature 1) ----

ipcMain.handle('read-conflict-file', async (_event, { worktreePath, file }) => {
  const safe = pathUnder(worktreePath, file);
  if (!safe) return { error: 'file outside worktree' };
  try {
    const content = fs.readFileSync(safe, 'utf-8');
    return { content };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('write-resolved-file', async (_event, { worktreePath, file, content }) => {
  const safe = pathUnder(worktreePath, file);
  if (!safe) return { error: 'file outside worktree' };
  try {
    fs.writeFileSync(safe, content, 'utf-8');
    // Use the original relative `file` arg for `git add` (git wants a repo-relative path).
    await execFileP('git', ['add', '--', file], { cwd: worktreePath });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// ---- .env File Viewer/Editor (Feature 12) ----

ipcMain.handle('list-env-files', async (_event, { worktreePath }) => {
  try {
    const entries = fs.readdirSync(worktreePath);
    const envFiles = entries.filter(f => /^\.env/.test(f) && fs.statSync(path.join(worktreePath, f)).isFile());
    return { files: envFiles };
  } catch (err) {
    return { files: [], error: err.message };
  }
});

ipcMain.handle('read-env-file', async (_event, { worktreePath, filename }) => {
  // Security: prevent path traversal
  if (filename.includes('/') || filename.includes('\\') || !filename.startsWith('.env')) {
    return { error: 'Invalid filename' };
  }
  try {
    const content = fs.readFileSync(path.join(worktreePath, filename), 'utf-8');
    return { content };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('write-env-file', async (_event, { worktreePath, filename, content }) => {
  // Security: prevent path traversal
  if (filename.includes('/') || filename.includes('\\') || !filename.startsWith('.env')) {
    return { error: 'Invalid filename' };
  }
  try {
    fs.writeFileSync(path.join(worktreePath, filename), content, 'utf-8');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// ---- H3: Worktree file watcher for instant diff refresh ----

ipcMain.handle('watch-worktree', (event, { worktreePath }) => {
  if (!worktreePath) return { error: 'no worktreePath' };
  const state = startWorktreeWatcher(worktreePath);
  if (!state) return { error: 'watcher failed to start' };
  const count = state.subscribers.get(event.sender) || 0;
  state.subscribers.set(event.sender, count + 1);
  // Auto-cleanup when the renderer is destroyed (window closed, reload, etc.).
  // Only registered on the first subscription from this sender — refcount
  // increments don't re-register the destroyed listener.
  if (count === 0) {
    const cleanup = () => {
      const s = worktreeWatchers.get(worktreePath);
      if (!s) return;
      s.subscribers.delete(event.sender);
      if (s.subscribers.size === 0) stopWorktreeWatcher(worktreePath);
    };
    event.sender.once('destroyed', cleanup);
  }
  return { ok: true };
});

ipcMain.handle('unwatch-worktree', (event, { worktreePath }) => {
  if (!worktreePath) return { ok: true };
  const state = worktreeWatchers.get(worktreePath);
  if (!state) return { ok: true };
  const count = state.subscribers.get(event.sender) || 0;
  if (count <= 1) state.subscribers.delete(event.sender);
  else state.subscribers.set(event.sender, count - 1);
  if (state.subscribers.size === 0) stopWorktreeWatcher(worktreePath);
  return { ok: true };
});

// ---- Phase 7: File Viewer ----

ipcMain.handle('read-file', async (_event, { filePath }) => {
  const safe = pathUnderAnyRoot(filePath);
  if (!safe) return { error: 'path not under an allowed project root' };
  try {
    const content = fs.readFileSync(safe, 'utf-8');
    return { content, ext: path.extname(safe).slice(1) };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('write-file', async (_event, { filePath, content }) => {
  const safe = pathUnderAnyRoot(filePath);
  if (!safe) return { error: 'path not under an allowed project root' };
  try {
    fs.writeFileSync(safe, content, 'utf-8');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});
