// Per-(worktree, agent) consent for agents that gate on a workspace-trust /
// file-access decision (Gemini's "trusted folders" today). The first time the
// user runs such an agent in a worktree we show a blocking prompt; the choice
// is remembered per (worktree, agent) so we don't ask again.
//
// Agents without a `worktreeConsent` gate in the registry are always allowed
// with no prompt (Claude/Codex/Copilot handle their own permission models).
//
// This is a general framework: a new gated agent only needs to declare
// `worktreeConsent: { prompt, allowLabel }` and read the returned `trust` flag
// in its command builders.

const { dialog } = require('electron');
const { loadConfig, saveConfig } = require('./config');
const { getProvider } = require('../state/ai-providers');

// config.agentConsent = { "<worktreePath>": { "<agentId>": "allow" | "deny" } }
function getStored(worktreePath, agentId) {
  const c = loadConfig();
  return (c.agentConsent
    && c.agentConsent[worktreePath]
    && c.agentConsent[worktreePath][agentId]) || null;
}

function setStored(worktreePath, agentId, decision) {
  const c = loadConfig();
  if (!c.agentConsent) c.agentConsent = {};
  if (!c.agentConsent[worktreePath]) c.agentConsent[worktreePath] = {};
  c.agentConsent[worktreePath][agentId] = decision;
  saveConfig(c);
}

// Returns { allowed: bool, trust: bool }.
//   - Ungated agent (or no worktree): { allowed: true, trust: false } — no prompt.
//   - Gated agent: prompts once per (worktree, agent); allowed/trust reflect the
//     stored or just-made decision. A blocking dialog (showMessageBoxSync) keeps
//     this usable from the synchronous spawn paths.
function ensureWorktreeConsentSync(agentId, worktreePath) {
  const provider = getProvider(agentId);
  const gate = provider && provider.worktreeConsent;
  if (!gate || !worktreePath) return { allowed: true, trust: false };

  let decision = getStored(worktreePath, agentId);
  if (decision !== 'allow' && decision !== 'deny') {
    const idx = dialog.showMessageBoxSync({
      type: 'question',
      buttons: [gate.allowLabel || 'Allow', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: `Allow ${provider.displayName} in this worktree?`,
      message: `Allow ${provider.displayName} in this worktree?`,
      detail: `${gate.prompt}\n\n${worktreePath}`,
    });
    decision = idx === 0 ? 'allow' : 'deny';
    setStored(worktreePath, agentId, decision);
  }
  return { allowed: decision === 'allow', trust: decision === 'allow' };
}

module.exports = { ensureWorktreeConsentSync, getStored, setStored };
