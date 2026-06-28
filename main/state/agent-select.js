// Agent-selection + repo-intel helpers shared by the streaming-IPC handlers
// (check debug/fix, review, implement, chat). Pulled out of claude-stream-ipc.js
// so handler groups can live in their own modules without duplicating this
// logic. No side effects at require time.
const { isAgentMode } = require('./ai-providers');
const { instances } = require('./instances');
const { loadConfig } = require('../util/config');
const { getRepoIntelBlock, ensureRepoIntel } = require('./repo-intel');
const { prReview } = require('./pr-review');
const { execFileSync } = require('child_process');

function parseChangedFilesFromDiff(diff) {
  const files = new Set();
  if (!diff) return [];
  const lines = diff.split('\n');
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const parts = line.split(' ');
      if (parts.length >= 4) {
        const file = parts[3].slice(2); // strip 'b/'
        files.add(file);
      }
    }
  }
  return [...files];
}

function getTouchedPaths(worktreePath) {
  const paths = new Set();
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: worktreePath, stdio: 'pipe', timeout: 5000 }).toString();
    for (const line of status.split('\n')) {
      if (line.length > 3) {
        const p = line.slice(3).trim();
        if (p) paths.add(p);
      }
    }
    let base = 'main';
    try {
      base = execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], { cwd: worktreePath, stdio: 'pipe', timeout: 2000 }).toString().trim().replace(/^origin\//, '');
    } catch {
      for (const b of ['main', 'master', 'dev']) {
        try {
          execFileSync('git', ['rev-parse', '--verify', b], { cwd: worktreePath, stdio: 'pipe', timeout: 1000 });
          base = b;
          break;
        } catch {}
      }
    }
    const diffNames = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { cwd: worktreePath, stdio: 'pipe', timeout: 5000 }).toString();
    for (const file of diffNames.split('\n')) {
      const trimmed = file.trim();
      if (trimmed) paths.add(trimmed);
    }
  } catch (e) {
    console.warn('[repo-intel] failed to get touched paths via git:', e.message);
  }
  return [...paths];
}

// Repo-intel block formatted for template substitution: surrounded by
// newlines when present, empty when not — the templates' {{REPO_SPECIFIC_CHECKS}}
// slots sit on their own lines either way. Also nudges a (re)generation so a
// repo reviewed before any session was opened gets intel for the NEXT run.
// Pass the target agent: claude in a synced worktree gets the slim graph-only
// block (CLAUDE.md/rules load natively there — re-injecting them pays their
// tokens twice in every prompt).
function repoIntelFor(worktreePath, agentMode) {
  try {
    ensureRepoIntel(worktreePath);
    let touchedPaths = [];
    if (prReview.active && prReview.active.diff) {
      touchedPaths = parseChangedFilesFromDiff(prReview.active.diff);
    }
    if (touchedPaths.length === 0 && worktreePath) {
      touchedPaths = getTouchedPaths(worktreePath);
    }
    const block = getRepoIntelBlock(worktreePath, agentMode, touchedPaths);
    return block ? '\n' + block + '\n' : '';
  } catch (e) {
    console.warn('[repo-intel] substitution failed:', e.message);
    return '';
  }
}

// The editor/diff AI features (inline edit, completion, explain, commit
// message) and the read-only PR-review surfaces run on the user's chosen
// default agent.
function defaultAgentProvider() {
  const c = loadConfig();
  return c.defaultProvider || c.defaultMode || 'claude';
}

// Honor a renderer-chosen agent (from a split-button's agent picker) when it's
// a valid agent id; otherwise use the surface's default resolution.
function pickProvider(passed, fallback) {
  return isAgentMode(passed) ? passed : fallback;
}

// Implement follows the agent of the task you're working this PR in: prefer a
// live agent task on the PR's worktree (its current mode, or the original agent
// if it has since converted to a shell), and fall back to the default agent
// when no task is open on that worktree.
function agentForWorktree(worktreePath) {
  for (const [, inst] of instances) {
    if (inst.worktreePath !== worktreePath) continue;
    if (isAgentMode(inst.mode)) return inst.mode;
    if (isAgentMode(inst.originalMode)) return inst.originalMode;
  }
  return defaultAgentProvider();
}

module.exports = { repoIntelFor, defaultAgentProvider, pickProvider, agentForWorktree };
