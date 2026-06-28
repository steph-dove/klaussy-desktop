// File IPC: tree listing, bulk read, search + replace, merge-conflict
// read/write, .env viewer/editor, worktree watch subscriptions, and the
// single-file read/write used by the Monaco viewer.
//
// Every filesystem IPC here goes through pathUnder / pathUnderAnyRoot so an
// XSS in the renderer can't coerce main into reading ~/.ssh/id_rsa.

const path = require('path');
const fs = require('fs');
const { ipcMain, shell, clipboard } = require('electron');
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
  // Surface gitignored files (.env, pr-review.md, *.local, …) so users can
  // edit them from the file tree — matches what every editor does. Heavy
  // generated/dependency dirs are filtered at the git layer via pathspec
  // exclusions instead of `--exclude-standard`, so we don't enumerate
  // node_modules/ just to throw it away. Same WALK_IGNORE set the non-git
  // walker uses below, so the two code paths agree on what's hidden.
  const excludePathspecs = [];
  for (const dir of WALK_IGNORE) {
    excludePathspecs.push(`:(exclude,glob)**/${dir}`);
    excludePathspecs.push(`:(exclude,glob)**/${dir}/**`);
  }
  try {
    const args = ['ls-files', '--cached', '--others', '.', ...excludePathspecs];
    const { stdout } = await execFileP('git', args, {
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
    } else if (err.code === 1) {
      // git grep exits 1 when nothing matched — same convention as plain grep.
      // util.promisify(execFile) exposes the exit code on err.code (not
      // err.status); the previous check never matched, so empty results
      // surfaced as a misleading error to the search panel.
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

// Plan tab: locate a markdown doc at the worktree root and return its contents
// in one round-trip. The plan variant mirrors the discovery precedence of the
// ExitPlanMode CLI (main/state/precommit-hook.js → findPlanFile): a root .md
// file whose name contains the keyword. We prefer the conventional names so a
// repo with several matches resolves deterministically, then fall back to the
// shortest matching name. Root-only (the hook uses cwd), so there's no
// recursive walk and no path-traversal surface to gate.
function findRootDoc(worktreePath, keywordRe, preferred) {
  let entries;
  try {
    entries = fs.readdirSync(worktreePath, { withFileTypes: true });
  } catch (err) {
    return { error: err.message };
  }
  const names = entries
    .filter((e) => e.isFile() && keywordRe.test(e.name) && /\.md$/i.test(e.name))
    .map((e) => e.name);
  if (names.length === 0) return { error: 'not found' };
  const lower = names.map((n) => n.toLowerCase());
  let chosen = null;
  for (const p of preferred) {
    const i = lower.indexOf(p);
    if (i !== -1) { chosen = names[i]; break; }
  }
  // Stable tiebreak when no conventional name matched: shortest, then
  // lexicographic — so the resolved file doesn't flap between reloads.
  if (!chosen) {
    chosen = names.slice().sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  }
  try {
    const abs = path.join(worktreePath, chosen);
    return { name: chosen, path: abs, content: fs.readFileSync(abs, 'utf-8') };
  } catch (err) {
    return { error: err.message };
  }
}

ipcMain.handle('find-plan-file', async (_event, { worktreePath }) => {
  if (!worktreePath) return { error: 'no worktreePath' };
  return findRootDoc(worktreePath, /plan/i, ['implementation_plan.md', 'plan.md']);
});

ipcMain.handle('find-design-file', async (_event, { worktreePath }) => {
  if (!worktreePath) return { error: 'no worktreePath' };
  return findRootDoc(worktreePath, /design/i, ['design.md', 'design_doc.md', 'design-doc.md']);
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
    // mtimeMs lets the renderer stamp the buffer for external-mod detection
    // without a follow-up stat call.
    let mtimeMs = null;
    try { mtimeMs = fs.statSync(safe).mtimeMs; } catch {}
    return { content, ext: path.extname(safe).slice(1), mtimeMs };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('write-file', async (_event, { filePath, content }) => {
  const safe = pathUnderAnyRoot(filePath);
  if (!safe) return { error: 'path not under an allowed project root' };
  try {
    fs.writeFileSync(safe, content, 'utf-8');
    let mtimeMs = null;
    try { mtimeMs = fs.statSync(safe).mtimeMs; } catch {}
    return { ok: true, mtimeMs };
  } catch (err) {
    return { error: err.message };
  }
});

// ---- File tree mutations: create / rename / delete / stat / reveal / copy ----
//
// Every mutating handler resolves the target through pathUnder so the renderer
// can't escape the worktree. Create/rename also gate the *destination* parent
// dir, so a malicious payload can't pass `..` segments to land outside the
// worktree even if the basename looks innocent.

// Stat is read-only but deliberately separate from read-file because the
// caller (external-mod detection) only needs mtime + size, not the content.
ipcMain.handle('stat-file', async (_event, { filePath }) => {
  const safe = pathUnderAnyRoot(filePath);
  if (!safe) return { error: 'path not under an allowed project root' };
  try {
    const st = fs.statSync(safe);
    return { ok: true, mtimeMs: st.mtimeMs, size: st.size, isFile: st.isFile(), isDirectory: st.isDirectory() };
  } catch (err) {
    return { error: err.message };
  }
});

// Create a new empty file. Refuses to overwrite. The renderer is expected to
// handle "name already exists" by re-prompting; we don't want a silent clobber.
ipcMain.handle('create-file', async (_event, { worktreePath, relPath }) => {
  if (!worktreePath || !relPath) return { error: 'missing args' };
  const safe = pathUnder(worktreePath, relPath);
  if (!safe) return { error: 'path escapes worktree' };
  try {
    if (fs.existsSync(safe)) return { error: 'a file or folder with that name already exists' };
    fs.mkdirSync(path.dirname(safe), { recursive: true });
    fs.writeFileSync(safe, '', { flag: 'wx' });
    return { ok: true, path: safe };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('create-dir', async (_event, { worktreePath, relPath }) => {
  if (!worktreePath || !relPath) return { error: 'missing args' };
  const safe = pathUnder(worktreePath, relPath);
  if (!safe) return { error: 'path escapes worktree' };
  try {
    if (fs.existsSync(safe)) return { error: 'a file or folder with that name already exists' };
    fs.mkdirSync(safe, { recursive: false });
    return { ok: true, path: safe };
  } catch (err) {
    return { error: err.message };
  }
});

// Rename / move within a worktree. fromRel and toRel are both worktree-relative.
// Used by both the rename action and drag-and-drop move (move is just a rename
// with a different parent dir).
ipcMain.handle('rename-path', async (_event, { worktreePath, fromRel, toRel }) => {
  if (!worktreePath || !fromRel || !toRel) return { error: 'missing args' };
  const fromSafe = pathUnder(worktreePath, fromRel);
  const toSafe = pathUnder(worktreePath, toRel);
  if (!fromSafe || !toSafe) return { error: 'path escapes worktree' };
  if (fromSafe === toSafe) return { ok: true, path: toSafe };
  try {
    if (!fs.existsSync(fromSafe)) return { error: 'source does not exist' };
    if (fs.existsSync(toSafe)) return { error: 'destination already exists' };
    fs.mkdirSync(path.dirname(toSafe), { recursive: true });
    fs.renameSync(fromSafe, toSafe);
    return { ok: true, path: toSafe };
  } catch (err) {
    return { error: err.message };
  }
});

// Delete file or directory. Routes through shell.trashItem so the user can
// recover from Finder's Trash — `rm -rf` from a UI button is unforgiving.
// Falls back to fs.rmSync only if trashItem fails (e.g. on a volume Finder
// can't trash to), and only after explicit caller opt-in via `permanent: true`.
ipcMain.handle('delete-path', async (_event, { worktreePath, relPath, permanent }) => {
  if (!worktreePath || !relPath) return { error: 'missing args' };
  const safe = pathUnder(worktreePath, relPath);
  if (!safe) return { error: 'path escapes worktree' };
  // Refuse to delete the worktree root itself — almost certainly a bug, and
  // the consequences (blowing away the user's repo) are catastrophic.
  try {
    const rootReal = fs.realpathSync(worktreePath);
    if (safe === rootReal) return { error: 'refusing to delete worktree root' };
  } catch {}
  try {
    if (!fs.existsSync(safe)) return { error: 'path does not exist' };
    if (permanent) {
      fs.rmSync(safe, { recursive: true, force: true });
    } else {
      await shell.trashItem(safe);
    }
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Reveal in Finder. shell.showItemInFolder selects the item in its containing
// folder window — matches macOS users' expectations for "Reveal in Finder".
ipcMain.handle('reveal-in-folder', async (_event, { filePath }) => {
  const safe = pathUnderAnyRoot(filePath);
  if (!safe) return { error: 'path not under an allowed project root' };
  try {
    shell.showItemInFolder(safe);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Copy text to the system clipboard from main. The renderer has
// navigator.clipboard for ad-hoc cases, but routing path copies through main
// keeps the tree's right-click menu uniform with the rest of the IPC surface
// and avoids any focus-related clipboard quirks in nested DOM events.
ipcMain.handle('clipboard-write-text', async (_event, { text }) => {
  try {
    clipboard.writeText(String(text == null ? '' : text));
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});
