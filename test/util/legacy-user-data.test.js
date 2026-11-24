require('../setup');
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { legacyUserDataDir } = require('../../main/bootstrap/single-instance');

const APP_DATA = path.join('/fake', 'Application Support');
const MAUSSIAN = path.join(APP_DATA, 'Maussian');
const KLAUSSY = path.join(APP_DATA, 'Klaussy');
const has = (...dirs) => (p) => dirs.some((d) => p === path.join(d, 'config.json'));

test('an upgraded install keeps its Klaussy folder', () => {
  assert.strictEqual(legacyUserDataDir(APP_DATA, MAUSSIAN, has(KLAUSSY)), KLAUSSY);
});

test('a fresh install uses Maussian', () => {
  assert.strictEqual(legacyUserDataDir(APP_DATA, MAUSSIAN, has()), null);
});

test('once Maussian has its own config, it wins', () => {
  assert.strictEqual(legacyUserDataDir(APP_DATA, MAUSSIAN, has(KLAUSSY, MAUSSIAN)), null);
});

test('a Klaussy folder with no config is ignored', () => {
  assert.strictEqual(legacyUserDataDir(APP_DATA, MAUSSIAN, (p) => p === KLAUSSY), null);
});

test('nothing changes when userData is already the Klaussy folder', () => {
  assert.strictEqual(legacyUserDataDir(APP_DATA, KLAUSSY, has(KLAUSSY)), null);
});
