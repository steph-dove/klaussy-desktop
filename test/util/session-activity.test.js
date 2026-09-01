require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Stubbed before session-activity loads it: these tests cover when klaussy decides
// to write, not the model's prose.
let summaryReply = 'The nav is being restructured; do not move it underneath me.';
const prompts = [];
const handoffPath = require.resolve('../../main/state/session-handoff');
require.cache[handoffPath] = {
  id: handoffPath,
  filename: handoffPath,
  loaded: true,
  exports: {
    buildHandoffSeed: async () => '',
    runHeadless: async (prompt) => { prompts.push(prompt); return summaryReply; },
  },
};

const activity = require('../../main/state/session-activity');
const { ensureSessionNotesDir, listSessionNotes } = require('../../main/state/session-context');

function workspace(name) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `act-${name}-`)));
  return dir;
}

function agent(id, worktreePath, output) {
  return { id, name: `term-${id}`, worktreePath, mode: 'claude', alive: true, recentOutput: output };
}

const LOTS = 'x'.repeat(600);

test('a lone agent is not summarized — nobody is listening', async () => {
  const wt = workspace('lone');
  const dir = ensureSessionNotesDir(wt);
  try {
    const written = await activity.captureActivity([agent(1, wt, LOTS)]);
    assert.equal(written.length, 0);
    assert.equal(listSessionNotes(wt).length, 0);
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('two agents on one channel each get a note', async () => {
  const wt = workspace('pair');
  const dir = ensureSessionNotesDir(wt);
  try {
    const written = await activity.captureActivity([agent(1, wt, LOTS), agent(2, wt, LOTS)]);
    assert.equal(written.length, 2);
    const notes = listSessionNotes(wt);
    assert.equal(notes.length, 2);
    assert.ok(notes.every((n) => n.metadata.provider === 'klaussy'));
    assert.ok(notes.every((n) => n.body.includes('nav is being restructured')));
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('a quiet agent is skipped rather than summarized', async () => {
  const wt = workspace('quiet');
  const dir = ensureSessionNotesDir(wt);
  try {
    const written = await activity.captureActivity([agent(1, wt, 'ok'), agent(2, wt, 'done')]);
    assert.equal(written.length, 0);
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('repeat passes replace an agent\'s note instead of stacking', async () => {
  const wt = workspace('replace');
  const dir = ensureSessionNotesDir(wt);
  try {
    const a = agent(1, wt, LOTS);
    const b = agent(2, wt, LOTS);
    await activity.captureActivity([a, b]);
    a.recentOutput += 'y'.repeat(600);
    b.recentOutput += 'y'.repeat(600);
    await activity.captureActivity([a, b]);
    assert.equal(listSessionNotes(wt).length, 2);
  } finally {
    activity.forgetInstance(1);
    activity.forgetInstance(2);
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('an agent with nothing new to say is not re-summarized', async () => {
  const wt = workspace('nonew');
  const dir = ensureSessionNotesDir(wt);
  try {
    const a = agent(1, wt, LOTS);
    const b = agent(2, wt, LOTS);
    await activity.captureActivity([a, b]);
    const before = prompts.length;
    await activity.captureActivity([a, b]);
    assert.equal(prompts.length, before, 'should not spend a summarizer call');
  } finally {
    activity.forgetInstance(1);
    activity.forgetInstance(2);
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('the summarizer can decline and no note is written', async () => {
  const wt = workspace('nothing');
  const dir = ensureSessionNotesDir(wt);
  const prev = summaryReply;
  summaryReply = 'NOTHING';
  try {
    const written = await activity.captureActivity([agent(9, wt, LOTS), agent(8, wt, LOTS)]);
    assert.equal(written.length, 0);
    assert.equal(listSessionNotes(wt).length, 0);
  } finally {
    summaryReply = prev;
    activity.forgetInstance(9);
    activity.forgetInstance(8);
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('a decline written as prose is not stored as a note', async () => {
  const wt = workspace('prose');
  const dir = ensureSessionNotesDir(wt);
  const prev = summaryReply;
  const declines = [
    'No note needed — the agent only wrote a session note about work happening elsewhere; nothing in this repo changed.',
    'Nothing to report here; the agent only read files and asked a question.',
    'No changes of note happened in this terminal during that window.',
    'N/A — no substantive activity to summarize for other agents.',
  ];
  try {
    for (let i = 0; i < declines.length; i++) {
      summaryReply = declines[i];
      const written = await activity.captureActivity(
        [agent(30 + i, wt, LOTS + i), agent(40 + i, wt, LOTS + i)],
      );
      assert.equal(written.length, 0, `stored a decline: ${declines[i]}`);
    }
    assert.equal(listSessionNotes(wt).length, 0);
  } finally {
    summaryReply = prev;
    [30, 31, 32, 33, 40, 41, 42, 43].forEach(activity.forgetInstance);
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('a real summary that merely starts with "no" is still stored', async () => {
  const wt = workspace('nostart');
  const dir = ensureSessionNotesDir(wt);
  const prev = summaryReply;
  summaryReply = 'No longer using the legacy auth path — server.js now requires X-Request-Id on every call.';
  try {
    const written = await activity.captureActivity([agent(50, wt, LOTS), agent(51, wt, LOTS)]);
    assert.equal(written.length, 2);
  } finally {
    summaryReply = prev;
    [50, 51].forEach(activity.forgetInstance);
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('a handoff is recorded for the rest of the session', async () => {
  const wt = workspace('handoff');
  const dir = ensureSessionNotesDir(wt);
  try {
    const note = await activity.noteHandoff({
      worktreePath: wt, fromMode: 'claude', toMode: 'codex', brief: 'Refactored auth; port moved.',
    });
    assert.ok(note);
    const [written] = listSessionNotes(wt);
    assert.deepEqual(written.metadata.tags, ['handoff']);
    assert.match(written.body, /nav is being restructured/);

    // Handing back and forth replaces the note rather than stacking one per hop.
    await activity.noteHandoff({
      worktreePath: wt, fromMode: 'claude', toMode: 'codex', brief: 'More work.',
    });
    assert.equal(listSessionNotes(wt).length, 1);
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

// The timer skips a lone agent, but pressing Capture now is explicit intent —
// and the note stays, so an agent that joins later still reads it.
test('a manual capture summarizes a lone agent, unlike the timer', async () => {
  const wt = workspace('manual');
  const dir = ensureSessionNotesDir(wt);
  try {
    assert.equal((await activity.captureActivity([agent(1, wt, LOTS)])).length, 0);
    const written = await activity.captureActivity([agent(2, wt, LOTS)], { requireCompany: false });
    assert.equal(written.length, 1);
  } finally {
    [1, 2].forEach(activity.forgetInstance);
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('a scoped capture ignores agents in other sessions', async () => {
  const mine = workspace('mine');
  const other = workspace('other');
  const dirMine = ensureSessionNotesDir(mine);
  const dirOther = ensureSessionNotesDir(other);
  try {
    const written = await activity.captureActivity(
      [agent(1, mine, LOTS), agent(2, other, LOTS), agent(3, other, LOTS)],
      { worktreePath: mine, requireCompany: false },
    );
    assert.equal(written.length, 1);
    assert.equal(listSessionNotes(mine).length, 1);
    assert.equal(listSessionNotes(other).length, 0);
  } finally {
    [1, 2, 3].forEach(activity.forgetInstance);
    fs.rmSync(path.dirname(dirMine), { recursive: true, force: true });
    fs.rmSync(path.dirname(dirOther), { recursive: true, force: true });
  }
});

// On by default is a deliberate product decision, not a side effect of the
// `!== false` check — pin it so nobody flips it by "tidying" that comparison.
test('it is on when the setting has never been touched', async () => {
  const { loadConfig, saveConfig } = require('../../main/util/config');
  const wt = workspace('default');
  const dir = ensureSessionNotesDir(wt);
  const cfg = loadConfig();
  try {
    const without = { ...cfg };
    delete without.sessionActivityNotes;
    await saveConfig(without);
    assert.equal((await activity.captureActivity([agent(60, wt, LOTS), agent(61, wt, LOTS)])).length, 2);
  } finally {
    await saveConfig(cfg);
    [60, 61].forEach(activity.forgetInstance);
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('the pref switches it off without a restart', async () => {
  const { loadConfig, saveConfig } = require('../../main/util/config');
  const wt = workspace('off');
  const dir = ensureSessionNotesDir(wt);
  const cfg = loadConfig();
  try {
    // saveConfig is queued and returns a promise; without awaiting, the read
    // below races the write.
    await saveConfig({ ...cfg, sessionActivityNotes: false });
    assert.equal((await activity.captureActivity([agent(1, wt, LOTS), agent(2, wt, LOTS)])).length, 0);
    assert.equal(await activity.noteHandoff({
      worktreePath: wt, fromMode: 'claude', toMode: 'codex', brief: 'something',
    }), null);
    assert.equal(listSessionNotes(wt).length, 0);

    await saveConfig({ ...cfg, sessionActivityNotes: true });
    assert.equal((await activity.captureActivity([agent(3, wt, LOTS), agent(4, wt, LOTS)])).length, 2);
  } finally {
    await saveConfig(cfg);
    [1, 2, 3, 4].forEach(activity.forgetInstance);
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('terminal redraw noise is cleaned before the summarizer sees it', async () => {
  const wt = workspace('noisy');
  const dir = ensureSessionNotesDir(wt);
  // \r rewrites the line in place: only "Working... done" ever existed on
  // screen. Real lines are varied because cleanExcerpt also dedupes repeats.
  const real = Array.from({ length: 30 }, (_, i) => `Changed AUTH_PORT to 3005 in module ${i}.`).join('\n');
  const noisy = `${'Wo\rWork\rWorking\rWorking... done\n'.repeat(40)}${real}\n`;
  try {
    const before = prompts.length;
    await activity.captureActivity([agent(11, wt, noisy), agent(12, wt, noisy)]);
    const sent = prompts.slice(before).join('\n');
    assert.ok(sent.includes('Changed AUTH_PORT to 3005 in module 0.'), 'real content should survive');
    assert.ok(!/Wo\rWork/.test(sent), 'redraw fragments should not reach the summarizer');
    assert.ok(!sent.includes('Wo\nWork\n'), 'partial labels should be collapsed');
  } finally {
    [11, 12].forEach(activity.forgetInstance);
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('a handoff with no brief writes nothing', async () => {
  const wt = workspace('nobrief');
  const dir = ensureSessionNotesDir(wt);
  try {
    assert.equal(await activity.noteHandoff({ worktreePath: wt, fromMode: 'a', toMode: 'b', brief: '' }), null);
    assert.equal(listSessionNotes(wt).length, 0);
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('the extra agent tabs in a task are captured too, not just the first agent', async () => {
  const { instances, liveAgentInstances } = require('../../main/state/instances');
  const wt = workspace('subs');
  const dir = ensureSessionNotesDir(wt);
  instances.set(4201, {
    id: 4201, name: 'auth', worktreePath: wt, mode: 'agy', alive: true, recentOutput: LOTS,
    subTerminals: [
      {
        subId: 1, mode: 'claude', alive: true,
        mirror: {
          id: '4201:1', name: 'auth · Claude Code', mode: 'claude',
          worktreePath: wt, alive: true, recentOutput: LOTS,
        },
      },
      { subId: 2, mode: 'codex', alive: false, mirror: { id: '4201:2', name: 'gone', mode: 'codex', worktreePath: wt, alive: true, recentOutput: LOTS } },
    ],
  });
  try {
    const agents = liveAgentInstances();
    assert.deepEqual(agents.map((a) => a.id), [4201, '4201:1']);

    const written = await activity.captureActivity(agents);
    assert.equal(written.length, 2, 'both live agents in the task should get a note');
    const notes = listSessionNotes(wt);
    assert.deepEqual(notes.map((n) => n.metadata.agent).sort(), ['agy', 'claude']);
  } finally {
    instances.delete(4201);
    activity.forgetInstance(4201);
    activity.forgetInstance('4201:1');
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});
