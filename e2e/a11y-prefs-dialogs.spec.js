/* global window,document */
const path = require('path');
const { test, expect } = require('./fixtures');

const planGatePath = path.resolve(__dirname, '..', 'main', 'state', 'plan-gate.js');

async function openPrefs(electronApp, mainWindow) {
  const [prefsWin] = await Promise.all([
    electronApp.waitForEvent('window'),
    mainWindow.evaluate(() => window.klaus.ui.openPreferences()),
  ]);
  await prefsWin.waitForLoadState('domcontentloaded');
  return prefsWin;
}

test.describe('preferences and dialogs', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await mainWindow.waitForLoadState('networkidle');
    await mainWindow.addStyleTag({ content: '#ollama-consent-overlay { display: none !important; }' });
  });

  test('preference controls are labelled, grouped and recordable by keyboard', async ({ electronApp, mainWindow }) => {
    const prefs = await openPrefs(electronApp, mainWindow);

    await expect(prefs.getByLabel('Font Size')).toHaveAttribute('id', 'pref-font-size');
    await expect(prefs.getByLabel('Slack webhook URL')).toBeVisible();
    await expect(prefs.getByRole('heading', { name: 'Terminal', level: 2 })).toBeVisible();
    // The checkbox state below is set after the async getPreferences(); wait for that init.
    await expect(prefs.locator('.key-input').first()).toBeVisible();

    const reader = prefs.getByRole('checkbox', { name: 'Optimize for screen readers' });
    const before = await reader.isChecked();
    await prefs.locator('label[for="pref-screen-reader"]').click();
    await expect(reader).toBeChecked({ checked: !before });
    await prefs.locator('label[for="pref-screen-reader"]').click();

    const swatches = prefs.getByRole('radiogroup', { name: 'Window color' });
    await expect(swatches.getByRole('radio', { name: 'Blue' })).toBeVisible();
    const checked = swatches.locator('[role="radio"][aria-checked="true"]');
    await expect(checked).toHaveCount(1);
    const names = await swatches.getByRole('radio').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
    const from = names.indexOf(await checked.getAttribute('aria-label'));
    await checked.focus();
    await prefs.keyboard.press('ArrowRight');
    const next = swatches.getByRole('radio', { name: names[(from + 1) % names.length], exact: true });
    await expect(next).toBeFocused();
    await expect(next).toHaveAttribute('aria-checked', 'true');

    const shortcut = prefs.locator('.key-input').first();
    await shortcut.focus();
    await prefs.keyboard.press('Enter');
    await expect(shortcut).toHaveValue('Press keys...');
    await prefs.keyboard.press('Tab');
    await expect(shortcut).not.toHaveValue('Press keys...');
    await expect(shortcut).not.toBeFocused();
    await prefs.close();
  });

  test('plan approval ignores Escape and opens on the plan text', async ({ electronApp, mainWindow }) => {
    const pushRequest = (raw) => electronApp.evaluate(({}, args) => {
      const planGate = process.mainModule.require(args.planGatePath);
      const conn = { on: () => {}, removeListener: () => {} };
      globalThis.__a11yPlanSettled = false;
      globalThis.__a11yPlan = planGate.handlePlanApprovalRequest('/tmp/a11y-plan-e2e', { raw: args.raw }, conn);
      globalThis.__a11yPlan.then(() => { globalThis.__a11yPlanSettled = true; });
    }, { planGatePath, raw });

    await pushRequest('PLAN: touch one file');
    const overlay = mainWindow.locator('#plan-approval-overlay');
    await expect(overlay).toBeVisible();
    await expect(mainWindow.getByRole('region', { name: 'Proposed plan' })).toBeFocused();

    await mainWindow.keyboard.press('Escape');
    await expect(overlay).toBeVisible();
    expect(await electronApp.evaluate(() => globalThis.__a11yPlanSettled)).toBe(false);

    // Answering disables both buttons; the next request must open with them live again.
    await mainWindow.locator('#plan-approval-reject').click();
    expect(await electronApp.evaluate(() => globalThis.__a11yPlan)).toEqual({ approved: false });
    await expect(overlay).toBeHidden();

    await pushRequest('PLAN: second');
    await expect(overlay).toBeVisible();
    await expect(mainWindow.locator('#plan-approval-approve')).toBeEnabled();
    await mainWindow.locator('#plan-approval-reject').click();
    expect(await electronApp.evaluate(() => globalThis.__a11yPlan)).toEqual({ approved: false });
  });

  test('Ollama setup progress is exposed as a progress bar with step states', async ({ mainWindow }) => {
    const progress = await mainWindow.evaluate(() => {
      const bar = document.getElementById('ollama-progress-bar-wrap');
      const steps = Array.from(document.querySelectorAll('.ollama-progress-step .ollama-progress-state')).map((el) => el.textContent);
      return { role: bar.getAttribute('role'), name: bar.getAttribute('aria-label'), steps };
    });
    expect(progress.role).toBe('progressbar');
    expect(progress.name).toBe('Model download');
    expect(progress.steps).toEqual([', not started', ', not started', ', not started', ', not started']);
  });
});
