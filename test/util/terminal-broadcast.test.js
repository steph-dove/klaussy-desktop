require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  subscribeTerminalChannel, sendToTerminalSubscribers, flushTerminalOutput,
} = require('../../main/state/instances');

function fakeWebContents() {
  const received = [];
  return {
    received,
    send: (channel, ...args) => received.push([channel, ...args]),
    isDestroyed: () => false,
    once: () => {},
  };
}

// The coalescer flushes at the end of the event-loop turn.
const nextTurn = () => new Promise((r) => setImmediate(r));

test('output pushed just before an exit reaches the window before the exit', () => {
  const wc = fakeWebContents();
  subscribeTerminalChannel('terminal-data-901', wc);
  subscribeTerminalChannel('terminal-exit-901', wc);

  sendToTerminalSubscribers('terminal-data-901', 'last ');
  sendToTerminalSubscribers('terminal-data-901', 'words');
  sendToTerminalSubscribers('terminal-exit-901', 0);

  assert.deepEqual(wc.received, [['terminal-data-901', 'last words'], ['terminal-exit-901', 0]]);
});

test('a sub-terminal exit flushes its own data channel first', () => {
  const wc = fakeWebContents();
  subscribeTerminalChannel('terminal-data-902-1', wc);
  subscribeTerminalChannel('terminal-exit-902-1', wc);

  sendToTerminalSubscribers('terminal-data-902-1', '$ exit\r\n');
  sendToTerminalSubscribers('terminal-exit-902-1');

  assert.deepEqual(wc.received, [['terminal-data-902-1', '$ exit\r\n'], ['terminal-exit-902-1']]);
});

test('output from before anyone subscribed replays ahead of newer output', async () => {
  sendToTerminalSubscribers('terminal-data-903', '\x1b[?1049h');
  await nextTurn();

  const wc = fakeWebContents();
  sendToTerminalSubscribers('terminal-data-903', 'prompt> ');
  subscribeTerminalChannel('terminal-data-903', wc);
  await nextTurn();

  assert.deepEqual(wc.received, [['terminal-data-903', '\x1b[?1049h'], ['terminal-data-903', 'prompt> ']]);
});

test('flushTerminalOutput delivers pending output synchronously', () => {
  const wc = fakeWebContents();
  subscribeTerminalChannel('terminal-data-904', wc);

  sendToTerminalSubscribers('terminal-data-904', 'Goodbye!');
  assert.deepEqual(wc.received, []);
  flushTerminalOutput(904);
  assert.deepEqual(wc.received, [['terminal-data-904', 'Goodbye!']]);
});

test('idle detection sees each batch once, after the flush', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { instances, clearIdleTimer } = require('../../main/state/instances');
  const inst = { id: 905, mode: 'claude', alive: true, name: 'idle-test', worktreePath: '/wt/idle', recentOutput: '' };
  instances.set(905, inst);
  try {
    sendToTerminalSubscribers('terminal-data-905', 'Reading ');
    sendToTerminalSubscribers('terminal-data-905', 'plan.md');
    assert.equal(inst.recentOutput, '', 'nothing is scanned before the batch flushes');
    await nextTurn();
    assert.equal(inst.recentOutput, 'Reading plan.md');
  } finally {
    clearIdleTimer(inst);
    instances.delete(905);
  }
});

test('a converted shell is not run through idle detection', async () => {
  const { instances } = require('../../main/state/instances');
  const inst = { id: 906, mode: 'shell', alive: true, recentOutput: '' };
  instances.set(906, inst);
  try {
    sendToTerminalSubscribers('terminal-data-906', '$ ls\r\n');
    await nextTurn();
    assert.equal(inst.recentOutput, '');
  } finally {
    instances.delete(906);
  }
});
