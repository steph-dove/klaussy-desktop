require('../setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const { RETIRED_AGENTS, replacementFor, resumeModes } = require('../../main/state/retired-agents');

test('a retired agent maps to its replacement; anything else maps to nothing', () => {
  assert.equal(replacementFor('gemini'), 'antigravity');
  assert.equal(replacementFor('claude'), null);
  assert.equal(replacementFor(undefined), null);
  assert.equal(replacementFor('constructor'), null); // no prototype keys
  assert.equal(RETIRED_AGENTS.gemini.displayName, 'Gemini CLI');
});

test('a migrated Gemini session resumes as Antigravity, started by Gemini (a hand-off)', () => {
  assert.deepEqual(resumeModes('antigravity', 'gemini'), { resumeMode: 'antigravity', startedBy: 'gemini' });
});

test('an unmigrated Gemini session still hands off to Antigravity', () => {
  assert.deepEqual(resumeModes('gemini', undefined), { resumeMode: 'antigravity', startedBy: 'gemini' });
});

test('ordinary sessions resume as before', () => {
  assert.deepEqual(resumeModes('codex', undefined), { resumeMode: 'codex', startedBy: 'codex' });
  assert.deepEqual(resumeModes('claude', 'codex'), { resumeMode: 'claude', startedBy: 'codex' });
  assert.deepEqual(resumeModes(undefined, undefined), { resumeMode: 'claude', startedBy: 'claude' });
});
