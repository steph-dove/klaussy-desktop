// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Claude has no interactive flag to skip its folder-trust dialog, so trust is recorded in its own config instead.

const fs = require('fs');
const os = require('os');
const path = require('path');

function claudeConfigPath(env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR;
  return dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

// Claude keys projects by the cwd it sees: the resolved path on macOS, forward slashes on Windows.
function trustKeys(dir) {
  const keys = new Set([dir]);
  try { keys.add(fs.realpathSync(dir)); } catch { /* missing dir: keep the given path */ }
  for (const k of [...keys]) keys.add(k.replace(/\\/g, '/'));
  return [...keys];
}

// Never creates Claude's config and never rewrites one it can't parse.
function trustClaudeFolder(dir, { configPath = claudeConfigPath() } = {}) {
  if (!dir) return { trusted: false, reason: 'no folder' };
  let raw;
  let mode;
  try {
    // Renaming over a dotfile-manager symlink would replace it with a plain file.
    configPath = fs.realpathSync(configPath);
    raw = fs.readFileSync(configPath, 'utf-8');
    mode = fs.statSync(configPath).mode & 0o777;
  } catch {
    return { trusted: false, reason: 'no Claude config' };
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    return { trusted: false, reason: 'Claude config is not valid JSON' };
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { trusted: false, reason: 'Claude config is not an object' };
  }
  const projects = config.projects && typeof config.projects === 'object' && !Array.isArray(config.projects)
    ? config.projects : {};
  const keys = trustKeys(dir);
  const pending = keys.filter((k) => !(projects[k] && projects[k].hasTrustDialogAccepted === true));
  if (!pending.length) return { trusted: true, already: true };

  for (const k of pending) {
    const entry = projects[k] && typeof projects[k] === 'object' ? projects[k] : {};
    projects[k] = { ...entry, hasTrustDialogAccepted: true };
  }
  config.projects = projects;

  const tmp = `${configPath}.klaussy-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode });
    fs.renameSync(tmp, configPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    return { trusted: false, reason: `write failed: ${err.message}` };
  }
  return { trusted: true, already: false };
}

// Stored consent only, so spawning a terminal never pops the consent dialog.
function trustIfRepoAllowed(worktreePath, { getStoredConsent = require('./worktree-permissions').getStoredConsent, trust = trustClaudeFolder } = {}) {
  if (getStoredConsent(worktreePath) !== 'allow') return { trusted: false, reason: 'no stored consent' };
  const r = trust(worktreePath);
  if (!r.trusted) console.warn(`[claude-trust] could not pre-trust ${worktreePath}: ${r.reason}`);
  return r;
}

// Claude draws the dialog with cursor moves instead of spaces, so the words can arrive run together.
const TRUST_PROMPT = /I\s*trust\s*this\s*folder/i;
const ANSI = /\x1b\[[0-9;?<>=]*[A-Za-z~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]/g;

// Only the tail counts: the dialog must be the last thing drawn, not an echoed prompt quoting it.
function sawTrustPrompt(ptyOutput) {
  return TRUST_PROMPT.test(String(ptyOutput || '').slice(-4000).replace(ANSI, ''));
}

module.exports = { claudeConfigPath, trustClaudeFolder, trustIfRepoAllowed, sawTrustPrompt };
