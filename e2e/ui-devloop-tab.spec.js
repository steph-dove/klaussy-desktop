// The two Dev Loop surfaces — the #diff-tabs button and the per-terminal mini
// HUD — belong to the session running the loop; they used to leak onto any
// session whose output tripped the phase detector.

/* global window, document, localStorage */

const { test, expect } = require('./fixtures');

const LOOP_ID = 9301;
const PLAIN_ID = 9302;

// Synthetic tasks: the panel only reads id, worktreePath and container, so no
// PTY has to exist.
async function seedTasks(mainWindow) {
  await mainWindow.evaluate(({ loopId, plainId }) => {
    [loopId, plainId].forEach((id) => {
      const container = document.createElement('div');
      container.id = 'e2e-task-' + id;
      document.body.appendChild(container);
      window.AppState.tasks.set(id, { id, worktreePath: '/tmp/e2e-devloop-' + id, container });
    });
    window.AppState.activeTaskId = loopId;
    // Through the app's own wiring: the panel's task:switched subscription is
    // part of what this covers.
    window.Events.emit('task:switched', { task: window.AppState.tasks.get(loopId) });
  }, { loopId: LOOP_ID, plainId: PLAIN_ID });
}

function cleanup(mainWindow) {
  return mainWindow.evaluate(({ loopId, plainId }) => {
    [loopId, plainId].forEach((id) => {
      window.AppState.tasks.delete(id);
      const el = document.getElementById('e2e-task-' + id);
      if (el) el.remove();
      localStorage.removeItem('klaussy-devloop:' + id);
      localStorage.removeItem('klaussy-devloop-wt:/tmp/e2e-devloop-' + id);
    });
    window.AppState.activeTaskId = null;
    window.Events.emit('task:switched', { task: null });
    const changes = document.querySelector('#diff-tabs .diff-tab[data-tab="changes"]');
    if (changes) changes.click();
  }, { loopId: LOOP_ID, plainId: PLAIN_ID });
}

test('dev loop surfaces show only on the session running the loop', async ({ mainWindow }) => {
  await mainWindow.waitForFunction(() => !!(window.DevLoopPanel && window.AppState));
  const devloopTab = mainWindow.locator('#diff-tabs .diff-tab[data-tab="devloop"]');

  try {
    await seedTasks(mainWindow);
    await expect(devloopTab).toBeHidden();

    // "gh pr create" is the phase-5 milestone, and any session may run it.
    await mainWindow.evaluate((id) => {
      window.DevLoopPanel.feedTerminalData(id, 'gh pr create --title fix\n');
    }, PLAIN_ID);
    await expect(devloopTab).toBeHidden();
    expect(await mainWindow.evaluate((id) => window.DevLoopPanel.getState(id), PLAIN_ID)).toBeNull();

    await mainWindow.evaluate((id) => window.DevLoopPanel.startDevLoop(id, 'demo dev loop'), LOOP_ID);
    await expect(devloopTab).toBeVisible();
    await expect(mainWindow.locator('#e2e-task-' + LOOP_ID + ' .terminal-devloop-minihud')).toBeVisible();
    await expect(mainWindow.locator('#e2e-task-' + PLAIN_ID + ' .terminal-devloop-minihud')).toHaveCount(0);

    // Switching sessions must settle the tab immediately — it used to wait
    // behind the worktree scan and `gh pr view` that loading the panel runs.
    const switchTo = (id) => mainWindow.evaluate((to) => {
      window.AppState.activeTaskId = to;
      window.Events.emit('task:switched', { task: window.AppState.tasks.get(to) });
    }, id);

    await switchTo(PLAIN_ID);
    await expect(devloopTab).toBeHidden({ timeout: 2000 });
    await switchTo(LOOP_ID);
    await expect(devloopTab).toBeVisible({ timeout: 2000 });
  } finally {
    await cleanup(mainWindow).catch(() => {});
  }
});

// Switching to Designs or QA used to wait on a worktree scan and a `gh pr view`
// spawn before painting anything, so the click looked dead for a second or more.
test('a dev loop sub-tab paints without waiting for the refresh', async ({ mainWindow }) => {
  await mainWindow.waitForFunction(() => !!(window.DevLoopPanel && window.AppState));

  try {
    await seedTasks(mainWindow);
    await mainWindow.evaluate((id) => window.DevLoopPanel.startDevLoop(id, 'demo dev loop'), LOOP_ID);
    await expect(mainWindow.locator('.devloop-subtab[data-sub="design"]')).toBeVisible();

    // Read back in the same turn as the click: a synchronous repaint has
    // already happened by the time click() returns.
    const painted = await mainWindow.evaluate(() => {
      document.querySelector('.devloop-subtab[data-sub="design"]').click();
      const active = document.querySelector('.devloop-subtab.active');
      return {
        sub: active ? active.dataset.sub : null,
        body: (document.querySelector('.devloop-body') || {}).textContent || '',
      };
    });

    expect(painted.sub, 'the clicked sub-tab is active immediately').toBe('design');
    expect(painted.body, 'and says it is loading rather than showing a stale or empty answer')
      .toContain('Loading');
  } finally {
    await cleanup(mainWindow).catch(() => {});
  }
});
