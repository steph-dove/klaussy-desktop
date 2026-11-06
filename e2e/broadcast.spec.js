/* global window,document */
// Fake task entries stand in for ptys (no posix_spawnp); writes are observed by an extra ipcMain 'write-terminal' listener.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');

function readConfig(userDataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8')); } catch { return {}; }
}

// The bar slides in on show; measuring the grip mid-animation makes the mouse-down miss it.
async function settledGripBox(mainWindow) {
  await mainWindow.locator('#broadcast-bar').evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  return mainWindow.locator('#btn-broadcast-grip').boundingBox();
}

async function addFakeTerminals(mainWindow) {
  await mainWindow.evaluate(() => {
    const fake = (id, branch, alive, subs) => ({
      id, name: id, branch, worktreePath: '/tmp/' + id, alive, mode: 'shell',
      subTerminals: subs.map(([subId, subAlive]) => ({ subId, alive: subAlive })),
    });
    window.AppState.tasks.set('bc-a', fake('bc-a', 'session-one', true, [['s1', true], ['s2', false]]));
    window.AppState.tasks.set('bc-b', fake('bc-b', 'session-two', false, []));
    window.AppState.tasks.set('bc-c', fake('bc-c', 'session-three', true, []));
    window.BroadcastBar.update();
  });
}

test.describe('broadcast bar', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await mainWindow.waitForLoadState('networkidle');
    await mainWindow.addStyleTag({ content: '#ollama-consent-overlay { display: none !important; }' });
  });

  test.afterEach(async ({ mainWindow }) => {
    await mainWindow.evaluate(() => {
      ['bc-a', 'bc-b', 'bc-c'].forEach((id) => window.AppState.tasks.delete(id));
    }).catch(() => {});
  });

  test('stays hidden until a terminal is open', async ({ mainWindow }) => {
    await expect(mainWindow.locator('#broadcast-bar')).toBeHidden();
    await expect(mainWindow.locator('#broadcast-toggle')).toBeHidden();
    await expect(mainWindow.locator('#broadcast-dock')).toBeHidden();
  });

  test('docks under the Active agents bar by default and sends to every open terminal across sessions', async ({ electronApp, mainWindow }) => {
    await electronApp.evaluate(({ ipcMain }) => {
      global.__bcWrites = [];
      ipcMain.on('write-terminal', (_e, p) => global.__bcWrites.push(p));
    });
    await addFakeTerminals(mainWindow);

    const bar = mainWindow.locator('#broadcast-dock > #broadcast-bar');
    await expect(bar).toBeVisible();
    await expect(bar).toHaveClass(/docked/);
    await expect(mainWindow.locator('#broadcast-toggle')).toBeHidden();
    const order = await mainWindow.evaluate(() => {
      const agents = document.getElementById('agents-bar');
      return agents.nextElementSibling && agents.nextElementSibling.id;
    });
    expect(order).toBe('broadcast-dock');

    await mainWindow.fill('#broadcast-input', 'echo hi');
    await mainWindow.press('#broadcast-input', 'Enter');

    await expect.poll(() => electronApp.evaluate(() => global.__bcWrites.length)).toBe(3);
    const writes = await electronApp.evaluate(() => global.__bcWrites);
    expect(writes.map((w) => w.id + ':' + (w.subId || '')).sort()).toEqual(['bc-a:', 'bc-a:s1', 'bc-c:']);
    expect(writes.every((w) => w.data === 'echo hi\r')).toBe(true);
    await expect(mainWindow.locator('.klaussy-toast', { hasText: 'Broadcasted command to 3 terminals' })).toBeVisible();
  });

  test('floats from the bar button, persists the pref, and docks back', async ({ mainWindow, userDataDir }) => {
    await addFakeTerminals(mainWindow);
    await mainWindow.click('#btn-broadcast-placement');

    const floating = mainWindow.locator('#terminal-area > #broadcast-bar');
    await expect(floating).toBeVisible();
    await expect(floating).not.toHaveClass(/docked/);
    await expect(mainWindow.locator('#broadcast-dock')).toBeHidden();
    await expect(mainWindow.locator('#btn-broadcast-grip')).toBeVisible();
    await expect.poll(() => readConfig(userDataDir).broadcastPlacement).toBe('floating');

    await mainWindow.click('#btn-broadcast-placement');
    await expect(mainWindow.locator('#broadcast-dock > #broadcast-bar')).toBeVisible();
    await expect.poll(() => readConfig(userDataDir).broadcastPlacement).toBe('sidebar');
  });

  test('floating bar drags by its grip, keeps the spot across collapse, and re-centers on double-click', async ({ mainWindow }) => {
    await addFakeTerminals(mainWindow);
    await mainWindow.click('#btn-broadcast-placement');
    const bar = mainWindow.locator('#broadcast-bar');
    await expect(bar).toBeVisible();

    await mainWindow.click('#btn-broadcast-grip');
    await expect(bar).not.toHaveClass(/dragged/);

    const area = await mainWindow.locator('#terminal-area').boundingBox();
    const grip = await settledGripBox(mainWindow);
    await mainWindow.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await mainWindow.mouse.down();
    await mainWindow.mouse.move(area.x + 60, area.y + 80, { steps: 8 });
    await mainWindow.mouse.up();

    await expect(bar).toHaveClass(/dragged/);
    const moved = await bar.boundingBox();
    expect(Math.abs(moved.y - area.y - 80)).toBeLessThan(30);
    expect(moved.x - area.x).toBeLessThan(80);

    await mainWindow.click('#btn-broadcast-close');
    const pill = mainWindow.locator('#broadcast-toggle');
    await expect(pill).toBeVisible();
    await expect(pill).toHaveClass(/dragged/);
    await pill.click();
    await expect(bar).toBeVisible();
    const back = await bar.boundingBox();
    expect(Math.abs(back.y - moved.y)).toBeLessThan(2);

    await mainWindow.dblclick('#btn-broadcast-grip');
    await expect(bar).not.toHaveClass(/dragged/);
  });

  test('a bar dragged to the right edge stays inside when the terminal area narrows', async ({ electronApp, mainWindow }) => {
    // Wide enough that the bar sits at its 650px cap instead of shrinking with the area.
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1700, 900));
    await expect.poll(() => mainWindow.evaluate(() => document.getElementById('terminal-area').clientWidth)).toBeGreaterThan(1100);
    await addFakeTerminals(mainWindow);
    await mainWindow.click('#btn-broadcast-placement');
    const bar = mainWindow.locator('#broadcast-bar');
    await expect(bar).toBeVisible();

    const area = await mainWindow.locator('#terminal-area').boundingBox();
    const grip = await settledGripBox(mainWindow);
    await mainWindow.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await mainWindow.mouse.down();
    await mainWindow.mouse.move(area.x + area.width - 5, area.y + 80, { steps: 8 });
    await mainWindow.mouse.up();
    await expect(bar).toHaveClass(/dragged/);

    // Widening the sidebar narrows #terminal-area with no window resize event.
    await mainWindow.evaluate(() => window.App.setSidebarWidth(1000));
    await expect.poll(() => mainWindow.evaluate(() => document.getElementById('terminal-area').clientWidth)).toBeLessThan(800);
    await expect.poll(async () => {
      const a = await mainWindow.locator('#terminal-area').boundingBox();
      const b = await bar.boundingBox();
      return b.x + b.width <= a.x + a.width + 1;
    }).toBe(true);
  });

  // No fake terminals here: the main window's font listener walks App.tasks and needs real xterm entries.
  test('the Preferences select switches placement live', async ({ electronApp, mainWindow, userDataDir }) => {
    await expect(mainWindow.locator('#broadcast-dock > #broadcast-bar')).toBeAttached();
    const [prefsWin] = await Promise.all([
      electronApp.waitForEvent('window'),
      mainWindow.evaluate(() => window.klaus.ui.openPreferences()),
    ]);
    await prefsWin.waitForLoadState('domcontentloaded');
    // The change listeners attach only after getPreferences resolves; a loaded font size marks that.
    await expect(prefsWin.locator('#pref-font-size')).not.toHaveValue('');
    const select = prefsWin.locator('#pref-broadcast-placement');
    await expect(select).toHaveValue('sidebar');
    await select.selectOption('floating');
    await expect.poll(() => readConfig(userDataDir).broadcastPlacement).toBe('floating');
    await expect(mainWindow.locator('#terminal-area > #broadcast-bar')).toBeAttached();
    await expect(mainWindow.locator('#broadcast-bar')).not.toHaveClass(/docked/);
    await prefsWin.close();
  });

  test('docking while the sidebar is collapsed hands focus to the sidebar toggle', async ({ mainWindow }) => {
    await addFakeTerminals(mainWindow);
    await mainWindow.click('#btn-broadcast-placement');
    await expect(mainWindow.locator('#terminal-area > #broadcast-bar')).toBeVisible();
    await mainWindow.evaluate(() => window.App.toggleSidebar());
    await expect(mainWindow.locator('#sidebar')).toHaveClass(/collapsed/);

    await mainWindow.focus('#btn-broadcast-placement');
    await mainWindow.keyboard.press('Enter');
    await expect(mainWindow.locator('#broadcast-dock > #broadcast-bar')).toBeAttached();
    await expect(mainWindow.locator('#btn-sidebar-toggle')).toBeFocused();
    await expect(mainWindow.locator('.klaussy-toast', { hasText: 'Broadcast docked in the sidebar' })).toBeVisible();
  });

  test('arrow-key nudges past the right edge are saved clamped', async ({ electronApp, mainWindow }) => {
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1700, 900));
    await expect.poll(() => mainWindow.evaluate(() => document.getElementById('terminal-area').clientWidth)).toBeGreaterThan(1100);
    await addFakeTerminals(mainWindow);
    await mainWindow.click('#btn-broadcast-placement');
    await mainWindow.evaluate(() => window.App.setSidebarWidth(700));
    await expect.poll(() => mainWindow.evaluate(() => document.getElementById('terminal-area').clientWidth)).toBeLessThan(1100);

    await mainWindow.focus('#btn-broadcast-grip');
    for (let i = 0; i < 30; i++) await mainWindow.keyboard.press('Shift+ArrowRight');

    // Widening the area must keep the bar flush right, not jump by the saved overshoot.
    await mainWindow.evaluate(() => window.App.setSidebarWidth(260));
    await expect.poll(() => mainWindow.evaluate(() => document.getElementById('terminal-area').clientWidth)).toBeGreaterThan(1300);
    await expect.poll(async () => {
      const a = await mainWindow.locator('#terminal-area').boundingBox();
      const b = await mainWindow.locator('#broadcast-bar').boundingBox();
      return Math.round(a.x + a.width - (b.x + b.width));
    }).toBeGreaterThan(250);
  });
});
