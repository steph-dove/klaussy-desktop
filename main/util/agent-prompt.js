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

// Returns { agentCmd, promptFile, needsEnter }:
//   agentCmd  — the command with the staged prompt appended (or unchanged if no
//               prompt / staging failed)
//   promptFile — tempfile path to unlink on PTY exit (null if nothing staged)
//   needsEnter — true for TUIs (codex) that pre-fill but wait for an Enter to
//               submit; the caller nudges the PTY with '\r' once it's up.
function stageInitialPrompt(provider, agentCmd, prompt, tag = 'prompt') {
  if (!prompt || !prompt.trim()) return { agentCmd, promptFile: null, needsEnter: false };
  try {
    const dir = path.join(os.tmpdir(), 'klaussy-action-prompts');
    fs.mkdirSync(dir, { recursive: true });
    const promptFile = path.join(dir, `${tag}-${crypto.randomBytes(6).toString('hex')}.txt`);
    fs.writeFileSync(promptFile, prompt);
    const promptFlag = provider.interactivePromptFlag ? `${provider.interactivePromptFlag} ` : '';
    const quoted = `"$(cat '${promptFile.replace(/'/g, "'\\''")}')"`;
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

module.exports = { stageInitialPrompt };
