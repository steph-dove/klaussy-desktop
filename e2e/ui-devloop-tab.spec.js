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
    await mainWindow.evaluate(({ loopId, plainId }) => {
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
    }, { loopId: LOOP_ID, plainId: PLAIN_ID }).catch(() => {});
  }
});
