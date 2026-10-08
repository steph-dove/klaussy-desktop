require('../setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');

test('openInMacTerminal: runs the script through `open -a Terminal`, not osascript', async () => {
  const calls = [];
  const realExecFile = childProcess.execFile;
  childProcess.execFile = (file, args, opts, cb) => { calls.push({ file, args }); cb(null, '', ''); };
  delete require.cache[require.resolve('../../main/util/exec')];
  try {
    await require('../../main/util/exec').openInMacTerminal('/tmp/x.command');
  } finally {
    childProcess.execFile = realExecFile;
    delete require.cache[require.resolve('../../main/util/exec')];
  }
  assert.deepEqual(calls, [{ file: 'open', args: ['-a', 'Terminal', '/tmp/x.command'] }]);
});
