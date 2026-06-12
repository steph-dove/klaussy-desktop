// All task-lifecycle IPC: saved sessions, create/checkout/open, list-tasks,
// terminal write/resize, sub-terminals, kill/restart/rename/duplicate,
// notify toggle, dirty-worktree aggregator, transcripts, pop-out, task notes.

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, execSync } = require('child_process');
const pty = require('node-pty');
const { app, ipcMain, dialog, BrowserWindow } = require('electron');
const { loadConfig, saveConfig } = require('../util/config');
const { execFileP } = require('../util/exec');
const { baseRepoForWorktree } = require('../util/git-repo');
const { defaultShell, shellLoginArgs, shellRunCmdArgs } = require('../util/platform');
const {
  instances, spawnInWorktree, findLatestSessionId, snapshotSessionIds,
  processIdleDetection, clearIdleTimer, convertInstanceToShell,
  sendToTerminalSubscribers,
} = require('../state/instances');
const { stopCIPolling } = require('../state/ci-poll');
const { getMainWindow, hardenWindow } = require('../state/windows');
const { collectWorktreeState } = require('./git');
const { getProvider, isAgentMode, binFor, displayNameFor } = require('../state/ai-providers');
const { ensureWorktreeConsentSync } = require('../util/agent-consent');
const { beginSession } = require('../util/agent-concurrency');

// create-task / duplicate-task put worktrees as a sibling of the main repo
// in a `klaus-worktrees/` directory.
function getWorktreeDir(repoPath) {
  return path.join(path.dirname(repoPath), 'klaus-worktrees');
}

// Freshen `branch` from origin before a worktree is created off it, so the
// new worktree starts from the latest remote state instead of whatever was
// fetched last. Non-fatal by design. Returns { warning, info }:
//   warning — failure text (caller continues anyway and shows a warn toast)
//   info    — success evidence ("pulled a1b2c3d → e4f5a6b" / "up to date"),
//             surfaced as an info toast so the fetch+pull isn't invisible.
async function freshenBranchFromOrigin(repoPath, branch) {
  // Local-only repo (no origin): nothing to freshen, nothing to report.
  try {
    execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoPath, stdio: 'pipe' });
  } catch {
    return { warning: null, info: null };
  }

  const firstLine = (err) =>
    ((err && err.stderr ? String(err.stderr) : '') || (err && err.message) || '')
      .trim().split('\n')[0];
  const tipOf = () => {
    try {
      // Fully qualified — a tag named like the branch would otherwise shadow
      // it (rev-parse resolves refs/tags before refs/heads) and make the
      // before/after comparison lie.
      return execFileSync('git', ['rev-parse', '--short', 'refs/heads/' + branch], { cwd: repoPath, stdio: 'pipe' })
        .toString().trim();
    } catch {
      return null;
    }
  };

  const before = tipOf();

  try {
    await execFileP('git', ['fetch', 'origin', branch], { cwd: repoPath, timeout: 30000 });
  } catch (err) {
    // A branch that only exists locally isn't a fetch failure — there is
    // simply no remote counterpart to pull.
    if (/couldn't find remote ref/i.test(String(err && err.stderr || ''))) {
      return { warning: null, info: '"' + branch + '" is local-only (no origin counterpart to pull)' };
    }
    return {
      warning: 'Could not fetch latest "' + branch + '" from origin — continuing with the local copy. (' + firstLine(err) + ')',
      info: null,
    };
  }

  // Update the local branch ref. If it's checked out in the source repo we
  // must go through pull (git refuses ref updates under a checkout); otherwise
  // a fetch refspec fast-forwards it directly (and creates it if missing).
  let head = null;
  try {
    head = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repoPath, stdio: 'pipe' })
      .toString().trim();
  } catch { /* detached HEAD */ }

  try {
    if (head === branch) {
      await execFileP('git', ['pull', '--ff-only', 'origin', branch], { cwd: repoPath, timeout: 60000 });
    } else {
      await execFileP('git', ['fetch', 'origin', branch + ':' + branch], { cwd: repoPath, timeout: 30000 });
    }
  } catch (err) {
    return {
      warning: 'Fetched origin, but could not fast-forward local "' + branch + '" — continuing with the local copy. (' + firstLine(err) + ')',
      info: null,
    };
  }

  const after = tipOf();
  let info;
  if (!before && after) info = 'fetched "' + branch + '" from origin (' + after + ')';
  else if (before && after && before !== after) info = 'pulled "' + branch + '" ' + before + ' → ' + after;
  else info = '"' + branch + '" is up to date with origin';
  return { warning: null, info };
}

ipcMain.handle('list-saved-sessions', () => {
  const config = loadConfig();
  // Backfill repoPath for sessions saved before it was tracked, so the sidebar
  // repo-filter can group them. Best-effort: only resolves if the worktree
  // still exists.
  return (config.savedSessions || []).map(s => ({
    ...s,
    repoPath: s.repoPath || baseRepoForWorktree(s.worktreePath),
  }));
});

ipcMain.handle('resume-session', (_event, { sessionId, name, worktreePath, branch, mode }) => {
  // Verify the worktree still exists
  if (!fs.existsSync(worktreePath)) {
    return { error: 'Worktree no longer exists: ' + worktreePath };
  }
  const resumeMode = mode || 'claude';
  // Only Claude tracks an exact session id to resume; other providers resume
  // their latest session in the worktree via their native flag (handled by the
  // registry's buildInteractiveCmd), so we don't pass a stale sessionId.
  const provider = getProvider(resumeMode);
  const exactId = provider && provider.supportsExactResume ? sessionId : null;
  try {
    return spawnInWorktree(name, worktreePath, branch, resumeMode, exactId);
  } catch (err) {
    console.error('[resume-session] spawnInWorktree failed:', err);
    return { error: 'Failed to start terminal: ' + (err && err.message || err) };
  }
});

ipcMain.handle('save-ui-state', (_event, state) => {
  const config = loadConfig();
  config.uiState = state;
  saveConfig(config);
  return { ok: true };
});

ipcMain.handle('get-ui-state', () => {
  const config = loadConfig();
  return config.uiState || null;
});

ipcMain.handle('get-latest-session', (_event, { worktreePath }) => {
  return findLatestSessionId(worktreePath);
});

ipcMain.handle('clear-saved-sessions', () => {
  const config = loadConfig();
  config.savedSessions = [];
  saveConfig(config);
  return { ok: true };
});

// Remove a single saved session by stable identity (worktreePath + sessionId).
// Renderer used to splice-by-index in a closure, which silently deleted the
// wrong row after any prior dismiss shifted the array.
ipcMain.handle('dismiss-saved-session', (_event, { worktreePath, sessionId }) => {
  const config = loadConfig();
  const before = config.savedSessions || [];
  config.savedSessions = before.filter((s) => {
    if (!s || s.worktreePath !== worktreePath) return true;
    // If the dismissed row carries a sessionId, only drop that exact row;
    // otherwise drop every row for the worktree (shell-only saves).
    if (sessionId) return s.sessionId !== sessionId;
    return false;
  });
  saveConfig(config);
  return { ok: true };
});

ipcMain.handle('create-task', async (_event, { name, repoPath, mode, basePath, envVars, baseBranch: requestedBase, baseBranchFallback }) => {
  // Validate repoPath is a git repo
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repoPath, stdio: 'pipe' });
  } catch {
    return { error: 'Active project is not a git repository. Remove and re-add the project to initialize git.' };
  }

  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const branch = sanitized;

  // Default layout: one folder per session holding every repo's worktree —
  // ~/klaussy/sessions/<session>/<repo>. An explicit basePath (legacy /
  // power-user callers) keeps the old sibling convention <repo>-<branch>.
  const repoBasename = path.basename(repoPath);
  const worktreeDir = basePath || path.join(os.homedir(), 'klaussy', 'sessions', sanitized);
  const worktreePath = basePath
    ? path.join(worktreeDir, repoBasename + '-' + sanitized)
    : path.join(worktreeDir, repoBasename);

  if (fs.existsSync(worktreePath)) {
    return { error: 'Worktree directory already exists: ' + worktreePath };
  }

  // Resolve the base. Caller can pass an explicit branch (chosen from the
  // dropdown); otherwise fall back to origin/HEAD or the usual defaults.
  let baseBranch = (requestedBase || '').trim();
  let baseFallbackFrom = null;
  if (baseBranch) {
    try {
      execFileSync('git', ['rev-parse', '--verify', baseBranch], { cwd: repoPath, stdio: 'pipe' });
    } catch {
      try {
        execFileSync('git', ['branch', baseBranch, 'origin/' + baseBranch], { cwd: repoPath, stdio: 'pipe' });
      } catch (err) {
        // Multi-repo create passes baseBranchFallback for secondary repos:
        // the base was picked from the primary repo's branch list, so a repo
        // that doesn't have it should branch from its own default instead of
        // failing the whole fan-out. The swap is surfaced via result.warning.
        if (!baseBranchFallback) {
          return { error: 'Base branch "' + baseBranch + '" not found locally or on origin.' };
        }
        baseFallbackFrom = baseBranch;
        baseBranch = '';
      }
    }
  }
  if (!baseBranch) {
    try {
      baseBranch = execSync('git symbolic-ref refs/remotes/origin/HEAD --short', {
        cwd: repoPath, stdio: 'pipe',
      }).toString().trim().replace('origin/', '');
    } catch {
      for (const candidate of ['main', 'master', 'develop']) {
        try {
          execFileSync('git', ['rev-parse', '--verify', candidate], { cwd: repoPath, stdio: 'pipe' });
          baseBranch = candidate;
          break;
        } catch {}
      }
      if (!baseBranch) baseBranch = 'main';
    }
  }

  // Freshen the base from origin so the worktree starts from the latest
  // commit. Non-fatal: on failure we keep going with the local state and
  // surface the warning on the result.
  const freshen = await freshenBranchFromOrigin(repoPath, baseBranch);
  const freshenWarning = freshen.warning;
  const fallbackWarning = baseFallbackFrom
    ? 'Base "' + baseFallbackFrom + '" not found in this repo — branched from "' + baseBranch + '" instead.'
    : null;

  // Ensure the chosen location exists — git worktree add creates the leaf dir
  // but not missing parents (e.g. a suggested "<repo>-worktrees" folder).
  try {
    fs.mkdirSync(worktreeDir, { recursive: true });
  } catch (e) {
    return { error: 'Could not create the worktree location ' + worktreeDir + ': ' + e.message };
  }

  // Create the worktree (matching klausify CLI: git worktree add ../<repo>-<branch> -b <branch>)
  let reusedBranchWarning = null;
  const cleanupSessionDir = () => {
    // We created ~/klaussy/sessions/<session>/ above; don't leave an empty
    // husk behind on failure (it would block / confuse the next attempt).
    if (basePath) return;
    try {
      if (fs.existsSync(worktreeDir) && fs.readdirSync(worktreeDir).length === 0) fs.rmdirSync(worktreeDir);
    } catch {}
  };
  try {
    execFileSync('git', ['worktree', 'add', '-b', branch, worktreePath, baseBranch], {
      cwd: repoPath,
      stdio: 'pipe',
    });
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString() : err.message;
    // Deleting a session keeps its branches, so recreating one with the same
    // name hits "a branch named 'x' already exists". Continue that branch
    // instead of failing — and say so.
    if (/branch named .* already exists/i.test(msg)) {
      try {
        execFileSync('git', ['worktree', 'add', worktreePath, branch], {
          cwd: repoPath,
          stdio: 'pipe',
        });
        reusedBranchWarning = 'Branch "' + branch + '" already existed (kept from a previous session) — continued it instead of branching from "' + baseBranch + '".';
      } catch (err2) {
        cleanupSessionDir();
        return { error: `Failed to create worktree: ${err2.stderr ? err2.stderr.toString() : err2.message}` };
      }
    } else {
      cleanupSessionDir();
      return { error: `Failed to create worktree: ${msg}` };
    }
  }

  // Verify the worktree was created in the correct repo
  try {
    const wtTopLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: worktreePath, stdio: 'pipe'
    }).toString().trim();
    console.log(`Worktree created: ${worktreePath} (repo: ${wtTopLevel}, base: ${baseBranch})`);
  } catch {}

  // Seed the worktree with the base repo's intel artifacts (CLAUDE.md,
  // rules, skills) BEFORE the agent spawns — worktrees only contain
  // committed files, and an agent that boots without CLAUDE.md announces
  // "no CLAUDE.md provided".
  try { require('../state/repo-intel').syncIntelIntoWorktree(worktreePath); } catch (e) {
    console.warn('[repo-intel] pre-spawn sync failed:', e.message);
  }

  const warning = [fallbackWarning, freshenWarning, reusedBranchWarning].filter(Boolean).join(' ') || null;
  const result = spawnInWorktree(name, worktreePath, branch, mode || 'claude', null, envVars);
  if (result && !result.error) {
    if (warning) result.warning = warning;
    if (freshen.info) result.freshenInfo = freshen.info;
  }
  return result;
});

// Find the repository a worktree path is REGISTERED to by scanning the
// configured repos' `git worktree list` output. Needed when the worktree's
// directory no longer exists (stale registration): baseRepoForWorktree can't
// run there (no cwd), but the registration still names the path verbatim.
function findRepoForRegisteredWorktree(wtPath) {
  const config = loadConfig();
  const candidates = new Set();
  for (const p of config.projects || []) {
    if (p && p.path) candidates.add(p.path);
  }
  if (config.repoPath) candidates.add(config.repoPath);
  // Configured "repos" can themselves be linked worktrees — resolve their
  // primaries too so registrations are found at the common git dir.
  for (const c of Array.from(candidates)) {
    const base = baseRepoForWorktree(c);
    if (base) candidates.add(base);
  }
  for (const repo of candidates) {
    try {
      const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repo, stdio: 'pipe', timeout: 10000,
      }).toString();
      if (out.split('\n').indexOf('worktree ' + wtPath) !== -1) {
        return baseRepoForWorktree(repo) || repo;
      }
    } catch { /* repo gone / not git — keep scanning */ }
  }
  return null;
}

// Delete a whole session: remove every worktree (git worktree remove --force,
// with a sessions-root-only rm fallback) and the now-empty session folder,
// then scrub config debris (saved sessions, recents, hidden list) for the
// deleted paths. Destructive by design — the renderer collects an explicit
// confirmation first. Branches are intentionally kept.
ipcMain.handle('delete-session', async (_event, { worktreePaths }) => {
  if (!Array.isArray(worktreePaths) || !worktreePaths.length) {
    return { error: 'No worktrees given' };
  }
  const sessionsRoot = path.join(os.homedir(), 'klaussy', 'sessions');
  const inSessionsRoot = (p) => p.startsWith(sessionsRoot + path.sep);
  const results = [];
  const sessionDirs = new Set();

  for (const wtPath of worktreePaths) {
    if (typeof wtPath !== 'string' || !path.isAbsolute(wtPath)) {
      results.push({ path: String(wtPath), error: 'invalid path' });
      continue;
    }
    // Backstop — the renderer closes terminals first, but never rip a
    // worktree out from under a live PTY.
    const live = Array.from(instances.values()).find((i) => i.worktreePath === wtPath);
    if (live) {
      results.push({ path: wtPath, error: 'a terminal is still open on this worktree' });
      continue;
    }

    // baseRepoForWorktree needs the directory to exist (it runs git there);
    // for stale registrations (dir already deleted) resolve the owning repo
    // from the registrations themselves.
    const repo = baseRepoForWorktree(wtPath) || findRepoForRegisteredWorktree(wtPath);
    // Never delete a repository's primary checkout — it can reach here via
    // stale UI data even though discovery filters it out.
    if (repo && repo === wtPath) {
      results.push({ path: wtPath, error: "this is the repository's main checkout, not a session worktree" });
      continue;
    }
    let removed = false;
    let gitError = null;
    if (repo && repo !== wtPath) {
      try {
        // Double --force: a single one still refuses locked worktrees and
        // worktrees containing submodules. The user has already typed
        // "delete" past an explicit warning at this point.
        await execFileP('git', ['worktree', 'remove', '--force', '--force', wtPath], { cwd: repo, timeout: 30000 });
        removed = true;
      } catch (err) {
        gitError = ((err && err.stderr ? String(err.stderr) : '') || (err && err.message) || '').trim().split('\n')[0];
      }
    }
    if (!removed) {
      // Fallback only INSIDE ~/klaussy/sessions — never force-delete
      // arbitrary paths.
      if (inSessionsRoot(wtPath)) {
        try {
          fs.rmSync(wtPath, { recursive: true, force: true });
          if (repo && repo !== wtPath) {
            try { await execFileP('git', ['worktree', 'prune'], { cwd: repo, timeout: 15000 }); } catch {}
          }
          removed = true;
        } catch (err2) {
          results.push({ path: wtPath, error: (gitError || '') + ' / rm failed: ' + err2.message });
          continue;
        }
      } else {
        results.push({
          path: wtPath,
          error: gitError
            ? 'git worktree remove failed: ' + gitError
            : 'could not locate the repository this worktree belongs to',
        });
        continue;
      }
    }
    results.push({ path: wtPath, ok: true });
    const parent = path.dirname(wtPath);
    if (inSessionsRoot(parent)) sessionDirs.add(parent);
  }

  // Remove now-empty session folders (sessions root only).
  for (const dir of sessionDirs) {
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch { /* leftover files — leave the folder for the user */ }
  }

  // Scrub config references to the deleted paths.
  const deleted = new Set(results.filter((r) => r.ok).map((r) => r.path));
  if (deleted.size) {
    const config = loadConfig();
    let dirty = false;
    if (Array.isArray(config.savedSessions)) {
      const before = config.savedSessions.length;
      config.savedSessions = config.savedSessions.filter((s) => !s || !deleted.has(s.worktreePath));
      dirty = dirty || config.savedSessions.length !== before;
    }
    if (config.recentPaths && Array.isArray(config.recentPaths.worktrees)) {
      const before = config.recentPaths.worktrees.length;
      config.recentPaths.worktrees = config.recentPaths.worktrees.filter((p) => !deleted.has(p));
      dirty = dirty || config.recentPaths.worktrees.length !== before;
    }
    if (Array.isArray(config.hiddenWorktrees)) {
      const before = config.hiddenWorktrees.length;
      config.hiddenWorktrees = config.hiddenWorktrees.filter((p) => !deleted.has(p));
      dirty = dirty || config.hiddenWorktrees.length !== before;
    }
    if (dirty) saveConfig(config);
  }

  return { results };
});

// Pre-commit silent-failure review for the diff panel's Commit button. The
// renderer shows findings and the user decides fix-first vs commit-anyway.
ipcMain.handle('precommit-review-run', async (_event, { worktreePath, provider }) => {
  try {
    const { runStagedCheck } = require('../state/precommit-review');
    const result = await runStagedCheck({ worktreePath, provider });
    // A clean app-side review counts for the pre-push skip too: leave the
    // passmark so the commit that follows gets recorded by post-commit.
    if (result && !result.error && !result.skipped && !result.cancelled && !result.findingsCount) {
      try { require('../state/precommit-hook').leaveReviewPassmark(worktreePath); } catch {}
    }
    return result;
  } catch (e) {
    return { error: e.message };
  }
});
ipcMain.handle('precommit-review-cancel', (_event, { worktreePath }) => {
  try {
    const { cancelStagedCheck } = require('../state/precommit-review');
    return { cancelled: cancelStagedCheck(worktreePath) };
  } catch (e) {
    return { error: e.message };
  }
});

// Arm the pre-commit socket server at boot so hooks installed in previous
// runs work in this one (the hook no-ops when the app isn't running).
try {
  require('../state/precommit-hook').startPrecommitServer();
} catch (e) {
  console.warn('[precommit-hook] server start failed:', e.message);
}

// Repository-intelligence block (conventions + import graph) for renderer-
// side prompt builders (Plan / Debug / Review sub-tabs). '' until generated.
// `agent` enables the slim graph-only block for claude in synced worktrees
// (CLAUDE.md loads natively there — full injection pays its tokens twice).
ipcMain.handle('get-repo-intel', (_event, { worktreePath, agent }) => {
  try {
    const { getRepoIntelBlock } = require('../state/repo-intel');
    return { block: getRepoIntelBlock(worktreePath, agent) || '' };
  } catch (e) {
    console.warn('[get-repo-intel]', e.message);
    return { block: '' };
  }
});

// ---- Current model for the sub-tab agent labels -----------------------------
// "Claude Fable 5", not "claude code 2.1.172". Resolution order: the pinned
// per-provider model from Preferences, then (Claude only) the model stamped on
// the worktree's newest session JSONL. Null until a session exists — the
// renderer shows the bare agent name and re-asks on tab switches.

// Last "model" value in a session JSONL written at/after `minTs` (ms epoch),
// scanning backwards in chunks. A shallow tail isn't enough — the file can
// end in a multi-hundred-KB tool result with no assistant line in it. The
// timestamp gate matters for resumed sessions: the file's tail still carries
// the model of whoever ran the session LAST time until the current run's
// first response lands, and reporting that would mislabel the tab. Entry
// timestamps increase down the file, so the newest model line decides: if
// it predates minTs, no in-run model exists yet. Chunks overlap 4KB so a
// line can't be lost on a boundary; capped so a giant session can't stall
// the main process.
function lastModelInFile(filePath, minTs) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const CHUNK = 256 * 1024;
    const OVERLAP = 4096;
    const MAX_SCAN = 4 * 1024 * 1024;
    let end = size;
    let scanned = 0;
    while (end > 0 && scanned < MAX_SCAN) {
      const len = Math.min(CHUNK, end);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, end - len);
      const lines = buf.toString('utf-8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(/"model"\s*:\s*"([^"]+)"/);
        // Skip "<synthetic>" (error placeholder entries).
        if (!m || !m[1] || m[1].startsWith('<')) continue;
        if (minTs) {
          const t = lines[i].match(/"timestamp"\s*:\s*"([^"]+)"/);
          const ts = t ? Date.parse(t[1]) : NaN;
          // Newest model entry predates this run — nothing current in here.
          if (!Number.isNaN(ts) && ts < minTs) return null;
        }
        return m[1];
      }
      if (len >= end) break;
      end -= (len - OVERLAP);
      scanned += len;
    }
  } catch { /* unreadable — treat as no model */ } finally {
    try { fs.closeSync(fd); } catch {}
  }
  return null;
}

// The model this task's Claude session is on. Prefer the instance's tracked
// session id (exact file); fall back to the newest session in the worktree's
// project dir — but ONLY the newest. Falling back to older sessions reports
// whatever model some previous task ran, which is worse than showing nothing.
function currentClaudeSessionModel(worktreePath, sessionId, spawnedAtMs) {
  try {
    const home = process.env.HOME || os.homedir();
    if (!home || !worktreePath) return null;
    // Same encoding listSessionFiles (state/instances.js) uses.
    const projectDir = path.join(home, '.claude', 'projects', worktreePath.replace(/\//g, '-'));
    if (sessionId) {
      const exact = path.join(projectDir, sessionId + '.jsonl');
      if (fs.existsSync(exact)) {
        const model = lastModelInFile(exact, spawnedAtMs);
        if (model) return model;
      }
    }
    const files = fs.readdirSync(projectDir)
      // agent-*.jsonl are subagent transcripts — they often run a different
      // model (e.g. a Haiku helper) and would mislabel the tab.
      .filter((f) => f.endsWith('.jsonl') && !f.startsWith('agent-'))
      .map((f) => {
        const p = path.join(projectDir, f);
        return { p, mtime: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return null;
    return lastModelInFile(files[0].p, spawnedAtMs);
  } catch { /* no sessions yet / dir missing */
    return null;
  }
}

// The Claude CLI's own configured default model (~/.claude/settings.json,
// "model" key) — what an unpinned spawn actually runs before any session
// evidence exists. Briefly cached; the user can edit settings.json anytime.
let claudeSettingsModelCache = null; // { value, at }
function claudeDefaultModelFromSettings() {
  if (claudeSettingsModelCache && Date.now() - claudeSettingsModelCache.at < 60 * 1000) {
    return claudeSettingsModelCache.value;
  }
  let value = null;
  try {
    const p = path.join(process.env.HOME || os.homedir(), '.claude', 'settings.json');
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (parsed && typeof parsed.model === 'string' && parsed.model) value = parsed.model;
  } catch { /* no settings / no model key */ }
  claudeSettingsModelCache = { value, at: Date.now() };
  return value;
}

// Resolution order: the model the app pinned at spawn (Preferences), then
// session JSONL evidence from THIS run (catches in-session /model switches),
// then the CLI's configured default. Bare null → renderer shows the agent
// name alone.
ipcMain.handle('agent-current-model', async (_event, { worktreePath, mode, taskId }) => {
  if (!mode || mode === 'shell') return { model: null };
  const config = loadConfig();
  let model = (config.agentModel || {})[mode] || null;
  if (!model && mode === 'claude') {
    const inst = taskId != null ? instances.get(taskId) : null;
    model = currentClaudeSessionModel(
      worktreePath,
      inst ? inst.claudeSessionId : null,
      inst ? inst.spawnTime : null
    ) || claudeDefaultModelFromSettings();
  }
  return { model };
});

// Create worktree from an existing branch
ipcMain.handle('checkout-branch', async (_event, { repoPath, branch, mode, basePath, envVars }) => {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repoPath, stdio: 'pipe' });
  } catch {
    return { error: 'Not a git repository: ' + repoPath };
  }

  const sanitized = branch.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const repoBasename = path.basename(repoPath);
  // Same session-folder layout as create-task: ~/klaussy/sessions/<session>/<repo>.
  const worktreeDir = basePath || path.join(os.homedir(), 'klaussy', 'sessions', sanitized);
  const worktreePath = basePath
    ? path.join(worktreeDir, repoBasename + '-' + sanitized)
    : path.join(worktreeDir, repoBasename);

  if (fs.existsSync(worktreePath)) {
    return { error: 'Worktree directory already exists: ' + worktreePath };
  }

  // Ensure the chosen location exists (git only creates the leaf dir).
  try {
    fs.mkdirSync(worktreeDir, { recursive: true });
  } catch (e) {
    return { error: 'Could not create the worktree location ' + worktreeDir + ': ' + e.message };
  }

  // Freshen the branch from origin before checking it out (non-fatal; also
  // creates the local branch from origin when it doesn't exist yet).
  const freshen = await freshenBranchFromOrigin(repoPath, branch);
  const freshenWarning = freshen.warning;

  try {
    // Check if it's a local branch already
    try {
      execFileSync('git', ['rev-parse', '--verify', branch], { cwd: repoPath, stdio: 'pipe' });
    } catch {
      // If not local, create tracking branch from origin
      execFileSync('git', ['branch', branch, 'origin/' + branch], { cwd: repoPath, stdio: 'pipe' });
    }
    execFileSync('git', ['worktree', 'add', worktreePath, branch], {
      cwd: repoPath, stdio: 'pipe',
    });
  } catch (err) {
    return { error: 'Failed to create worktree: ' + (err.stderr ? err.stderr.toString() : err.message) };
  }

  // Same pre-spawn intel seeding as create-task.
  try { require('../state/repo-intel').syncIntelIntoWorktree(worktreePath); } catch (e) {
    console.warn('[repo-intel] pre-spawn sync failed:', e.message);
  }

  const name = sanitized;
  const result = spawnInWorktree(name, worktreePath, branch, mode || 'claude', null, envVars);
  if (result && !result.error) {
    if (freshenWarning) result.warning = freshenWarning;
    if (freshen.info) result.freshenInfo = freshen.info;
  }
  return result;
});

// Attach to an existing worktree directory
ipcMain.handle('attach-worktree', async (_event, { worktreePath, mode }) => {
  // Validate it's a git worktree / repo
  try {
    execSync('git rev-parse --git-dir', { cwd: worktreePath, stdio: 'pipe' });
  } catch {
    return { error: 'Selected directory is not a git repository or worktree.' };
  }

  // Get branch name for display
  let branch = '';
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: worktreePath,
      stdio: 'pipe',
    }).toString().trim();
  } catch {}

  const name = path.basename(worktreePath);
  try {
    return spawnInWorktree(name, worktreePath, branch, mode || 'claude');
  } catch (err) {
    console.error('[attach-worktree] spawnInWorktree failed:', err);
    return { error: 'Failed to start terminal: ' + (err && err.message || err) };
  }
});

// Browse for a directory (used by the existing worktree tab).
// NOTE: we intentionally do NOT pass a parent window here. A sheet-attached
// NSOpenPanel serializes the selected URL via NSRemoteViewMarshal, which
// requires a round-trip to `com.apple.ScopedBookmarkAgent`. On some machines
// that daemon hangs and the sheet never dismisses (main thread stuck in
// mach_msg → force-quit only). A parentless dialog is a free-floating
// in-process NSOpenPanel and skips that path entirely.
ipcMain.handle('browse-directory', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select existing worktree directory',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Open a plain directory (not a git worktree). Git-dependent panels will
// degrade gracefully because `branch` is empty — auto-fetch and CI polling
// explicitly skip instances without a branch.
ipcMain.handle('open-folder', async (_event, { folderPath, mode }) => {
  if (!folderPath) {
    const result = await dialog.showOpenDialog({
      title: 'Select folder to open',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    folderPath = result.filePaths[0];
  }
  try {
    if (!fs.statSync(folderPath).isDirectory()) {
      return { error: 'Not a directory: ' + folderPath };
    }
  } catch {
    return { error: 'Folder does not exist: ' + folderPath };
  }
  const name = path.basename(folderPath) || 'folder';
  return spawnInWorktree(name, folderPath, '', mode || 'claude');
});

ipcMain.handle('list-tasks', () => {
  return Array.from(instances.values()).map(({ id, name, worktreePath, branch, mode, alive, repoPath }) => ({
    id, name, worktreePath, branch, mode, alive, repoPath,
  }));
});

ipcMain.on('write-terminal', (_event, { id, data, subId }) => {
  const inst = instances.get(id);
  if (!inst) return;
  if (subId !== undefined && subId > 0) {
    const sub = inst.subTerminals.find(s => s.subId === subId);
    if (sub && sub.alive) sub.pty.write(data);
  } else if (inst.alive) {
    inst.pty.write(data);
  }
});

ipcMain.on('resize-terminal', (_event, { id, cols, rows, subId }) => {
  const inst = instances.get(id);
  if (!inst) return;
  if (subId !== undefined && subId > 0) {
    const sub = inst.subTerminals.find(s => s.subId === subId);
    if (sub && sub.alive) { try { sub.pty.resize(cols, rows); } catch {} }
  } else if (inst.alive) {
    try { inst.pty.resize(cols, rows); } catch {}
  }
});

ipcMain.handle('add-sub-terminal', (_event, { taskId, label, mode, initialPrompt }) => {
  const inst = instances.get(taskId);
  if (!inst) return { error: 'Instance not found' };

  const subId = inst.nextSubId++;
  const userShell = defaultShell();

  // An agent mode launches that CLI in a login shell (same recipe as
  // spawnInWorktree in main/state/instances.js). Default is a plain shell.
  let args;
  let session = { release: () => {} };
  let promptFile = null;     // staged-prompt tempfile, removed on exit
  let needsEnter = false;    // codex-style TUIs pre-fill but wait for Enter
  if (isAgentMode(mode)) {
    const config = loadConfig();
    const provider = getProvider(mode);
    const bin = binFor(provider.id, config);
    const consent = ensureWorktreeConsentSync(provider.id, inst.worktreePath);
    if (!consent.allowed) return { cancelled: true };
    // Token-rotation guard: warn before a second concurrent Codex session.
    session = beginSession(provider.id);
    if (!session.ok) return { cancelled: true };
    const model = (config.agentModel || {})[provider.id] || '';
    let agentCmd = provider.buildInteractiveCmd(bin, { trust: consent.trust, model });
    // Seed an initial prompt (Plan/Debug/Review) as the agent's first
    // positional argument rather than typing it in after boot. Passing it at
    // spawn avoids racing the TUI's startup and keeps multi-line prompts intact
    // (typing a multi-line string submits it line-by-line). Mirrors
    // pr-implement-pty: stage the prompt in a tempfile and expand it via
    // $(cat …) so quotes/backticks/newlines need no shell escaping.
    if (initialPrompt && initialPrompt.trim()) {
      try {
        const dir = path.join(os.tmpdir(), 'klaussy-action-prompts');
        fs.mkdirSync(dir, { recursive: true });
        promptFile = path.join(dir, `${taskId}-${subId}-${crypto.randomBytes(4).toString('hex')}.txt`);
        fs.writeFileSync(promptFile, initialPrompt);
        const promptFlag = provider.interactivePromptFlag ? `${provider.interactivePromptFlag} ` : '';
        const quoted = `"$(cat '${promptFile.replace(/'/g, "'\\''")}')"`;
        agentCmd = `${agentCmd} ${promptFlag}${quoted}`;
        needsEnter = !!provider.needsEnterToSubmit;
      } catch (err) {
        console.warn('[add-sub-terminal] failed to stage prompt:', err.message);
        promptFile = null;
      }
    }
    args = shellRunCmdArgs(userShell, agentCmd);
  } else {
    args = shellLoginArgs(userShell);
  }

  const ptyProc = pty.spawn(userShell, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: inst.worktreePath,
    env: { ...process.env, TERM: 'xterm-256color', ...(inst.extraEnv || {}) },
  });

  const sub = { subId, label: label || displayNameFor(mode || 'shell'), pty: ptyProc, alive: true, mode: mode || 'shell' };
  inst.subTerminals.push(sub);

  // codex pre-fills its positional prompt but waits for an Enter to submit
  // (Claude/Gemini auto-run theirs). Nudge it once the TUI is up, with a second
  // attempt for a slow boot. Harmless for agents that already submitted.
  if (needsEnter) {
    const sendEnter = () => { if (sub.alive) { try { ptyProc.write('\r'); } catch {} } };
    setTimeout(sendEnter, 3500);
    setTimeout(sendEnter, 8000);
  }

  ptyProc.onData((data) => {
    sendToTerminalSubscribers(`terminal-data-${taskId}-${subId}`, data);
  });

  ptyProc.onExit(() => {
    sub.alive = false;
    session.release(); // free the concurrency slot (Codex token-rotation guard)
    if (promptFile) { try { fs.unlinkSync(promptFile); } catch {} }
    sendToTerminalSubscribers(`terminal-exit-${taskId}-${subId}`);
  });

  return { subId, label: sub.label };
});

ipcMain.handle('kill-sub-terminal', (_event, { taskId, subId }) => {
  const inst = instances.get(taskId);
  if (!inst) return { error: 'Instance not found' };
  const idx = inst.subTerminals.findIndex(s => s.subId === subId);
  if (idx === -1) return { error: 'Sub-terminal not found' };
  const sub = inst.subTerminals[idx];
  try { sub.pty.kill(); } catch {}
  inst.subTerminals.splice(idx, 1);
  return { ok: true };
});

ipcMain.handle('kill-task', (_event, { id }) => {
  const inst = instances.get(id);
  if (!inst) return { error: 'Instance not found' };

  // Mark BEFORE kill(): pty.kill is async, and the onExit handler checks
  // this flag to skip the Claude→shell auto-convert branch. Without it,
  // killing a Claude task would spawn an orphan shell with no instances
  // entry — nothing could find or stop it after this point.
  inst.killed = true;
  clearIdleTimer(inst);
  stopCIPolling(id);
  try { inst.pty.kill(); } catch {}
  // Kill all sub-terminals
  for (const sub of (inst.subTerminals || [])) {
    try { sub.pty.kill(); } catch {}
  }
  inst.alive = false;

  // Never delete worktrees or branches — only kill the process
  instances.delete(id);
  return { ok: true };
});

// Restart Claude in an existing worktree (after process exit)
ipcMain.handle('restart-task', (_event, { id, cols, rows }) => {
  const inst = instances.get(id);
  if (!inst) return { error: 'Instance not found' };

  // Mark restarting BEFORE kill(): pty.kill is async and the stale exit
  // handler would otherwise race with the new-pty assignment below — in
  // particular if the instance was still in claude mode, the old-pty's
  // onExit would spawn a convert-shell and overwrite inst.pty right after
  // we set it on line below.
  inst.restarting = true;
  try { inst.pty.kill(); } catch {}

  // Resume as the same agent this task was originally running. For Claude we
  // prefer this instance's tracked session id so multiple terminals on one
  // worktree don't collide on the "latest" .jsonl; other providers resume
  // their most recent session in the worktree via their native flag.
  const userShell = defaultShell();
  const config = loadConfig();
  const restartMode = isAgentMode(inst.originalMode) ? inst.originalMode
    : (isAgentMode(inst.mode) ? inst.mode : 'claude');
  const provider = getProvider(restartMode);
  const bin = binFor(provider.id, config);
  // The task already ran this agent, so consent is normally already stored
  // (no re-prompt); we just carry the granted trust flag into the respawn.
  const trust = ensureWorktreeConsentSync(provider.id, inst.worktreePath).trust;
  const model = (config.agentModel || {})[provider.id] || '';

  // Hand off the concurrency slot: free the slot the old (just-killed) process
  // held, then re-acquire for the respawn. Releasing first means a plain
  // restart won't warn — it only warns if *another* Codex task is still live,
  // i.e. the restart would genuinely leave two Codex sessions running. If the
  // user declines that overlap, fall back to a plain shell rather than leaving
  // the task dead.
  if (inst.agentSession) inst.agentSession.release();
  const session = beginSession(provider.id);
  if (!session.ok) {
    inst.restarting = false;
    inst.agentSession = null;
    convertInstanceToShell(inst);
    return { ok: true, downgradedToShell: true };
  }
  inst.agentSession = session;

  let agentCmd;
  if (provider.supportsExactResume) {
    const resumeId = inst.claudeSessionId || findLatestSessionId(inst.worktreePath);
    agentCmd = provider.buildInteractiveCmd(bin, { resumeSessionId: resumeId, trust, model });
    inst.preSpawnSessionIds = snapshotSessionIds(inst.worktreePath);
    inst.claudeSessionId = resumeId || null;
  } else {
    agentCmd = provider.buildInteractiveCmd(bin, { resumeLatest: true, trust, model });
    inst.preSpawnSessionIds = new Set();
    inst.claudeSessionId = null;
  }
  inst.mode = restartMode;
  inst.spawnTime = Date.now();

  const args = shellRunCmdArgs(userShell, agentCmd);
  const ptyProc = pty.spawn(userShell, args, {
    name: 'xterm-256color',
    cols: cols || 120,
    rows: rows || 30,
    cwd: inst.worktreePath,
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  inst.pty = ptyProc;
  inst.alive = true;
  inst.recentOutput = '';
  inst.notifiedIdle = false;
  // New pty is live; clear the restart guard so this one's natural exit
  // (or future restarts) behave normally.
  inst.restarting = false;

  ptyProc.onData((data) => {
    processIdleDetection(inst, data);
    sendToTerminalSubscribers(`terminal-data-${id}`, data);
  });

  // When this agent exits, auto-convert to shell again
  ptyProc.onExit(() => {
    clearIdleTimer(inst);
    session.release(); // free the concurrency slot (Codex token-rotation guard)
    if (isAgentMode(inst.mode)) {
      convertInstanceToShell(inst);
    } else {
      inst.alive = false;
      sendToTerminalSubscribers(`terminal-exit-${id}`);
    }
  });

  return { ok: true };
});

ipcMain.handle('set-notify-enabled', (_event, { id, enabled, kind }) => {
  const inst = instances.get(id);
  if (!inst) return { error: 'Instance not found' };
  // `kind` lets the renderer toggle idle vs CI independently. Default 'idle'
  // matches the legacy single-flag callers.
  const which = kind === 'ci' ? 'ci' : 'idle';
  if (which === 'ci') inst.notifyCIEnabled = enabled;
  else inst.notifyEnabled = enabled;
  const config = loadConfig();
  if (!config.notifyPrefs) config.notifyPrefs = {};
  // Migrate legacy boolean entries to the {idle, ci} shape on first write.
  let pref = config.notifyPrefs[inst.name];
  if (typeof pref !== 'object' || pref === null) {
    pref = { idle: pref !== false, ci: true };
  }
  pref[which] = enabled;
  config.notifyPrefs[inst.name] = pref;
  saveConfig(config);
  return { ok: true };
});

ipcMain.handle('get-notify-enabled', (_event, { id }) => {
  const inst = instances.get(id);
  if (!inst) return { idle: true, ci: true };
  return { idle: inst.notifyEnabled !== false, ci: inst.notifyCIEnabled !== false };
});

ipcMain.handle('rename-task', (_event, { id, newName }) => {
  const inst = instances.get(id);
  if (!inst) return { error: 'Instance not found' };
  inst.name = newName;
  return { ok: true };
});

// ---- Duplicate Task (A6) ----

ipcMain.handle('duplicate-task', async (_event, { id }) => {
  const inst = instances.get(id);
  if (!inst) return { error: 'Instance not found' };

  const config = loadConfig();
  const repoPath = config.repoPath;
  if (!repoPath) return { error: 'No repo configured' };

  const baseName = inst.name + '-copy';
  const sanitized = baseName.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const branch = `task/${sanitized}`;
  const worktreeDir = getWorktreeDir(repoPath);
  const worktreePath = path.join(worktreeDir, sanitized);

  fs.mkdirSync(worktreeDir, { recursive: true });

  // Branch from the same branch as the source
  const sourceBranch = inst.branch || 'main';

  try {
    execFileSync('git', ['worktree', 'add', '-b', branch, worktreePath, sourceBranch], {
      cwd: repoPath,
      stdio: 'pipe',
    });
  } catch (err) {
    return { error: `Failed to create worktree: ${err.message}` };
  }

  const mode = config.defaultProvider || config.defaultMode || 'claude';
  return spawnInWorktree(baseName, worktreePath, branch, mode);
});

ipcMain.handle('list-all-dirty-worktrees', async () => {
  return Promise.all(Array.from(instances.values()).map(collectWorktreeState));
});

ipcMain.handle('get-worktree-state', async (_event, { taskId }) => {
  const task = instances.get(taskId);
  if (!task) return null;
  return collectWorktreeState(task);
});

// E2: Export session transcript
//
// The dialog-selected path is held main-side in `pendingTranscripts` rather
// than round-tripping through the renderer. Previously the renderer could
// hand any path back to `write-transcript` (including /etc/hosts) because
// main had no way to verify the path actually came from a dialog.
const pendingTranscripts = new Map(); // instanceId -> expected file path
ipcMain.handle('export-transcript', async (_event, { id }) => {
  const inst = instances.get(id);
  if (!inst) return { error: 'Instance not found' };

  const result = await dialog.showSaveDialog({
    title: 'Export Session Transcript',
    defaultPath: path.join(app.getPath('documents'), inst.name + '-transcript.txt'),
    filters: [{ name: 'Text', extensions: ['txt'] }, { name: 'Markdown', extensions: ['md'] }],
  });

  if (result.canceled || !result.filePath) return { canceled: true };

  pendingTranscripts.set(id, result.filePath);
  // The transcript content will arrive from the renderer (xterm buffer)
  // via `write-transcript` below — it MUST pass the same id, not the path.
  return { ok: true };
});

ipcMain.handle('write-transcript', (_event, { id, content }) => {
  const expected = pendingTranscripts.get(id);
  if (!expected) return { error: 'No pending transcript for this task' };
  pendingTranscripts.delete(id);
  try {
    fs.writeFileSync(expected, content, 'utf-8');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('pop-out-task', (_event, { id }) => {
  const inst = instances.get(id);
  if (!inst) return { error: 'Instance not found' };

  const popout = new BrowserWindow({
    width: 800,
    height: 600,
    title: `Klaussy \u2014 ${inst.name}`,
    icon: path.join(__dirname, '..', '..', 'icon.icns'),
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  hardenWindow(popout);

  popout.loadFile(path.join(__dirname, '..', '..', 'renderer', 'popout.html'));

  inst.popoutWindows.add(popout);

  popout.webContents.once('did-finish-load', () => {
    popout.webContents.send('popout-init', {
      id: inst.id, name: inst.name,
      worktreePath: inst.worktreePath, branch: inst.branch, mode: inst.mode,
    });
  });

  popout.on('closed', () => {
    inst.popoutWindows.delete(popout);
  });

  return { ok: true };
});

ipcMain.handle('get-task-note', async (_event, { taskName }) => {
  const config = loadConfig();
  return { note: (config.taskNotes && config.taskNotes[taskName]) || '' };
});

ipcMain.handle('set-task-note', async (_event, { taskName, note }) => {
  const config = loadConfig();
  if (!config.taskNotes) config.taskNotes = {};
  config.taskNotes[taskName] = note;
  saveConfig(config);
  return { ok: true };
});
module.exports = {};
