require('../setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { spawnHeadlessAgent, quoteShimArg } = require('../../main/util/agent-spawn');

test('shim args with a space or cmd metacharacter are quoted, plain flags are not', () => {
  assert.equal(quoteShimArg('--allowedTools'), '--allowedTools');
  assert.equal(quoteShimArg('ScheduleWakeup'), 'ScheduleWakeup');
  assert.equal(quoteShimArg('Bash(klaussy base:*)'), '"Bash(klaussy base:*)"');
  assert.equal(quoteShimArg('a&b'), '"a&b"');
});

test('a .cmd shim receives a permission rule with a space as one argument', { skip: process.platform !== 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-spawn-'));
  const shim = path.join(dir, 'echo-args.cmd');
  fs.writeFileSync(shim, '@node -e "console.log(JSON.stringify(process.argv.slice(1)))" -- %*\r\n');
  const args = ['--allowedTools', 'Bash(klaussy base:*)', 'Bash(klaussy review-prep:*)'];
  const proc = spawnHeadlessAgent(shim, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  await new Promise((resolve) => proc.on('exit', resolve));
  assert.deepEqual(JSON.parse(out.trim()), args);
});
