const test = require('node:test');
const assert = require('node:assert/strict');
const { agentExitAction } = require('../../main/util/agent-exit');

const live = { isCurrentPty: true, isAgent: true, quitting: false, killed: false, restarting: false };

test('a natural agent exit converts to shell', () => {
  assert.equal(agentExitAction(live), 'convert');
});

test('a stale pty is ignored even when everything else says convert', () => {
  // The restart race: the old pty exits after inst.pty was reassigned, and
  // converting here would clobber the just-restarted agent.
  assert.equal(agentExitAction({ ...live, isCurrentPty: false }), 'ignore');
});

test('the current pty exiting while a restart is in flight tears down, not convert', () => {
  // kill() is async, so the old pty can exit before inst.pty is reassigned —
  // isCurrentPty is still true, and only the restarting flag stops the convert.
  assert.equal(agentExitAction({ ...live, restarting: true }), 'exit');
});

test('quitting tears down instead of spawning a shell during shutdown', () => {
  assert.equal(agentExitAction({ ...live, quitting: true }), 'exit');
});

test('a killed task tears down instead of orphaning a shell', () => {
  assert.equal(agentExitAction({ ...live, killed: true }), 'exit');
});

test('a plain shell (non-agent) exit tears down', () => {
  assert.equal(agentExitAction({ ...live, isAgent: false }), 'exit');
});
