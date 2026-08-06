require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const { stageInitialPrompt, schedulePromptPaste } = require('../../main/util/agent-prompt');

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

function fakePty(failTimes = 0) {
  const writes = [];
  let failsLeft = failTimes;
  return {
    writes,
    write(data) {
      if (failsLeft > 0) { failsLeft -= 1; throw new Error('pty gone'); }
      writes.push(data);
    },
  };
}

test('paste-delivery providers get no prompt on the command line', () => {
  // kimi's TUI rejects a positional prompt, so appending one would kill the tab.
  const staged = stageInitialPrompt({ promptDelivery: 'paste' }, 'kimi', 'do the thing');
  assert.equal(staged.agentCmd, 'kimi');
  assert.equal(staged.promptFile, null);
  assert.equal(staged.needsEnter, false);
  assert.equal(staged.pasteText, 'do the thing');
});

test('arg-delivery providers keep staging the prompt as an argument', () => {
  // Regression guard: the paste branch must not divert Claude/Codex/Gemini.
  const staged = stageInitialPrompt({}, 'claude', 'do the thing');
  assert.equal(staged.pasteText, undefined);
  assert.ok(staged.promptFile, 'expected a staged tempfile');
  assert.ok(staged.agentCmd.startsWith('claude '), staged.agentCmd);
  require('node:fs').unlinkSync(staged.promptFile);
});

test('an empty prompt stages nothing, paste provider or not', () => {
  for (const provider of [{}, { promptDelivery: 'paste' }]) {
    const staged = stageInitialPrompt(provider, 'kimi', '   ');
    assert.equal(staged.agentCmd, 'kimi');
    assert.equal(staged.promptFile, null);
    assert.equal(staged.pasteText, undefined);
  }
});

test('schedulePromptPaste wraps the prompt in a bracketed paste, then submits', (t) => {
  // Bracketed paste is what stops a multi-line prompt submitting line-by-line.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pty = fakePty();
  schedulePromptPaste(pty, 'line one\nline two', () => true);

  assert.deepEqual(pty.writes, [], 'must wait for the TUI to render');
  t.mock.timers.tick(3500);
  assert.deepEqual(pty.writes, [`${PASTE_START}line one\nline two${PASTE_END}`, '\r']);
});

test('schedulePromptPaste fires once even though two delays are armed', (t) => {
  // A second paste would submit the same prompt twice.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pty = fakePty();
  schedulePromptPaste(pty, 'hello', () => true);

  t.mock.timers.tick(8000);
  assert.equal(pty.writes.length, 2, 'expected exactly one paste + one Enter');
});

test('schedulePromptPaste retries a write that never landed', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pty = fakePty(1); // first write throws, as it does on a pty that died
  schedulePromptPaste(pty, 'hello', () => true);

  t.mock.timers.tick(3500);
  assert.deepEqual(pty.writes, [], 'first attempt threw');
  t.mock.timers.tick(4500);
  assert.deepEqual(pty.writes, [`${PASTE_START}hello${PASTE_END}`, '\r']);
});

test('schedulePromptPaste skips a PTY that is gone', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pty = fakePty();
  schedulePromptPaste(pty, 'hello', () => false);

  t.mock.timers.tick(8000);
  assert.deepEqual(pty.writes, []);
});

test('schedulePromptPaste with no text never touches the PTY', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pty = fakePty();
  schedulePromptPaste(pty, null, () => {
    throw new Error('liveness must not be consulted when there is nothing to send');
  });

  t.mock.timers.tick(8000);
  assert.deepEqual(pty.writes, []);
});
