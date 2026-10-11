const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeDictation, normalize, matchCommand, parsePrRequest, prQueryFromPicker, endsWithDiscard, toBranchName, pickControl, exactControl, listPick } = require('../../renderer/voice-text');

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
  'Show Active Agents',
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

test('delete that, scratch that and undo that are edits, not text', () => {
  for (const s of ['Delete that.', 'scratch that', 'undo that', 'delete the last bit']) {
    assert.deepEqual(matchCommand(s, PALETTE), { kind: 'undo' }, s);
  }
  assert.equal(endsWithDiscard('Select "Keep Focus" through re-renders. Delete that'), true);
  assert.equal(endsWithDiscard('fix the bug, scratch that'), true);
  assert.equal(endsWithDiscard('delete that file from the repo'), false);
  assert.equal(endsWithDiscard('add a test'), false);
});

test('speaking to the open PR picker strips the picking words', () => {
  assert.equal(prQueryFromPicker('Select "Keep Focus" through re-renders.'), 'keep focus through re renders');
  assert.equal(prQueryFromPicker('pick the voice PR'), 'voice');
  assert.equal(prQueryFromPicker('number 103'), '103');
  assert.equal(prQueryFromPicker('open 99'), '99');
});

test('put that back, restore that and type that restore what was deleted', () => {
  for (const s of ['Put that back.', 'restore it', 'bring that back', 'type that', 'undo the delete']) {
    assert.deepEqual(matchCommand(s, PALETTE), { kind: 'restore' }, s);
  }
});

test('stop listening, that\'s all and I\'m done end the conversation', () => {
  for (const s of ['Stop listening.', 'stop', "That's all.", "I'm done", 'never mind']) {
    assert.deepEqual(matchCommand(s, PALETTE), { kind: 'stop' }, s);
  }
  assert.equal(matchCommand('stop the dev server and restart it', PALETTE), null);
});

test('session names become dashed branch names', () => {
  assert.equal(toBranchName('Fix the flaky login test.'), 'fix-the-flaky-login-test');
  assert.equal(toBranchName("Add O'Brien's PR #12 support!"), 'add-o-brien-s-pr-12-support');
  assert.equal(toBranchName('  '), '');
});

test('focusing a session by its spoken name finds the dashed name', () => {
  for (const s of ['focus on the auth fix session', 'go to session auth fix', 'open session auth fix', 'switch over to auth fix', 'jump to the auth-fix tab', 'focus auth fix window']) {
    assert.equal(label(s), 'Switch to: auth-fix', s);
  }
  assert.equal(label('focus on billing refactor'), 'Switch to: billing-refactor');
  assert.equal(label('open the dev loop'), 'Show Dev Loop Progress');
});

test('pickControl presses the on-screen button or tab you name', () => {
  global.window = global.window || {};
  require('../../renderer/utils');
  const fuzzy = global.window.AppUtils.fuzzyMatch;
  const names = ['Overview', 'Files 12', 'AI Review 3', 'Checks', 'Run review', 'Post comments', 'Cancel'];
  const pick = (s) => { const i = pickControl(s, names, fuzzy); return i < 0 ? null : names[i]; };
  assert.equal(pick('select AI review'), 'AI Review 3');
  assert.equal(pick('select tab AI review'), 'AI Review 3');
  assert.equal(pick('Click the AI review tab.'), 'AI Review 3');
  assert.equal(pick('run review'), 'Run review');
  assert.equal(pick('Run review.'), 'Run review');
  assert.equal(pick('press post comments'), 'Post comments');
  assert.equal(pick('go to checks'), 'Checks');
  assert.equal(pick('select files'), 'Files 12');
  assert.equal(pick('review'), null);
  assert.equal(pick('please review the files and run the tests again'), null);
  assert.equal(pick('select payments'), null);
});

test('a single word buried in a long command name does not run it', () => {
  const cmds = ['Open Folder or File in Gemini CLI…', 'Open Folder or File in Claude Code…', 'Show Dev Loop Progress', 'View Logs'].map((l) => ({ label: l, action: () => {} }));
  const pick = (t) => { const m = matchCommand(t, cmds); return m && m.command ? m.command.label : m; };
  assert.equal(pick('Gemini.'), null);
  assert.equal(pick('dev loop'), 'Show Dev Loop Progress');
  assert.equal(pick('logs'), 'View Logs');
  assert.equal(pick('open folder in gemini'), 'Open Folder or File in Gemini CLI…');
});

test('close, cancel and close window dismiss the open dialog', () => {
  for (const t of ['close', 'Cancel.', 'Close. Close window. Cancel.', 'close this window', 'dismiss', 'go back', 'escape']) {
    assert.deepEqual(matchCommand(t, PALETTE), { kind: 'dismiss' }, t);
  }
  assert.equal(matchCommand('close the auth bug ticket', PALETTE), null);
});

test('next and done naming move on from a text box', () => {
  for (const t of ['next', 'Next field.', 'move on', "I'm done naming the session", 'done naming', "that's the name"]) {
    assert.deepEqual(matchCommand(t, PALETTE), { kind: 'next' }, t);
  }
  assert.deepEqual(matchCommand('done', PALETTE), { kind: 'stop' });
});

test('select agent gemini names the Gemini agent button', () => {
  global.window = global.window || {};
  require('../../renderer/utils');
  const fuzzy = global.window.AppUtils.fuzzyMatch;
  const names = ['Claude', 'Codex', 'Gemini', 'Antigravity', 'Cancel', 'Create'];
  const pick = (t) => { const i = pickControl(t, names, fuzzy); return i < 0 ? null : names[i]; };
  assert.equal(pick('select agent gemini'), 'Gemini');
  assert.equal(pick('use gemini'), 'Gemini');
  assert.equal(pick('Gemini.'), 'Gemini');
  assert.equal(pick('pick the codex agent'), 'Codex');
});

test('the agents list opens by any of the names it shows', () => {
  for (const t of ['open agent list', 'Open active agents.', 'open results', '1 result ready', 'show running agents', 'check results']) {
    assert.equal(label(t), 'Show Active Agents', t);
  }
});

test('code review opens the picker and run review starts the AI review', () => {
  const cmds = ['Review Pull Request / Merge Request…', 'Run AI Review', 'View Logs'].map((l) => ({ label: l, action: () => {} }));
  const pick = (t, list = cmds) => { const m = matchCommand(t, list); return m && m.command ? m.command.label : m; };
  assert.equal(pick('code review'), 'Review Pull Request / Merge Request…');
  assert.equal(pick('Open code review.'), 'Review Pull Request / Merge Request…');
  for (const t of ['run review', 'Run the AI review.', 'run code review', 'start the review', 'rerun review', 'run review again']) {
    assert.equal(pick(t), 'Run AI Review', t);
  }
  const notInReview = cmds.filter((c) => c.label !== 'Run AI Review');
  assert.equal(pick('run code review', notInReview), 'Review Pull Request / Merge Request…');
});

test('two controls with the same name are pressed, different names that tie are not', () => {
  global.window = global.window || {};
  require('../../renderer/utils');
  const fuzzy = global.window.AppUtils.fuzzyMatch;
  assert.equal(pickControl('run review', ['Files', 'Run Review', 'AI Review', 'Run review'], fuzzy), 1);
  assert.equal(pickControl('select review', ['Run review', 'Submit review'], fuzzy), -1);
});

test('a name said exactly and in order beats similar or reordered names', () => {
  global.window = global.window || {};
  require('../../renderer/utils');
  const fuzzy = global.window.AppUtils.fuzzyMatch;
  const names = ['Session glab-test', 'Session test-glab', 'Session change-color-scheme', 'Session scheme-color-change', 'bbb1, 1 repo', 'brb1, 1 repo'];
  const pick = (t) => { const i = pickControl(t, names, fuzzy); return i < 0 ? null : names[i]; };
  assert.equal(pick('select session test glab'), 'Session test-glab');
  assert.equal(pick('select session glab test'), 'Session glab-test');
  assert.equal(pick('select session scheme color change'), 'Session scheme-color-change');
  assert.equal(pick('select bbb1 1 repo'), 'bbb1, 1 repo');
});

test('exactControl only fires on a whole, exact name', () => {
  const names = ['Files 12', 'Search', 'Run Review', 'Run review', 'Send'];
  assert.equal(exactControl('files', names), 0);
  assert.equal(exactControl('Search.', names), 1);
  assert.equal(exactControl('run review', names), 2);
  assert.equal(exactControl('search the files', names), -1);
  assert.equal(exactControl('file', names), -1);
});

test('single-word overlaps and PR connectors no longer misfire', () => {
  const cmds = ['Review Pull Request / Merge Request…', 'Clear Terminal'].map((l) => ({ label: l, action: () => {} }));
  assert.equal(matchCommand('pull', cmds), null);
  assert.equal(parsePrRequest('review PR or MR'), null);
});

test('a name ending in a number is not confused with the same name without it', () => {
  global.window = global.window || {};
  require('../../renderer/utils');
  const fuzzy = global.window.AppUtils.fuzzyMatch;
  const names = ['Session test-delete', 'Session test-delete-0'];
  assert.equal(pickControl('select session test delete', names, fuzzy), 0);
  assert.equal(pickControl('select session test delete 0', names, fuzzy), 1);
  assert.equal(exactControl('session test delete', names), 0);
  assert.equal(exactControl('AI review', ['AI Review 3']), 0);
});

test('list rows can be picked by position or state', () => {
  assert.deepEqual(listPick('open the first one'), { index: 0 });
  assert.deepEqual(listPick('the second one'), { index: 1 });
  assert.deepEqual(listPick('open the latest'), { index: 0 });
  assert.deepEqual(listPick('open the last agent'), { index: -1 });
  assert.deepEqual(listPick('open the completed one'), { state: 'done' });
  assert.deepEqual(listPick('Open the finished task.'), { state: 'done' });
  assert.deepEqual(listPick('open the result'), { state: 'done' });
  assert.deepEqual(listPick('open it'), { state: 'done' });
  assert.deepEqual(listPick('open the failed one'), { state: 'error' });
  assert.deepEqual(listPick('show the running agent'), { state: 'running' });
  assert.equal(listPick('open the dev loop'), null);
  assert.equal(listPick('open pr review'), null);
});

test('run review means the PR review in PR review, and the session review in a session', () => {
  const mk = (labels) => labels.map((l) => ({ label: l, action: () => {} }));
  const pick = (t, list) => { const m = matchCommand(t, list); return m && m.command ? m.command.label : m; };
  const inSession = mk(['Review Changes…', 'Review Pull Request / Merge Request…']);
  const inPrReview = mk(['Run AI Review', 'Review Changes…', 'Review Pull Request / Merge Request…']);
  const nothingOpen = mk(['Review Pull Request / Merge Request…']);
  assert.equal(pick('run review', inSession), 'Review Changes…');
  assert.equal(pick('Run code review.', inSession), 'Review Changes…');
  assert.equal(pick('review my changes', inSession), 'Review Changes…');
  assert.equal(pick('review the diff', inSession), 'Review Changes…');
  assert.equal(pick('run review', inPrReview), 'Run AI Review');
  assert.equal(pick('run review', nothingOpen), 'Review Pull Request / Merge Request…');
});

test('review and CR on their own open the PR picker', () => {
  const cmds = ['Review Changes…', 'Review Pull Request / Merge Request…'].map((l) => ({ label: l, action: () => {} }));
  for (const t of ['review', 'Review.', 'CR', 'C.R.', 'open a CR', 'code review']) {
    const m = matchCommand(t, cmds);
    assert.equal(m && m.command && m.command.label, 'Review Pull Request / Merge Request…', t);
    assert.equal(m.alias, true, t);
  }
});

test('spoken numbers become digits where a number is meant', () => {
  assert.equal(normalize('review PR one oh three'), 'review pr 103');
  assert.equal(normalize('review pr one hundred three'), 'review pr 103');
  assert.equal(normalize('open pr review for forty two'), 'open pr review for 42');
  assert.equal(normalize('review pr three'), 'review pr 3');
  assert.equal(normalize('two thousand twenty six'), '2026');
  assert.equal(normalize('open the second one'), 'open the second one');
  assert.equal(normalize('one result ready'), 'one result ready');
  assert.equal(parsePrRequest('Review PR one oh three.'), '103');
});
