require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyDecision, applyText, isAllowed } = require('../../main/util/chat-reply');
const registry = require('../../main/util/approval-registry');

test('an empty allow-list denies everyone', () => {
  // The dangerous default would be "unset means anyone"; assert it is not.
  assert.equal(isAllowed('U123', []), false);
  assert.equal(isAllowed('U123', undefined), false);
  assert.equal(isAllowed('U123', null), false);
});

test('only listed ids are allowed', () => {
  assert.equal(isAllowed('U123', ['U123']), true);
  assert.equal(isAllowed('U999', ['U123']), false);
  // Discord ids arrive as numbers in some payloads; compare as strings.
  assert.equal(isAllowed(123456, ['123456']), true);
});

test('a click from a non-allow-listed user never redeems the token', () => {
  registry._reset();
  const token = registry.issue(1, 'shell-exec');
  const res = applyDecision({ token, decision: 'approve', userId: 'U999', allowList: ['U123'] });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-allowed');
  // The token must survive so the rightful approver can still use it.
  assert.equal(registry.redeem(token).ok, true, 'token was not consumed');
});

test('an expired token reports expiry rather than acting', () => {
  registry._reset();
  const token = registry.issue(1, 'tool', { ttlMs: -1 });
  const res = applyDecision({ token, decision: 'approve', userId: 'U1', allowList: ['U1'] });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'expired');
  assert.match(res.message, /expired/i);
});

test('a second click on a consumed token is refused', () => {
  registry._reset();
  const token = registry.issue(999999, 'tool'); // no such live session
  applyDecision({ token, decision: 'approve', userId: 'U1', allowList: ['U1'] });
  const again = applyDecision({ token, decision: 'approve', userId: 'U1', allowList: ['U1'] });
  assert.equal(again.ok, false);
  assert.match(again.message, /already answered/i);
});

test('a click for a session that is gone fails cleanly', () => {
  registry._reset();
  const token = registry.issue(999999, 'tool');
  const res = applyDecision({ token, decision: 'approve', userId: 'U1', allowList: ['U1'] });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'gone');
});

test('text replies honour the allow-list and reject empty input', () => {
  assert.equal(applyText({ taskId: 1, text: 'hi', userId: 'U9', allowList: ['U1'] }).reason, 'not-allowed');
  assert.equal(applyText({ taskId: 1, text: '   ', userId: 'U1', allowList: ['U1'] }).reason, 'empty');
});

// After an agent exits, convertInstanceToShell reuses the same instance id and
// marks it alive with a login shell attached. Routing a reply there would run
// the text as a shell command, so a converted tab must look dead to chat.
test('a session converted to a shell no longer accepts chat input', () => {
  const { instances } = require('../../main/state/instances');
  const written = [];
  instances.set(4242, {
    id: 4242, alive: true, mode: 'shell', originalMode: 'claude',
    pty: { write: (d) => written.push(d) },
  });
  try {
    const res = applyText({ taskId: 4242, text: 'rm -rf /', userId: 'U1', allowList: ['U1'] });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'gone');
    assert.deepEqual(written, [], 'nothing reached the shell');
  } finally {
    instances.delete(4242);
  }
});

test('a live agent session does accept chat input', () => {
  const { instances } = require('../../main/state/instances');
  const written = [];
  instances.set(4243, {
    id: 4243, alive: true, mode: 'claude', originalMode: 'claude',
    pty: { write: (d) => written.push(d) },
  });
  try {
    const res = applyText({ taskId: 4243, text: 'proceed', userId: 'U1', allowList: ['U1'] });
    assert.equal(res.ok, true);
    assert.ok(written.join('').includes('proceed'), 'text reached the agent');
  } finally {
    instances.delete(4243);
  }
});

// A session's second agent runs as a tab on the same task. Answering what it
// asked used to write to the task's main agent, which replied instead — leaving
// the tab that asked the question still sitting at its prompt.
test('a reply to a second agent reaches that agent, not the one owning the task', () => {
  const { instances } = require('../../main/state/instances');
  const main = [];
  const sub = [];
  instances.set(4244, {
    id: 4244, alive: true, mode: 'claude', originalMode: 'claude',
    pty: { write: (d) => main.push(d) },
    subTerminals: [{ subId: 1, alive: true, mode: 'antigravity', pty: { write: (d) => sub.push(d) } }],
  });
  try {
    const res = applyText({ taskId: '4244:1', text: 'mars', userId: 'U1', allowList: ['U1'] });
    assert.equal(res.ok, true);
    assert.ok(sub.join('').includes('mars'), 'the agent that asked got the answer');
    assert.deepEqual(main, [], 'the task’s own agent was not answered for it');
  } finally {
    instances.delete(4244);
  }
});

test('a reply to a tab that has closed reaches nothing', () => {
  const { instances } = require('../../main/state/instances');
  instances.set(4245, {
    id: 4245, alive: true, mode: 'claude', originalMode: 'claude',
    pty: { write: () => {} },
    subTerminals: [{ subId: 1, alive: false, mode: 'antigravity', pty: { write: () => {} } }],
  });
  try {
    assert.equal(applyText({ taskId: '4245:1', text: 'hi', userId: 'U1', allowList: ['U1'] }).reason, 'gone');
    assert.equal(applyText({ taskId: '4245:9', text: 'hi', userId: 'U1', allowList: ['U1'] }).reason, 'gone',
      'and neither does one to a tab that never existed');
  } finally {
    instances.delete(4245);
  }
});

test('control characters cannot escape bracketed paste', () => {
  const { sanitizeForPaste } = require('../../main/util/chat-reply');
  // A literal ESC would close paste mode early and leave the rest as keystrokes.
  const out = sanitizeForPaste('safe\x1b[201~rm -rf /\x07');
  assert.ok(!out.includes('\x1b'), 'ESC stripped');
  assert.ok(!out.includes('\x07'), 'BEL stripped');
  assert.equal(out, 'safe[201~rm -rf /');
  // Ordinary whitespace in a pasted snippet survives.
  assert.equal(sanitizeForPaste('a\tb\nc'), 'a\tb\nc');
});

// The bug this covers: Claude Code asks with a numbered menu, so the 'y' that
// answers a (y/n) prompt does nothing and the agent just sits there.
test('a numbered menu is answered with its digit, not y', () => {
  const { keysForPrompt } = require('../../main/util/chat-reply');
  const claudeMenu = [
    'Do you want to proceed?',
    '❯ 1. Yes',
    '  2. Yes, and don\'t ask again for Bash commands',
    '  3. No, and tell Claude what to do differently',
  ].join('\n');
  const keys = keysForPrompt(claudeMenu);
  assert.equal(keys.approveKeys, '1');
  assert.equal(keys.rejectKeys, '3');
  assert.ok(!keys.approveKeys.includes('\r'), 'a menu selects on the digit alone');
});

test('a y/n prompt still gets y/n with Enter', () => {
  const { keysForPrompt } = require('../../main/util/chat-reply');
  const keys = keysForPrompt('Overwrite the file? (y/n)');
  assert.equal(keys.approveKeys, 'y\r');
  assert.equal(keys.rejectKeys, 'n\r');
});

test('a menu with no explicit No rejects with escape', () => {
  const { keysForPrompt } = require('../../main/util/chat-reply');
  const keys = keysForPrompt('Proceed?\n 1. Yes\n 2. Yes, always');
  assert.equal(keys.approveKeys, '1');
  assert.equal(keys.rejectKeys, '\x1b');
});

test('the decided keystrokes are what actually reach the pty', () => {
  registry._reset();
  const { instances } = require('../../main/state/instances');
  const written = [];
  instances.set(5150, {
    id: 5150, alive: true, mode: 'claude', originalMode: 'claude',
    pty: { write: (d) => written.push(d) },
  });
  try {
    const token = registry.issue(5150, 'Bash', { approveKeys: '1', rejectKeys: '3' });
    const res = applyDecision({ token, decision: 'approve', userId: 'U1', allowList: ['U1'] });
    assert.equal(res.ok, true);
    assert.deepEqual(written, ['1'], 'the menu digit, not "y\\r"');
  } finally {
    instances.delete(5150);
  }
});

// A live prompt that matched no phrase-based pattern and ran past the old
// detection window.
const HOTDOG_PROMPT = [
  'Is a hot dog a sandwich?',
  '',
  '❯ 1. Yes',
  "   Meat in a bread carrier. The bun's hinge is an implementation detail, not a category boundary.",
  '  2. No',
  '   A sandwich needs two separate slices. One continuous bun makes it its own thing entirely.',
  '  3. Type something.',
  '  4. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

test('a live selection prompt is recognised as waiting on the user', () => {
  const { APPROVAL_PROMPT_PATTERNS } = require('../../main/state/instances');
  assert.ok(
    APPROVAL_PROMPT_PATTERNS.some((p) => p.test(HOTDOG_PROMPT)),
    'the selection footer is the signal, not the wording of the question',
  );
});

test('a live selection prompt maps Yes/No to its digits', () => {
  const { keysForPrompt } = require('../../main/util/chat-reply');
  const keys = keysForPrompt(HOTDOG_PROMPT);
  assert.equal(keys.approveKeys, '1');
  assert.equal(keys.rejectKeys, '2');
});

test('the buffer holds a whole menu, not just its footer', () => {
  const { ROLLING_BUFFER_SIZE } = require('../../main/state/instances');
  assert.ok(ROLLING_BUFFER_SIZE >= HOTDOG_PROMPT.length,
    `buffer ${ROLLING_BUFFER_SIZE} must fit a ${HOTDOG_PROMPT.length}-char prompt`);
});

test('every menu option becomes a choice, not just Yes/No', () => {
  const { parsePromptOptions } = require('../../main/util/chat-reply');
  const opts = parsePromptOptions(HOTDOG_PROMPT).options;
  assert.deepEqual(opts.map((o) => o.key), ['1', '2', '3', '4']);
  assert.equal(opts[0].label, 'Yes');
  assert.equal(opts[3].label, 'Chat about this');
});

test('a menu with no yes/no is still fully answerable', () => {
  const { parsePromptOptions, keysForPrompt } = require('../../main/util/chat-reply');
  const prompt = 'How should I integrate?\n 1. Rebase\n 2. Merge\n 3. Cancel\nEnter to select';
  assert.deepEqual(parsePromptOptions(prompt).options.map((o) => o.label), ['Rebase', 'Merge', 'Cancel']);
  // The old approve/reject path would have sent 'y' here, which does nothing.
  assert.equal(keysForPrompt(prompt).approveKeys, 'y\r');
});

test('prose that happens to be numbered is not turned into buttons', () => {
  const { parsePromptOptions } = require('../../main/util/chat-reply');
  assert.deepEqual(parsePromptOptions('I did 3 things. 1.5 seconds elapsed.\nNo menu here.\nEnter to select').options, []);
});

test('a repainting TUI does not produce duplicate options', () => {
  const { parsePromptOptions } = require('../../main/util/chat-reply');
  const repainted = '1. Yes\n2. No\n1. Yes\n2. No\n1. Yes\n2. No\nEnter to select';
  assert.deepEqual(parsePromptOptions(repainted).options.map((o) => o.key), ['1', '2']);
});

test('long menus are capped so the message stays readable', () => {
  const { parsePromptOptions, MAX_OPTIONS } = require('../../main/util/chat-reply');
  const many = Array.from({ length: 12 }, (_, i) => `${i + 1}. Option ${i + 1}`).join('\n') + '\nEnter to select';
  const long = parsePromptOptions(many);
  assert.equal(long.options.length, MAX_OPTIONS);
  assert.equal(long.truncated, true);

  // Exactly at the cap is a complete menu, so claiming more exist would be a lie.
  const exact = Array.from({ length: MAX_OPTIONS }, (_, i) => `${i + 1}. Option ${i + 1}`).join('\n') + '\nEnter to select';
  assert.equal(parsePromptOptions(exact).truncated, false);
});

test('a toggle prompt offers no buttons rather than pressing one key', () => {
  const { isMultiSelect } = require('../../main/util/chat-reply');
  assert.equal(isMultiSelect('Pick files\n 1. a\n 2. b\nSpace to toggle · Enter to confirm'), true);
  assert.equal(isMultiSelect(HOTDOG_PROMPT), false);
});

test('a choice can only press an option that was offered', () => {
  registry._reset();
  const { applyChoice } = require('../../main/util/chat-reply');
  const { instances } = require('../../main/state/instances');
  const written = [];
  instances.set(6161, {
    id: 6161, alive: true, mode: 'claude', originalMode: 'claude',
    pty: { write: (d) => written.push(d) },
  });
  try {
    const options = [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }];
    const bad = registry.issue(6161, 'q', { options });
    // '9' was never on screen, so a crafted click must not reach the terminal.
    const refused = applyChoice({ token: bad, key: '9', userId: 'U1', allowList: ['U1'] });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'unknown-option');
    assert.deepEqual(written, []);

    const token = registry.issue(6161, 'q', { options });
    const ok = applyChoice({ token, key: '2', userId: 'U1', allowList: ['U1'] });
    assert.equal(ok.ok, true);
    assert.deepEqual(written, ['2']);
    assert.match(ok.message, /No/);
  } finally {
    instances.delete(6161);
  }
});

const QUIZ = [
  'Pop Quiz — 5 questions, mixed bag. No googling.',
  '',
  "1. What's the only mammal that can't jump?",
  '2. In JavaScript, what does typeof NaN return?',
  '3. Which country has the most time zones?',
  '4. What year did the first email get sent?',
  "5. A byte is 8 bits. What's a nibble?",
  '',
  "Give me your answers and I'll grade them.",
].join('\n');

test('a numbered list with no selection UI yields no buttons', () => {
  const { parsePromptOptions } = require('../../main/util/chat-reply');
  assert.deepEqual(parsePromptOptions(QUIZ).options, []);
});

test('a stale footer elsewhere in the buffer cannot capture later prose', () => {
  const { parsePromptOptions } = require('../../main/util/chat-reply');
  const older = 'Pick one\n 1. Alpha\n 2. Beta\nEnter to select · Esc to cancel';
  const buffer = older + '\n\n' + QUIZ;
  const opts = parsePromptOptions(buffer).options;
  assert.deepEqual(opts.map((o) => o.label), ['Alpha', 'Beta'],
    'only the real menu, never the quiz questions');
});

test('a real menu is still parsed through its footer', () => {
  const { parsePromptOptions } = require('../../main/util/chat-reply');
  assert.deepEqual(
    parsePromptOptions(HOTDOG_PROMPT).options.map((o) => o.key),
    ['1', '2', '3', '4'],
  );
});

// "to navigate" appears in ordinary prose, so matching it as a menu footer moved
// the parse window onto a plain list and turned it into buttons.
test('prose containing navigation words is not mistaken for a menu footer', () => {
  const { parsePromptOptions } = require('../../main/util/chat-reply');
  const prose = [
    'Esc to cancel',
    '',
    'Here is the plan:',
    '1. Read the docs',
    '2. Refactor the parser',
    '3. Ship it, then use the sidebar to navigate the codebase',
  ].join('\n');
  assert.deepEqual(parsePromptOptions(prose).options, []);
});

// Regression: reading only the last footer found zero options, so a six-option
// question fell back to Approve/Reject.
test('a menu is found even when a later footer has only repaint noise above it', () => {
  const { parsePromptOptions } = require('../../main/util/chat-reply');
  const menu = ['❯ 1. Audit CSS', '  2. Review spec', '  3. Commit', 'Enter to select · Esc to cancel'].join('\n');
  const noise = Array.from({ length: 35 }, (_, i) => 'fragment line ' + i).join('\n');
  const buffer = menu + '\n' + noise + '\nEnter to select · Esc to cancel';
  assert.deepEqual(parsePromptOptions(buffer).options.map((o) => o.key), ['1', '2', '3']);
});

// Some TUIs print "esc to cancel" as a permanent idle footer, so the footer
// alone flagged an approval with no question and no options — which then fell
// through to pasting the whole screen.
test('a footer only means a menu when options sit above it', () => {
  const { hasSelectionFooter } = require('../../main/util/chat-reply');
  assert.equal(hasSelectionFooter('Pick one\n 1. Alpha\n 2. Beta\nEnter to select'), true);
  assert.equal(hasSelectionFooter('⋮ Generating...\nesc to cancel\nGemini 3.6 Flash'), false);
  assert.equal(hasSelectionFooter('Overwrite? (y/n)'), false);
});

// The approval alert carries the question, not the screen it came from — the
// mirrored turn already delivered that, which is what produced two messages.
test('the question is read off a menu, without the TUI panel label', () => {
  const { parsePromptQuestion } = require('../../main/util/chat-reply');
  const screen = [
    '□ Next step',
    'You have uncommitted work. What should I do with it?',
    '❯ 1. Review the diff first',
    '  2. Commit and open a PR',
    'Enter to select · Esc to cancel',
  ].join('\n');
  const q = parsePromptQuestion(screen);
  assert.equal(q, 'You have uncommitted work. What should I do with it?');
  assert.doesNotMatch(q, /Next step/, 'the panel label is chrome');
});

test('a prompt with no question above its options yields nothing', () => {
  const { parsePromptQuestion } = require('../../main/util/chat-reply');
  assert.equal(parsePromptQuestion('1. Yes\n2. No\nEnter to select'), '');
  assert.equal(parsePromptQuestion('no menu here'), '');
});
