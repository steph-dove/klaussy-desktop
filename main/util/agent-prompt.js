// Stage an initial prompt for an interactive agent CLI so it's delivered at
// spawn — as a positional argument (or the provider's `interactivePromptFlag`)
// rather than typed into the TUI after boot. Typing races the TUI's startup and
// submits multi-line text line-by-line; passing it at spawn keeps it intact.
// The prompt is written to a tempfile and expanded via $(cat …) so quotes,
// backticks, and newlines need no shell escaping.
//
// Shared by spawnInWorktree (cross-agent session-resume handoff) and
// add-sub-terminal (Plan/Debug/Review action prompts).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { isPosixShell } = require('./platform');

// stageInitialPrompt returns { agentCmd, promptFile, needsEnter, pasteText }:
// needsEnter for TUIs that pre-fill but wait for Enter (codex), pasteText for
// those taking no spawn-time prompt at all (kimi).

// PowerShell needs `(Get-Content -Raw …)`: `$(cat 'file')` flattens the
// newlines via $OFS there, defeating the point of staging a multi-line prompt.
function promptFileArg(promptFile, shellPath = null) {
  const usePosix = isPosixShell(shellPath) || process.platform !== 'win32';
  return usePosix
    ? `"$(cat '${promptFile.replace(/'/g, "'\\''")}')"`
    : `(Get-Content -Raw -LiteralPath '${promptFile.replace(/'/g, "''")}')`;
}

// Bracketed paste, not a plain write: it keeps a multi-line prompt one input
// instead of submitting it a line at a time.
function pastePromptInto(ptyProc, text) {
  ptyProc.write(`\x1b[200~${text}\x1b[201~`);
  ptyProc.write('\r');
}

// Waits for the TUI to render, then pastes at most once — a second paste would
// submit the prompt twice. The later delay retries only a write that never landed.
function schedulePromptPaste(ptyProc, text, isStillNeeded, delaysMs = [3500, 8000]) {
  if (!text) return;
  let sent = false;
  for (const ms of delaysMs) {
    setTimeout(() => {
      if (sent || !isStillNeeded()) return;
      try {
        pastePromptInto(ptyProc, text);
        sent = true;
      } catch (err) {
        console.warn('[agent-prompt] prompt paste failed:', err.message);
      }
    }, ms);
  }
}

function stageInitialPrompt(provider, agentCmd, prompt, tag = 'prompt', shellPath = null) {
  if (!prompt || !prompt.trim()) return { agentCmd, promptFile: null, needsEnter: false };
  // kimi's TUI rejects a positional prompt and has no interactive prompt flag,
  // so there is nothing to append — the caller pastes it in after boot.
  if (provider.promptDelivery === 'paste') {
    return { agentCmd, promptFile: null, needsEnter: false, pasteText: prompt };
  }
  try {
    const dir = path.join(os.tmpdir(), 'klaussy-action-prompts');
    fs.mkdirSync(dir, { recursive: true });
    const promptFile = path.join(dir, `${tag}-${crypto.randomBytes(6).toString('hex')}.txt`);
    fs.writeFileSync(promptFile, prompt);
    const promptFlag = provider.interactivePromptFlag ? `${provider.interactivePromptFlag} ` : '';
    const quoted = promptFileArg(promptFile, shellPath);
    return {
      agentCmd: `${agentCmd} ${promptFlag}${quoted}`,
      promptFile,
      needsEnter: !!provider.needsEnterToSubmit,
    };
  } catch (err) {
    console.warn('[agent-prompt] failed to stage initial prompt:', err.message);
    return { agentCmd, promptFile: null, needsEnter: false };
  }
}

module.exports = { stageInitialPrompt, promptFileArg, schedulePromptPaste };
