require('../setup');

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { findPlanDoc, findDesignDoc } = require('../../main/ipc/files');
const { writeSessionNote } = require('../../main/state/session-context');

test('findPlanDoc: returns root plan.md if present', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-plan-test-'));
  const worktreeDir = path.join(tempRoot, 'my-repo');
  fs.mkdirSync(worktreeDir, { recursive: true });

  fs.writeFileSync(path.join(worktreeDir, 'plan.md'), '# Root Plan Content');

  try {
    const res = await findPlanDoc(worktreeDir);
    assert.equal(res.name, 'plan.md');
    assert.equal(res.content, '# Root Plan Content');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('findPlanDoc: falls back to OKF session notes when root plan is absent', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-plan-okf-'));
  const worktreeDir = path.join(tempRoot, 'my-repo');
  fs.mkdirSync(worktreeDir, { recursive: true });

  writeSessionNote(worktreeDir, {
    id: 'agent-plan-note',
    agent: 'claude',
    provider: 'anthropic',
    tags: ['plan', 'devloop'],
    title: 'Implementation Plan',
    content: '## Build Checklist\n- [ ] Step 1\n- [ ] Step 2',
  });

  try {
    const res = await findPlanDoc(worktreeDir);
    assert.ok(res.content.includes('## Build Checklist'));
    assert.ok(res.name.includes('Implementation Plan') || res.name.includes('agent-plan-note'));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('findDesignDoc: falls back to OKF session notes when root design is absent', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-design-okf-'));
  const worktreeDir = path.join(tempRoot, 'my-repo');
  fs.mkdirSync(worktreeDir, { recursive: true });

  writeSessionNote(worktreeDir, {
    id: 'agent-design-note',
    agent: 'gemini',
    provider: 'google',
    tags: ['design', 'architecture'],
    title: 'Architecture Blueprint',
    content: '## Component Diagram\nData flows from UI to Main IPC.',
  });

  try {
    const res = await findDesignDoc(worktreeDir);
    assert.ok(res.content.includes('## Component Diagram'));
    assert.ok(res.name.includes('Architecture Blueprint') || res.name.includes('agent-design-note'));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
