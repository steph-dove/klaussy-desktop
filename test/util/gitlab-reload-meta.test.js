// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Reloading a GitLab review's MR details goes through glab and never runs gh.
require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');

const MR_URL = 'https://gitlab.example.com/group/repo/-/merge_requests/4';
const calls = [];
// Stubbed before the modules under test load, since they destructure execFile.
childProcess.execFile = (cmd, args, opts, cb) => {
  calls.push([cmd, ...args]);
  if (cmd === 'glab') {
    cb(null, JSON.stringify({
      iid: 4, title: 'Merged title', state: 'merged', web_url: MR_URL,
      source_branch: 'feat', target_branch: 'main', author: { username: 'dev' },
    }), '');
  } else {
    cb(Object.assign(new Error(cmd + ' should not run'), { stderr: '' }), '', '');
  }
  return { on() {} };
};

const { prReview, reloadActivePrReviewMeta } = require('../../main/state/pr-review');

test('reloadActivePrReviewMeta refreshes a GitLab MR through glab, never gh', async () => {
  prReview.active = {
    forge: 'gitlab',
    host: 'gitlab.example.com',
    number: 4,
    projectPath: 'group/repo',
    baseOwner: 'group',
    baseRepo: 'repo',
    meta: { number: 4, url: MR_URL, state: 'OPEN', title: 'Old title' },
  };
  try {
    await reloadActivePrReviewMeta();
    assert.equal(calls.filter(([cmd]) => cmd === 'gh').length, 0, 'gh was called: ' + JSON.stringify(calls));
    assert.deepEqual(calls.find(([cmd]) => cmd === 'glab'), ['glab', 'mr', 'view', MR_URL, '--output', 'json']);
    assert.equal(prReview.active.meta.state, 'MERGED');
    assert.equal(prReview.active.meta.title, 'Merged title');
    assert.equal(prReview.active.meta.host, 'gitlab.example.com');
  } finally {
    prReview.active = null;
  }
});
