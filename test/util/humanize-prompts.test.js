const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  FALLBACK_RULES, SECTIONS, section, findRepoHumanizeSkill, loadRules,
  cutPrompt, voicePrompt, checkPrompt,
} = require('../../main/state/humanize-prompts');

test('each pass gets only its own sections', () => {
  const cut = cutPrompt(FALLBACK_RULES, {});
  const voice = voicePrompt(FALLBACK_RULES);

  // The whole point of the split: voice rules must not reach the cut pass, or
  // it spends its attention rewriting instead of deleting.
  assert.ok(cut.includes(SECTIONS.answer), 'cut pass keeps the answer rules');
  assert.ok(cut.includes(SECTIONS.shape), 'cut pass keeps the shape rules');
  assert.ok(!cut.includes(SECTIONS.voice), 'cut pass must not carry voice rules');

  assert.ok(voice.includes(SECTIONS.voice), 'voice pass keeps the voice rules');
  assert.ok(!voice.includes(SECTIONS.answer), 'voice pass must not carry cut rules');
});

test('section() stops at the next header', () => {
  const voice = section(FALLBACK_RULES, 'voice');
  assert.ok(voice.startsWith(SECTIONS.voice));
  assert.ok(!voice.includes(SECTIONS.shape), 'ran past its own section');
});

test('section() returns empty for a header that is not there', () => {
  assert.equal(section('no headers at all', 'voice'), '');
});

test('the cut pass is told what the text answers when we know', () => {
  const withQ = cutPrompt(FALLBACK_RULES, { question: 'Why not use Shadow DOM?' });
  assert.match(withQ, /Why not use Shadow DOM\?/);
  const withoutQ = cutPrompt(FALLBACK_RULES, {});
  assert.match(withoutQ, /no explicit question/i);
});

test('both rewriting passes are told to leave code alone', () => {
  assert.match(cutPrompt(FALLBACK_RULES, {}), /backticks or fences/);
  assert.match(voicePrompt(FALLBACK_RULES), /backticks or fences/);
});

test('the check pass carries the original to compare against', () => {
  const p = checkPrompt('the original text here');
  assert.match(p, /--- ORIGINAL ---/);
  assert.match(p, /the original text here/);
  assert.match(p, /ADDED/);
  assert.match(p, /DROPPED/);
  assert.match(p, /REVERSED/);
  // Restoring meaning must not become an excuse to undo the cut pass.
  assert.match(p, /Do not re-expand/);
});

test('the repo skill wins over the built-in rules when it has the sections', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-'));
  const skill = path.join(dir, '.claude', 'skills', 'myrepo-humanize');
  fs.mkdirSync(skill, { recursive: true });
  const body = `${SECTIONS.voice} repo voice rules\n\n${SECTIONS.shape} repo shape rules`;
  fs.writeFileSync(path.join(skill, 'SKILL.md'), body);

  assert.ok(findRepoHumanizeSkill(dir), 'found the scaffolded skill');
  assert.equal(loadRules(dir), body);
});

test('a skill missing the sections falls back rather than yielding empty passes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-'));
  const skill = path.join(dir, '.claude', 'skills', 'myrepo-humanize');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), 'a skill from some older klaussy');

  assert.equal(loadRules(dir), FALLBACK_RULES);
});

test('no worktree and no skill still produces usable prompts', () => {
  assert.equal(loadRules(null), FALLBACK_RULES);
  assert.ok(cutPrompt(loadRules(null), {}).length > 100);
});
