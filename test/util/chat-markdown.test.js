require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const md = require('../../main/util/chat-markdown');

test('details/summary become a heading rather than raw tags', () => {
  const out = md.forDiscord('<details>\n<summary>Answer</summary>\n\nThe body.\n</details>');
  assert.doesNotMatch(out, /<details>|<\/details>|<summary>/);
  assert.match(out, /\*\*Answer\*\*/);
  assert.match(out, /The body\./);
});

test('discord keeps the markdown it renders', () => {
  const out = md.forDiscord('**bold** and `code`\n- a bullet');
  assert.match(out, /\*\*bold\*\*/, 'discord renders double-asterisk bold');
  assert.match(out, /- a bullet/);
});

test('slack gets its own dialect', () => {
  const out = md.forSlack('## Heading\n\n**bold**\n\n- one\n- two');
  assert.match(out, /^\*Heading\*$/m, 'no heading syntax in slack');
  assert.match(out, /^\*bold\*$/m, 'single asterisk is bold');
  assert.match(out, /• one/, 'bullets are literal');
  assert.doesNotMatch(out, /\*\*/, 'double asterisks would show literally');
});

test('a fenced block is never treated as markup', () => {
  const out = md.forSlack('```js\nconst x = 1; // **stars** and - dashes\n```');
  assert.match(out, /\*\*stars\*\*/, 'code contents survive untouched');
  assert.doesNotMatch(out, /• dashes/);
});

test('long text is cut at a line boundary, not mid-word', () => {
  const line = 'a fairly long line of prose that keeps going for a while';
  const out = md.forDiscord(Array.from({ length: 200 }, () => line).join('\n'));
  assert.ok(out.length <= md.DISCORD_MAX + 4);
  assert.ok(out.endsWith('…'));
  const lastContent = out.split('\n').filter((l) => l && l !== '…').pop();
  assert.equal(lastContent, line);
});

test('empty input is handled', () => {
  assert.equal(md.forDiscord(''), '');
  assert.equal(md.forSlack(null), '');
});
