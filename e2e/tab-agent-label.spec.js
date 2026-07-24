// Primary-tab agent labels. When an agent CLI exits, the main process swaps
// the pty for a login shell and sets mode='shell'; the tab used to follow that
// and relabel itself "Shell", losing the task's identity. These drive the real
// render path (TerminalManager.refreshAgentChip, the same entry point app.js
// calls on conversion) against a hand-built tab DOM, so no pty is spawned.

/* global window, document */
const { test, expect } = require('./fixtures');

// Pin the model lookup in the main process. Stubbing window.klaus from the page
// is silently ignored — contextBridge objects are frozen — and the real handler
// falls back to the machine's configured CLI default, which isn't stable here.
const MODELS = { claude: 'opus', codex: 'gpt-5', gemini: 'gemini-2.5-pro' };

async function stubModelIpc(electronApp, models) {
  await electronApp.evaluate(({ ipcMain }, byMode) => {
    ipcMain.removeHandler('agent-current-model');
    ipcMain.handle('agent-current-model', (_e, { mode }) => ({ model: byMode[mode] || null }));
  }, models);
}

// The DOM here is the minimal shape updatePrimaryAgentTab queries: a sub-tab 0
// button wrapping a .sub-tab-label span.
async function seedTask(mainWindow, { id, mode }) {
  await mainWindow.evaluate((t) => {
    const container = document.createElement('div');
    container.id = 'tab-probe-' + t.id;
    container.innerHTML =
      '<button class="sub-tab" data-sub-id="0"><span class="sub-tab-label"></span></button>';
    document.body.appendChild(container);
    window.AppState.tasks.set(t.id, {
      id: t.id, mode: t.mode, worktreePath: '/tmp/tab-probe',
      container, subTerminals: [],
    });
    window.TerminalManager.refreshAgentChip(t.id);
  }, { id, mode });
  return mainWindow.locator('#tab-probe-' + id + ' .sub-tab-label');
}

// The mutation app.js performs on 'task-converted-to-shell' (renderer/app.js):
// remember the agent that exited, then flip mode to shell.
async function convertToShell(mainWindow, id) {
  await mainWindow.evaluate((taskId) => {
    const t = window.AppState.tasks.get(taskId);
    if (t.mode && t.mode !== 'shell') t.resumeAgent = t.mode;
    t.mode = 'shell';
    window.TerminalManager.refreshAgentChip(taskId);
  }, id);
}

test.beforeEach(async ({ electronApp, mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  await stubModelIpc(electronApp, MODELS);
});

test('a live agent tab shows the agent and its model', async ({ mainWindow }) => {
  const label = await seedTask(mainWindow, { id: 9001, mode: 'claude' });
  await expect(label).toHaveText('Claude Opus');
});

test('an exited agent keeps its label instead of becoming "Shell"', async ({ mainWindow }) => {
  const label = await seedTask(mainWindow, { id: 9002, mode: 'claude' });
  await expect(label).toHaveText('Claude Opus');

  await convertToShell(mainWindow, 9002);

  // The regression: this read "Shell" once the pty converted.
  await expect(label).toHaveText('Claude Opus');
});

test('an exited non-Claude agent keeps its own label', async ({ mainWindow }) => {
  const label = await seedTask(mainWindow, { id: 9003, mode: 'codex' });
  await convertToShell(mainWindow, 9003);
  await expect(label).toHaveText('GPT-5');
});

test('a task started as a shell still reads "Shell"', async ({ mainWindow }) => {
  // Guards the over-fix: labelling every converted tab with an agent would put
  // an agent name on a shell the user opened deliberately.
  const label = await seedTask(mainWindow, { id: 9004, mode: 'shell' });
  await expect(label).toHaveText('Shell');
});

test('Resume relabels from the live mode, not the agent that exited', async ({ mainWindow }) => {
  const label = await seedTask(mainWindow, { id: 9005, mode: 'claude' });
  await convertToShell(mainWindow, 9005);
  await expect(label).toHaveText('Claude Opus');

  // Resume sets mode back to an agent but leaves resumeAgent set, so a stale
  // resumeAgent must not outrank a live mode.
  await mainWindow.evaluate(() => {
    window.AppState.tasks.get(9005).mode = 'gemini';
    window.TerminalManager.refreshAgentChip(9005);
  });
  await expect(label).toHaveText('Gemini 2.5 Pro');
});
