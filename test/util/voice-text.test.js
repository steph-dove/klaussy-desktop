const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeDictation, normalize, matchCommand, parsePrRequest, pickPr } = require('../../renderer/voice-text');

const noop = () => {};
const PALETTE = [
  'New Task',
  'Open Folder or File…',
  'Open Folder or File in Claude…',
  'Open Folder or File in Shell…',
  'Toggle Diff Panel',
  'Change Theme',
  'Preferences',
  'Zoom In',
  'Zoom Out',
  'Reset Zoom',
  'Run Full Dev Loop (Rest of the Owl)…',
  'Plan a Task…',
  'Clear Terminal',
  'Show Changes',
  'Show Dev Loop Progress',
  'Show Pull Request Panel',
  'Show Plan',
  'Show History',
  'Pop Out',
  'Kill Task',
  'Restart Claude Code',
  'Switch to: auth-fix',
  'Switch to: billing-refactor',
  'Run Full Dev Loop (Rest of the Owl)…',
  'Review Pull Request / Merge Request…',
  'View Logs',
  'MCP Servers',
].map((label) => ({ label, action: noop }));

const label = (text, commands = PALETTE) => {
  const m = matchCommand(text, commands);
  return m && (m.kind === 'send' ? 'SEND' : m.command.label);
};

test('dictation keeps the words and drops paste markers and control chars', () => {
  assert.equal(sanitizeDictation('  Refactor the login handler. '), 'Refactor the login handler.');
  assert.equal(sanitizeDictation('hello\x1b[201~\rrm -rf ~\r\x1b[200~world'), 'hello rm -rf ~ world');
  assert.equal(sanitizeDictation('a\nb\tc\x7f\x9bd'), 'a b c d');
  assert.equal(sanitizeDictation('esc\x1b[31m'), 'esc [31m');
});

test('non-speech markers become empty', () => {
  for (const s of ['[BLANK_AUDIO]', '(silence)', ' [Music] ', '', null, undefined]) {
    assert.equal(sanitizeDictation(s), '', String(s));
  }
});

test('normalize lowercases, strips punctuation, joins "p r" and a wake word', () => {
  assert.equal(normalize('Open P.R. review!'), 'open pr review');
  assert.equal(normalize('Klaussy, view changes please.'), 'view changes');
});

test('the phrasings from the request map to app actions', () => {
  assert.equal(label('Open PR review.'), 'Review Pull Request / Merge Request…');
  assert.equal(label('review pull requests'), 'Review Pull Request / Merge Request…');
  assert.equal(label('View changes'), 'Show Changes');
  assert.equal(label('new session'), 'New Task');
  assert.equal(label('start a new task'), 'New Task');
  assert.equal(label('settings'), 'Preferences');
});

test('show changes falls back to the diff toggle when no task is open', () => {
  const noTask = PALETTE.filter((c) => c.label !== 'Show Changes');
  assert.equal(label('view changes', noTask), 'Toggle Diff Panel');
});

test('any palette label spoken directly matches', () => {
  assert.equal(label('view logs'), 'View Logs');
  assert.equal(label('zoom in'), 'Zoom In');
  assert.equal(label('plan task'), 'Plan a Task…');
  assert.equal(label('MCP servers'), 'MCP Servers');
  assert.equal(label('run the full dev loop'), 'Run Full Dev Loop (Rest of the Owl)…');
});

test('switch to matches only task names', () => {
  assert.equal(label('switch to auth fix'), 'Switch to: auth-fix');
  assert.equal(label('go to the billing refactor task'), 'Switch to: billing-refactor');
});

test('send, submit and press enter press Enter, a bare enter does not', () => {
  for (const s of ['send', 'Submit.', 'press enter', 'send it']) assert.equal(label(s), 'SEND', s);
  assert.notEqual(label('enter'), 'SEND');
});

test('unclear or unrelated speech matches nothing', () => {
  assert.equal(label('zoom'), null);
  assert.equal(label('what is the weather'), null);
  assert.equal(label(''), null);
  assert.equal(label('switch to payments'), null);
});

test('commands that end an agent session cannot be run by voice', () => {
  for (const s of ['kill task', 'kill', 'restart', 'restart claude code']) assert.equal(label(s), null, s);
});

test('the phrasings from the second try map to the panels', () => {
  assert.equal(label('Open the dev loop.'), 'Show Dev Loop Progress');
  assert.equal(label('open the rest of the owl'), 'Show Dev Loop Progress');
  assert.equal(label('open the PR panel'), 'Show Pull Request Panel');
  assert.equal(label('show the pull request tab'), 'Show Pull Request Panel');
  assert.equal(label('run the rest of the owl'), 'Run Full Dev Loop (Rest of the Owl)…');
  assert.equal(label('open the history'), 'Show History');
  assert.equal(label('view logs'), 'View Logs');
});

test('with no dev loop running, opening it starts one instead', () => {
  const noLoop = PALETTE.filter((c) => c.label !== 'Show Dev Loop Progress');
  assert.equal(label('open the dev loop', noLoop), 'Run Full Dev Loop (Rest of the Owl)…');
  assert.equal(label('open the rest of the owl', noLoop), 'Run Full Dev Loop (Rest of the Owl)…');
});

test('ordinary dictation is not mistaken for a command', () => {
  for (const s of [
    'fix the zoom in bug on the settings page',
    'plan the auth refactor and add tests',
    'refactor the login handler and add a unit test for the token refresh',
    'show me why the history query is slow',
  ]) {
    assert.equal(label(s), null, s);
  }
});

test('articles, politeness and PR/MR short forms do not get in the way', () => {
  for (const s of ['open a pr review', 'Open a PR review.', 'can you open the pull request review please', 'let\'s review a pr', 'review an MR', 'open pr review for me']) {
    assert.equal(label(s), 'Review Pull Request / Merge Request…', s);
  }
  assert.equal(label('can you open the pr panel'), 'Show Pull Request Panel');
  assert.equal(label('please start a new session'), 'New Task');
});

test('a review request can name the PR', () => {
  assert.equal(parsePrRequest('Review PR 103.'), '103');
  assert.equal(parsePrRequest('open a pr review for 103'), '103');
  assert.equal(parsePrRequest('review pull request number 42'), '42');
  assert.equal(parsePrRequest('open the PR review for the login fix'), 'login fix');
  assert.equal(parsePrRequest('review the voice PR'), 'voice');
  assert.equal(parsePrRequest('open a pr review'), null);
  assert.equal(parsePrRequest('review pull requests'), null);
  assert.deepEqual(matchCommand('review pr 103', [{ label: 'Review Pull Request / Merge Request…', action: () => {} }]), { kind: 'pr', query: '103' });
});

test('pickPr finds a PR by number or by the words in its title', () => {
  const rows = [
    { number: '103', text: '#103 feat(voice): on-device dictation and voice commands klaussy-desktop GitHub steph-dove open' },
    { number: '1030', text: '#1030 fix(login): flaky login test klaussy-desktop GitHub steph-dove open' },
    { number: '99', text: '#99 fix(a11y): focus and announcements klaussy-desktop GitHub steph-dove open' },
  ];
  assert.deepEqual(pickPr('103', rows), [0]);
  assert.deepEqual(pickPr('voice', rows), [0]);
  assert.deepEqual(pickPr('the login fix', rows), [1]);
  assert.deepEqual(pickPr('klaussy desktop', rows).length, 3);
  assert.deepEqual(pickPr('payments', rows), []);
  assert.deepEqual(pickPr('pull request', rows), []);
});
