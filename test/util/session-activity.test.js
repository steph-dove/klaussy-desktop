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
