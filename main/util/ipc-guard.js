// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// One check in front of every ipcMain.handle (the invoke-style handlers; the
// few ipcMain.on listeners take terminal ids, not paths): an argument that names a
// workspace (worktreePath, repoPath, ...) must be one the app already knows
// (path-gate's knownWorkspace). Without it, each handler trusted the page to
// pass a real worktree, and most then used that path as the root for their
// own path checks, as a git cwd, or as the cwd of a headless agent run, so a
// script injected into the page could read ~/.ssh or write ~/.zshrc by
// naming $HOME as its "worktree".
//
// Installed before any handler registers (main.js), so it wraps every one,
// including the ones the browser-mode helper adds and any a test re-registers.

const { ipcMain } = require('electron');
const { knownWorkspace } = require('./path-gate');

// Argument fields that name a workspace. (add-sub-terminal's `cwd` is relative
// to its task's worktree and confined there by dirUnder, so it isn't one.)
const WORKSPACE_KEYS = ['worktreePath', 'repoPath', 'worktreeHint', 'projectPath'];
// Argument fields holding a list of them (delete-session runs git in each).
const WORKSPACE_LIST_KEYS = ['worktreePaths'];

// Channels whose job is to bring in a workspace the person just picked: the
// New Worktree dialog's source repo can come from Browse, drag-and-drop or
// recents without being added as a project first. They are visible (each
// creates a worktree and opens a tab, or fills that dialog), which is the check.
const INTRODUCES_WORKSPACE = new Set([
  'attach-worktree',
  'create-task',
  'checkout-branch',
  'list-branches',
  'suggest-worktree-locations',
]);

// The reason a call is refused, or null.
function refusal(channel, args, isKnown = knownWorkspace) {
  if (INTRODUCES_WORKSPACE.has(channel)) return null;
  const a = args[0];
  if (!a || typeof a !== 'object') return null;
  for (const key of WORKSPACE_KEYS) {
    const v = a[key];
    if (v == null || v === '') continue;
    if (typeof v !== 'string' || !isKnown(v)) return `${key} isn't a project or worktree Maussian knows`;
  }
  for (const key of WORKSPACE_LIST_KEYS) {
    const list = a[key];
    if (list == null) continue;
    if (!Array.isArray(list) || list.some((v) => typeof v !== 'string' || !isKnown(v))) {
      return `${key} names something that isn't a project or worktree Maussian knows`;
    }
  }
  return null;
}

let installed = false;
function install(target = ipcMain) {
  if (installed) return;
  installed = true;
  const handle = target.handle.bind(target);
  target.handle = (channel, fn) => handle(channel, (event, ...args) => {
    const why = refusal(channel, args);
    if (why) {
      console.warn(`[ipc-guard] refused ${channel}: ${why}`);
      throw new Error(why);
    }
    return fn(event, ...args);
  });
}

module.exports = { install, refusal, WORKSPACE_KEYS, WORKSPACE_LIST_KEYS, INTRODUCES_WORKSPACE };
