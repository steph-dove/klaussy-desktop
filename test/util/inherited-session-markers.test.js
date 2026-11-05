require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');

const { withoutInheritedSessionMarkers } = require('../../main/util/exec');

test('drops the parent Claude session markers and keeps the rest', () => {
  const env = {
    PATH: '/bin',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ID: 'abc',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CONFIG_DIR: '/cfg',
  };
  assert.deepEqual(withoutInheritedSessionMarkers(env), { PATH: '/bin', CLAUDE_CONFIG_DIR: '/cfg' });
  assert.equal(env.CLAUDE_CODE_SESSION_ID, 'abc');
});
