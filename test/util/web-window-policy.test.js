require('../setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../../web/window-policy');

test('pageFor: served pages pass through, no page is the main app, anything else is null', () => {
  for (const p of ['index.html', 'popout.html', 'pr-review.html', 'preferences.html']) assert.equal(policy.pageFor(p), p);
  assert.equal(policy.pageFor(undefined), 'index.html');
  assert.equal(policy.pageFor('new-panel.html'), null); // never shown as the main app
});

test('graceFor: only a page that said it is leaving gets a short wait', () => {
  const g = policy.GRACE_MS;
  assert.equal(policy.graceFor('popout.html', true), g.closingPopout);
  assert.equal(policy.graceFor('preferences.html', true), g.closingPopout);
  assert.equal(policy.graceFor('index.html', true), g.closingWindow);
  // A dropped socket (sleep, a throttled tab) keeps any window for a long time.
  assert.equal(policy.graceFor('popout.html', false), g.dropped);
  assert.equal(policy.graceFor('index.html', false), g.dropped);
  assert.ok(g.dropped > g.closingWindow && g.closingWindow > g.closingPopout);
});

test('needsTab: only an unshown, unreserved, servable window that is not the main one', () => {
  const base = { hasTab: false, isMain: false, reserved: false, page: 'popout.html' };
  assert.equal(policy.needsTab(base), true);
  assert.equal(policy.needsTab({ ...base, hasTab: true }), false);
  assert.equal(policy.needsTab({ ...base, isMain: true }), false);
  // A window /__bind just made for a new tab is that tab's: no second tab for it.
  assert.equal(policy.needsTab({ ...base, reserved: true }), false);
  assert.equal(policy.needsTab({ ...base, page: null }), false);
});

test('pickOpener: the tab in use, else the most recently used one, never one that only polls', () => {
  const tabs = [{ id: 1, lastActive: 100 }, { id: 2, lastActive: 300 }, { id: 3 }];
  assert.equal(policy.pickOpener(tabs, 1).id, 1);
  assert.equal(policy.pickOpener(tabs, 99).id, 2); // focused one isn't a candidate
  assert.equal(policy.pickOpener(tabs, undefined).id, 2);
  assert.equal(policy.pickOpener([], 1), null);
});
