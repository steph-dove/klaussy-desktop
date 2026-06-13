// Agent-selection + repo-intel helpers shared by the streaming-IPC handlers
// (check debug/fix, review, implement, chat). Pulled out of claude-stream-ipc.js
// so handler groups can live in their own modules without duplicating this
// logic. No side effects at require time.
const { isAgentMode } = require('./ai-providers');
const { instances } = require('./instances');
const { loadConfig } = require('../util/config');
const { getRepoIntelBlock, ensureRepoIntel } = require('./repo-intel');

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
    const block = getRepoIntelBlock(worktreePath, agentMode);
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
