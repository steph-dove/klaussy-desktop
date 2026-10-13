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

test('findDesignDoc: skips a plan note tagged [plan, design]', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-design-plan-'));
  const worktreeDir = path.join(tempRoot, 'my-repo');
  fs.mkdirSync(worktreeDir, { recursive: true });

  writeSessionNote(worktreeDir, {
    id: 'agent-design-note',
    agent: 'gemini',
    provider: 'google',
    tags: ['design'],
    title: 'Architecture Blueprint',
    content: '## Component Diagram',
    timestamp: '2026-10-01T00:00:00Z',
  });
  // Newer, and tagged the way the plan prompts tell agents to tag plans.
  writeSessionNote(worktreeDir, {
    id: 'claude-plan',
    agent: 'claude',
    provider: 'anthropic',
    tags: ['plan', 'design'],
    content: '# Plan\n- [ ] Step 1',
    timestamp: '2026-10-02T00:00:00Z',
  });

  try {
    const design = await findDesignDoc(worktreeDir);
    assert.ok(design.content.includes('## Component Diagram'));
    const plan = await findPlanDoc(worktreeDir);
    assert.ok(plan.content.includes('- [ ] Step 1'));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('findDesignDoc: no design doc when nothing is one', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-design-none-'));
  const worktreeDir = path.join(tempRoot, 'my-repo');
  fs.mkdirSync(path.join(worktreeDir, 'docs'), { recursive: true });
  // Each of these used to land in the Design tab.
  fs.writeFileSync(path.join(worktreeDir, 'NOTICE.md'), 'notice');
  fs.writeFileSync(path.join(worktreeDir, 'task-artifact-preview.md'), 'a task');
  fs.writeFileSync(path.join(worktreeDir, 'docs', 'CONTRACT.md'), 'contract');
  writeSessionNote(worktreeDir, {
    id: 'claude-plan',
    agent: 'claude',
    provider: 'anthropic',
    tags: ['plan', 'design', 'devloop'],
    content: '# Plan\n- [ ] Step 1',
  });
  writeSessionNote(worktreeDir, {
    id: 'claude-port-moved',
    agent: 'claude',
    provider: 'anthropic',
    tags: ['infra'],
    content: 'The dev server moved to port 4000.',
  });
  writeSessionNote(worktreeDir, {
    id: 'antigravity-dev-loop-feature',
    agent: 'antigravity',
    provider: 'google',
    tags: ['dev-loop', 'ui'],
    content: 'Implemented the Dev Loop panel.',
  });

  try {
    const res = await findDesignDoc(worktreeDir);
    assert.ok(res.error, 'expected no design doc, got ' + JSON.stringify(res.path || res.name));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('findDesignDoc: still finds a spec in a first-level folder', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-design-child-'));
  const worktreeDir = path.join(tempRoot, 'session-root');
  fs.mkdirSync(path.join(worktreeDir, 'my-repo'), { recursive: true });
  fs.writeFileSync(path.join(worktreeDir, 'my-repo', 'design-spec.md'), '# Spec');

  try {
    const res = await findDesignDoc(worktreeDir);
    assert.equal(res.name, 'design-spec.md');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('findDesignDoc: a design note titled "Implementation notes" is not a plan', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-design-title-'));
  const worktreeDir = path.join(tempRoot, 'my-repo');
  fs.mkdirSync(worktreeDir, { recursive: true });

  // writeSessionNote puts "# Implementation notes for the cache" atop the body.
  writeSessionNote(worktreeDir, {
    id: 'gemini-cache',
    agent: 'gemini',
    provider: 'google',
    tags: ['design'],
    title: 'Implementation notes for the cache',
    content: '## Layers\nMemory, then disk.',
  });

  try {
    const design = await findDesignDoc(worktreeDir);
    assert.ok(design.content && design.content.includes('## Layers'));
    const plan = await findPlanDoc(worktreeDir);
    assert.ok(plan.error, 'expected no plan, got ' + JSON.stringify(plan.path || plan.name));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('findDesignDoc: skips plan-named files and reaches a design doc below', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-design-planfile-'));
  const worktreeDir = path.join(tempRoot, 'session-root');
  fs.mkdirSync(path.join(worktreeDir, 'my-repo'), { recursive: true });
  fs.writeFileSync(path.join(worktreeDir, 'design-plan.md'), '# Plan');
  fs.writeFileSync(path.join(worktreeDir, 'my-repo', 'design.md'), '# Design');

  try {
    const design = await findDesignDoc(worktreeDir);
    assert.equal(design.path, path.join(worktreeDir, 'my-repo', 'design.md'));
    const plan = await findPlanDoc(worktreeDir);
    assert.equal(plan.name, 'design-plan.md');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('plan and design notes saved the way the plan prompts ask land in their own tabs', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-prompt-notes-'));
  const worktreeDir = path.join(tempRoot, 'my-repo');
  fs.mkdirSync(worktreeDir, { recursive: true });

  // renderer/plan-modal.js: <agent>-plan.md tagged [plan, devloop], and
  // <agent>-design.md tagged [design, devloop] titled "Design: <task>".
  writeSessionNote(worktreeDir, {
    id: 'claude-plan',
    agent: 'claude',
    provider: 'anthropic',
    tags: ['plan', 'devloop'],
    content: '- [ ] Add the cache\n- [ ] Wire it up',
    timestamp: '2026-10-13T10:00:00Z',
  });
  writeSessionNote(worktreeDir, {
    id: 'claude-design',
    agent: 'claude',
    provider: 'anthropic',
    tags: ['design', 'devloop'],
    title: 'Design: add a response cache',
    content: '## Approach\nAn LRU in front of the client.',
    timestamp: '2026-10-13T10:00:01Z',
  });

  try {
    const plan = await findPlanDoc(worktreeDir);
    assert.ok(plan.content.includes('- [ ] Add the cache'));
    const design = await findDesignDoc(worktreeDir);
    assert.ok(design.content.includes('## Approach'));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
