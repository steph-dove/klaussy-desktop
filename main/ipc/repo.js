// Project + worktree management: select-repo, get-repo, list-branches,
// and the list-projects/add/remove/switch suite, plus list-worktrees +
// hide-worktree and the new-window opener.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync, execSync } = require('child_process');
const { ipcMain, dialog } = require('electron');
const { loadConfig, saveConfig } = require('../util/config');
const { execFileP } = require('../util/exec');
const { getMainWindow, createWindow } = require('../state/windows');
const { instances } = require('../state/instances');
const { baseRepoForWorktree } = require('../util/git-repo');

ipcMain.handle('select-repo', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select the git repository to manage',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const repoPath = result.filePaths[0];

  // Validate it's a git repo
  try {
    execSync('git rev-parse --git-dir', { cwd: repoPath, stdio: 'pipe' });
  } catch {
    dialog.showErrorBox('Not a git repository', `${repoPath} is not a git repository.`);
    return null;
  }

  const config = loadConfig();
  config.repoPath = repoPath;
  saveConfig(config);
  return repoPath;
});

ipcMain.handle('get-repo', () => {
  const config = loadConfig();
  if (config.repoPath) return config.repoPath;
  // Fall back to first project if repoPath is missing
  if (config.projects && config.projects.length > 0) {
    config.repoPath = config.projects[0].path;
    saveConfig(config);
    return config.repoPath;
  }
  return null;
});

// List branches for a repo (local + remote, excluding those already checked out in worktrees)
ipcMain.handle('list-branches', async (_event, { repoPath }) => {
  try {
    await execFileP('git', ['rev-parse', '--git-dir'], { cwd: repoPath });
  } catch {
    return { error: 'Not a git repository: ' + repoPath };
  }

  // Get branches already checked out in worktrees
  let worktreeBranches = new Set();
  try {
    const { stdout: wtList } = await execFileP('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath });
    for (const line of wtList.split('\n')) {
      if (line.startsWith('branch ')) {
        worktreeBranches.add(line.replace('branch refs/heads/', ''));
      }
    }
  } catch {}

  let branches = [];
  try {
    const { stdout } = await execFileP('git', ['branch', '-a', '--format', '%(refname:short)\t%(objectname:short)\t%(committerdate:relative)'], {
      cwd: repoPath,
    });
    const raw = stdout.trim();
    for (const line of raw.split('\n')) {
      if (!line) continue;
      const [ref, hash, date] = line.split('\t');
      // Skip HEAD pointers and branches already in worktrees
      if (ref.includes('/HEAD')) continue;
      // For remote branches, strip origin/ prefix for the local name
      let localName = ref;
      let isRemote = false;
      if (ref.startsWith('origin/')) {
        localName = ref.replace('origin/', '');
        isRemote = true;
      }
      // Don't filter out branches checked out in worktrees — they're still
      // valid as a *base* (git worktree add -b new /path base works regardless
      // of whether base is currently checked out somewhere). Surface the state
      // via inWorktree so callers can decorate or filter as needed.
      const inWorktree = worktreeBranches.has(localName);
      branches.push({ ref, localName, hash, date, isRemote, inWorktree });
    }
  } catch (err) {
    return { error: 'Failed to list branches: ' + (err.stderr ? err.stderr.toString() : err.message) };
  }

  // Deduplicate: prefer local over remote
  const seen = new Map();
  for (const b of branches) {
    if (!seen.has(b.localName) || !b.isRemote) {
      seen.set(b.localName, b);
    }
  }

  // Resolve the default branch (origin/HEAD target). Falls back to the usual
  // suspects if the symbolic ref isn't set on the remote.
  let defaultBranch = '';
  try {
    defaultBranch = execSync('git symbolic-ref refs/remotes/origin/HEAD --short', {
      cwd: repoPath, stdio: 'pipe',
    }).toString().trim().replace('origin/', '');
  } catch {
    for (const candidate of ['main', 'master', 'develop']) {
      try {
        execFileSync('git', ['rev-parse', '--verify', candidate], { cwd: repoPath, stdio: 'pipe' });
        defaultBranch = candidate;
        break;
      } catch {}
    }
  }

  return { branches: Array.from(seen.values()), defaultBranch };
});

ipcMain.handle('list-projects', () => {
  const config = loadConfig();
  return config.projects || [];
});

// Renderer now hands us a path directly (from its paste/drag picker) to
// avoid dialog.showOpenDialog entirely — the native NSOpenPanel can hang
// on macOS when the scopedbookmarksagent XPC daemon is unresponsive.
ipcMain.handle('add-project', async (_event, arg) => {
  const projectPath = arg && arg.folderPath;
  if (!projectPath) return null;

  let isGitRepo = false;
  try {
    execSync('git rev-parse --git-dir', { cwd: projectPath, stdio: 'pipe' });
    isGitRepo = true;
  } catch {}

  if (!isGitRepo) {
    const { response } = await dialog.showMessageBox(getMainWindow(), {
      type: 'question',
      buttons: ['Initialize Git', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Not a git repository',
      message: `"${path.basename(projectPath)}" is not a git repository.`,
      detail: 'Would you like to initialize it with git? This will run "git init" in the selected directory.',
    });
    if (response !== 0) return null;
    try {
      execSync('git init', { cwd: projectPath, stdio: 'pipe' });
    } catch (err) {
      dialog.showErrorBox('Git init failed', err.message);
      return null;
    }
  }

  const config = loadConfig();
  if (!config.projects) config.projects = [];
  const name = path.basename(projectPath);
  if (!config.projects.find(p => p.path === projectPath)) {
    config.projects.push({ name, path: projectPath });
  }
  config.repoPath = projectPath;
  saveConfig(config);
  return { name, path: projectPath };
});

ipcMain.handle('remove-project', (_event, { projectPath }) => {
  const config = loadConfig();
  config.projects = (config.projects || []).filter(p => p.path !== projectPath);
  if (config.repoPath === projectPath) {
    config.repoPath = config.projects[0]?.path || null;
  }
  saveConfig(config);
  return { ok: true };
});

ipcMain.handle('switch-project', (_event, { projectPath }) => {
  const config = loadConfig();
  config.repoPath = projectPath;
  saveConfig(config);
  return { ok: true };
});

// ---- Multi-Window ----

ipcMain.handle('new-window', () => {
  createWindow({ secondary: true });
  return { ok: true };
});

// New-window session handoff. Instances are global to the main process, so
// the originating window creates the session's tasks, then opens a fresh
// window which claims these ids and renders them (terminal data fans out to
// every subscribed window). Keyed by the new window's webContents id — a
// FIFO would let an unrelated secondary window (Cmd+N, reloads) steal the
// handoff or adopt a stale one hours later.
const pendingWindowTasks = new Map(); // webContents.id -> ids
ipcMain.handle('new-window-with-tasks', (_event, { ids }) => {
  const clean = Array.isArray(ids) ? ids.filter((n) => Number.isFinite(n)) : [];
  if (!Array.isArray(ids) || clean.length !== ids.length) {
    console.warn('[new-window-with-tasks] dropped invalid ids:', ids);
  }
  if (!clean.length) return { error: 'no valid task ids to hand off' };
  const win = createWindow({ secondary: true });
  if (!win || !win.webContents) return { error: 'could not open a new window' };
  const wcId = win.webContents.id; // capture now — unavailable after destroy
  pendingWindowTasks.set(wcId, clean);
  // Window closed (or crashed) before its renderer claimed — drop the entry
  // so nothing can ever adopt it later.
  win.on('closed', () => pendingWindowTasks.delete(wcId));
  return { ok: true };
});
ipcMain.handle('claim-pending-tasks', (event) => {
  const ids = pendingWindowTasks.get(event.sender.id) || [];
  pendingWindowTasks.delete(event.sender.id);
  return ids;
});

// Parse `git worktree list --porcelain` into [{ path, branch, bare }].
function parseWorktreePorcelain(output) {
  const worktrees = [];
  let current = {};
  output.split('\n').forEach(line => {
    if (line.startsWith('worktree ')) {
      if (current.path) worktrees.push(current);
      current = { path: line.substring(9) };
    } else if (line.startsWith('branch ')) {
      current.branch = line.substring(7).replace('refs/heads/', '');
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === '') {
      if (current.path) worktrees.push(current);
      current = {};
    }
  });
  if (current.path) worktrees.push(current);
  return worktrees;
}

// List the (non-bare, non-hidden) worktrees of a single repo, decorated with
// active status. Returns [] if repoPath isn't a usable git repo.
async function worktreesForRepo(repoPath, hidden, activePaths) {
  try {
    await execFileP('git', ['rev-parse', '--git-dir'], { cwd: repoPath });
  } catch {
    return [];
  }
  try {
    const { stdout } = await execFileP('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath });
    // The repository's primary checkout also appears in the porcelain list —
    // it is NOT a session worktree and must never show up as resumable /
    // deletable. Resolve it via the common git dir so this also holds when
    // the configured "repo" is itself a linked worktree (then the porcelain
    // is enumerated from a sibling and the primary is a different path).
    const primary = baseRepoForWorktree(repoPath) || repoPath;
    return parseWorktreePorcelain(stdout)
      .filter(w => !w.bare && !hidden.has(w.path) && w.path !== primary)
      .map(w => ({
        path: w.path,
        name: path.basename(w.path),
        branch: w.branch || '',
        active: activePaths.has(w.path),
      }));
  } catch {
    return [];
  }
}

ipcMain.handle('list-worktrees', async () => {
  const config = loadConfig();
  const repoPath = config.repoPath;
  if (!repoPath) return [];
  const activePaths = new Set(Array.from(instances.values()).map(i => i.worktreePath));
  const hidden = new Set(config.hiddenWorktrees || []);
  // All worktrees here belong to the queried repo — stamp it so the sidebar
  // repo-filter can group them.
  const list = await worktreesForRepo(repoPath, hidden, activePaths);
  return list.map(w => ({ ...w, repoPath }));
});

// Discover worktrees across every configured project (+ the active repo),
// grouped by repo. Powers the "Existing worktree" tab dropdown so the user
// can jump to any worktree without first switching the active project.
ipcMain.handle('discover-worktrees', async () => {
  const config = loadConfig();
  const activePaths = new Set(Array.from(instances.values()).map(i => i.worktreePath));
  const hidden = new Set(config.hiddenWorktrees || []);

  // Union of configured projects + active repo, deduped by path.
  const repos = [];
  const seenRepo = new Set();
  for (const p of [...(config.projects || []), ...(config.repoPath ? [{ name: path.basename(config.repoPath), path: config.repoPath }] : [])]) {
    if (p && p.path && !seenRepo.has(p.path)) {
      seenRepo.add(p.path);
      repos.push(p);
    }
  }

  const groups = await Promise.all(repos.map(async (repo) => {
    const worktrees = await worktreesForRepo(repo.path, hidden, activePaths);
    return { repoName: repo.name || path.basename(repo.path), repoPath: repo.path, worktrees };
  }));

  // The session folders on disk are ground truth: ~/klaussy/sessions/<name>/
  // <repo> worktrees must show up even when their base repo has drifted out
  // of config.projects (config races / removals made real sessions read as
  // "No sessions found"). Scan the root directly and merge anything the
  // config-driven pass missed.
  try {
    const sessionsRoot = path.join(os.homedir(), 'klaussy', 'sessions');
    const known = new Set();
    for (const g of groups) for (const w of g.worktrees) known.add(w.path);
    const extrasByRepo = new Map();
    for (const sessionName of fs.readdirSync(sessionsRoot)) {
      const sdir = path.join(sessionsRoot, sessionName);
      let entries;
      try { entries = fs.readdirSync(sdir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const wt = path.join(sdir, e.name);
        if (known.has(wt) || hidden.has(wt)) continue;
        if (!fs.existsSync(path.join(wt, '.git'))) continue;
        let branch = '';
        try {
          branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: wt, stdio: 'pipe' })
            .toString().trim();
        } catch { continue; } // broken worktree — not resumable
        if (!extrasByRepo.has(e.name)) extrasByRepo.set(e.name, []);
        extrasByRepo.get(e.name).push({ path: wt, name: e.name, branch, active: activePaths.has(wt) });
      }
    }
    for (const [repoName, worktrees] of extrasByRepo) {
      groups.push({ repoName, repoPath: null, worktrees });
    }
  } catch { /* no sessions root yet */ }

  // Drop repos that contributed no worktrees (unreadable / all hidden).
  return groups.filter(g => g.worktrees.length > 0);
});

// Folders to crawl (one level deep) for git repos, beyond project siblings:
// the usual dev-folder conventions in $HOME.
const COMMON_DEV_DIRS = ['projects', 'code', 'dev', 'src', 'repos', 'work', 'Developer', 'git'];
const DISCOVER_SKIP = new Set(['node_modules', '.Trash', 'Library', 'Applications']);

// Scan one directory for git repos. A child counts as a repo only if it has a
// `.git` *directory* (excludes worktrees, whose `.git` is a file). A child that
// is NOT a repo is descended into while `depthRemaining > 0`, which catches the
// common org-grouping pattern (~/projects/<org>/<repo>) without surfacing
// vendored/sub-repos (repos themselves are never descended into).
async function collectRepos(dir, depthRemaining, configuredPaths, seenRepo, found) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) return;
    if (entry.name.startsWith('.') || DISCOVER_SKIP.has(entry.name)) return;
    const repoPath = path.join(dir, entry.name);
    let isRepo = false;
    try {
      const st = await fs.promises.stat(path.join(repoPath, '.git'));
      isRepo = st.isDirectory();
    } catch {}
    if (isRepo) {
      let real;
      try { real = await fs.promises.realpath(repoPath); } catch { real = repoPath; }
      if (seenRepo.has(real) || configuredPaths.has(real) || configuredPaths.has(repoPath)) return;
      seenRepo.add(real);
      found.push({ path: repoPath, name: entry.name });
    } else if (depthRemaining > 0) {
      await collectRepos(repoPath, depthRemaining - 1, configuredPaths, seenRepo, found);
    }
  }));
}

// Discover git repos on disk for the "New worktree" source-repo dropdown.
// Scans (deduped) parent dirs of configured projects + the active repo, common
// $HOME dev folders, and any config.repoScanRoots — each root one level deep,
// descending one extra level into non-repo folders (org grouping). Paths
// already configured as projects are omitted (they show separately).
// Also exported for gh-list-recent-repos, which matches GitHub repos against
// clones already on disk (config.projects alone misses repos the user has
// cloned but never opened in the app).
async function discoverReposOnDisk() {
  const config = loadConfig();
  const home = os.homedir();

  // Build the set of scan roots (realpath-deduped).
  const rootCandidates = [];
  for (const p of config.projects || []) {
    if (p && p.path) rootCandidates.push(path.dirname(p.path));
  }
  if (config.repoPath) rootCandidates.push(path.dirname(config.repoPath));
  for (const d of COMMON_DEV_DIRS) rootCandidates.push(path.join(home, d));
  for (const r of config.repoScanRoots || []) {
    if (typeof r === 'string' && r) rootCandidates.push(r);
  }

  const roots = [];
  const seenRoot = new Set();
  for (const r of rootCandidates) {
    let real;
    try { real = await fs.promises.realpath(r); } catch { continue; }
    if (seenRoot.has(real)) continue;
    seenRoot.add(real);
    roots.push(real);
  }

  // No exclusion set: there's no longer a separate "Projects" section to avoid
  // duplicating. The renderer dedupes the discovered list against the currently
  // "Open repos" so previously-used repos (nothing open) still surface here.
  const found = [];
  const seenRepo = new Set();

  // depthRemaining = 1: scan each root's children, and descend one extra level
  // into any child that isn't itself a repo (org-grouped clones).
  await Promise.all(roots.map(root => collectRepos(root, 1, new Set(), seenRepo, found)));

  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}

ipcMain.handle('discover-repos', async () => discoverReposOnDisk());

module.exports = { discoverReposOnDisk };

// Ranked location suggestions for the "New worktree" Location dropdown — the
// parent directory the new worktree gets created under. Ordered:
//   1. Alongside this repo's existing worktrees (most common parent), if any
//      — marked recommended.
//   2. The repo's parent dir (the klausify sibling default).
//   3. A tidy dedicated "<repo>-worktrees" folder next to the repo.
// Recent base paths are surfaced separately by the renderer (recent-paths-get).
ipcMain.handle('suggest-worktree-locations', async (_event, { repoPath }) => {
  if (!repoPath) return [];

  const suggestions = [];
  const seen = new Set();
  const add = (p, label, recommended) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    suggestions.push({ path: p, label, recommended: !!recommended });
  };

  // 1. Where this repo's existing worktrees already live (skip the primary
  //    checkout), ranked by how many sit under each parent.
  try {
    const { stdout } = await execFileP('git', ['worktree', 'list', '--porcelain'], { cwd: repoPath });
    const counts = new Map();
    for (const w of parseWorktreePorcelain(stdout)) {
      if (w.bare || w.path === repoPath) continue;
      const parent = path.dirname(w.path);
      counts.set(parent, (counts.get(parent) || 0) + 1);
    }
    const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    ranked.forEach(([parent], i) => {
      add(parent, i === 0 ? 'Alongside existing worktrees' : 'Existing worktree folder', i === 0);
    });
  } catch {}

  // 2. Repo parent (sibling) — the default. Recommended only if nothing above.
  add(path.dirname(repoPath), 'Next to the repo (default)', suggestions.length === 0);

  // 3. Dedicated, tidy worktrees folder convention next to the repo.
  add(path.join(path.dirname(repoPath), path.basename(repoPath) + '-worktrees'), 'Dedicated worktrees folder');

  return suggestions;
});

// Recently-used paths for the worktree modal's basepath + existing-worktree
// inputs. Source repos already live in config.projects; these two lists
// (worktrees, basepaths) cover the other two inputs. MRU order, capped at
// 10. Source-repo recents reuse list-projects / remove-project / switch-
// project — no new IPC for that case.
const RECENT_KINDS = new Set(['worktrees', 'basepaths', 'folders']);
const RECENT_CAP = 10;

ipcMain.handle('recent-paths-get', () => {
  const config = loadConfig();
  const r = config.recentPaths || {};
  return { worktrees: r.worktrees || [], basepaths: r.basepaths || [] };
});

ipcMain.handle('recent-paths-add', (_event, { kind, path: p }) => {
  if (!RECENT_KINDS.has(kind) || !p || typeof p !== 'string') return { ok: false };
  const config = loadConfig();
  if (!config.recentPaths) config.recentPaths = {};
  const existing = config.recentPaths[kind] || [];
  // MRU: drop any prior occurrence, prepend, cap.
  const next = [p, ...existing.filter(x => x !== p)].slice(0, RECENT_CAP);
  config.recentPaths[kind] = next;
  saveConfig(config);
  return { ok: true, list: next };
});

ipcMain.handle('recent-paths-remove', (_event, { kind, path: p }) => {
  if (!RECENT_KINDS.has(kind) || !p) return { ok: false };
  const config = loadConfig();
  if (!config.recentPaths) config.recentPaths = {};
  const existing = config.recentPaths[kind] || [];
  const next = existing.filter(x => x !== p);
  config.recentPaths[kind] = next;
  saveConfig(config);
  return { ok: true, list: next };
});

ipcMain.handle('hide-worktree', (_event, { worktreePath }) => {
  const config = loadConfig();
  if (!config.hiddenWorktrees) config.hiddenWorktrees = [];
  if (!config.hiddenWorktrees.includes(worktreePath)) {
    config.hiddenWorktrees.push(worktreePath);
  }
  saveConfig(config);
  return { ok: true };
});
