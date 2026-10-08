/* global window,document */
const path = require('path');
const { test, expect } = require('./fixtures');
const { buildRepo, rm, openShellTask } = require('./helpers');

test.describe('focus and announcements, round 5', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await mainWindow.waitForLoadState('networkidle');
    await mainWindow.evaluate(() => { const o = document.getElementById('ollama-consent-overlay'); if (o) o.remove(); });
  });

  test('a busy button keeps focus, swallows clicks and gets its label back', async ({ mainWindow }) => {
    await mainWindow.evaluate(() => {
      const btn = document.createElement('button');
      btn.id = 'busy-probe';
      btn.textContent = 'Save';
      window.busyClicks = 0;
      btn.addEventListener('click', () => { window.busyClicks++; });
      document.body.appendChild(btn);
      btn.focus();
      window.busyDone = window.A11y.busy(btn, 'Saving…');
    });
    const btn = mainWindow.locator('#busy-probe');
    await expect(btn).toHaveText('Saving…');
    await expect(btn).toHaveAttribute('aria-busy', 'true');
    await mainWindow.keyboard.press('Enter');
    expect(await mainWindow.evaluate(() => window.busyClicks)).toBe(0);
    await expect(btn).toBeFocused();
    await mainWindow.evaluate(() => window.busyDone());
    await expect(btn).toHaveText('Save');
    await mainWindow.keyboard.press('Enter');
    expect(await mainWindow.evaluate(() => window.busyClicks)).toBe(1);
  });

  test('a control disabled for good hands focus on instead of leaving it on the page', async ({ mainWindow }) => {
    await mainWindow.evaluate(() => {
      const box = document.createElement('div');
      box.id = 'reenable-probe';
      box.innerHTML = '<button id="gone">Clear all</button><button id="next">Reload</button>';
      document.body.appendChild(box);
      document.getElementById('gone').focus();
      document.getElementById('gone').disabled = true;
    });
    await expect.poll(() => mainWindow.evaluate(() => document.activeElement && document.activeElement.id), { timeout: 8000 }).toBe('next');
  });

  test('a field error restored silently is announced again on the next failure', async ({ mainWindow }) => {
    await mainWindow.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'err-probe';
      input.setAttribute('aria-label', 'Reply');
      document.body.appendChild(input);
      window.A11y.fieldError(input, 'Write a reply first.', null, { silent: true });
    });
    const err = mainWindow.locator('#err-probe-error');
    await expect(err).not.toHaveAttribute('role', 'alert');
    await mainWindow.evaluate(() => window.A11y.fieldError(document.getElementById('err-probe'), 'Write a reply first.'));
    await expect(err).toHaveAttribute('role', 'alert');
    await expect(mainWindow.locator('#err-probe')).toBeFocused();
  });

  test('the agents panel closes when focus leaves it', async ({ mainWindow }) => {
    await mainWindow.evaluate(() => window.AgentsPanel.show());
    const panel = mainWindow.locator('#agents-panel');
    await expect(panel).toBeVisible();
    await mainWindow.locator('#btn-agents-close').focus();
    await mainWindow.evaluate(() => {
      const outside = document.createElement('button');
      outside.id = 'outside-probe';
      outside.textContent = 'Elsewhere';
      document.body.appendChild(outside);
      outside.focus();
    });
    await expect(panel).toBeHidden();
  });

  test.describe('with a task', () => {
    let repo;
    let taskId;

    test.beforeEach(async ({ mainWindow }) => {
      repo = buildRepo({ 'src/app.js': 'const a = 1;\nconst b = 2;\n' }, 'a11y-r5');
      taskId = await openShellTask(mainWindow, repo);
    });

    test.afterEach(async ({ mainWindow }) => {
      await mainWindow.evaluate((id) => window.klaus.task.kill(id), taskId).catch(() => {});
      rm(repo);
    });

    async function openEditorAndStartEdit(mainWindow) {
      await mainWindow.evaluate((p) => window.openFileViewer(p, 'app.js'), path.join(repo, 'src/app.js'));
      await expect.poll(() => mainWindow.evaluate(() => !!(window.FileBrowser.getActiveEditor && window.FileBrowser.getActiveEditor())), { timeout: 15000 }).toBe(true);
      await mainWindow.evaluate(() => {
        const ed = window.FileBrowser.getActiveEditor();
        ed.focus();
        ed.setPosition({ lineNumber: 1, column: 1 });
        window.InlineEdit.start(ed);
      });
      const input = mainWindow.getByRole('textbox', { name: 'Tell the agent what to change' });
      await expect(input).toBeFocused();
      return input;
    }

    test('inline edit leaves focus on Reject when the proposal arrives', async ({ electronApp, mainWindow }) => {
      await electronApp.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('inline-edit-start');
        ipcMain.handle('inline-edit-start', (event, { requestId }) => {
          setTimeout(() => {
            event.sender.send('inline-edit-chunk-' + requestId, 'const a = 42;');
            event.sender.send('inline-edit-done-' + requestId, {});
          }, 1500);
          return { ok: true };
        });
      });
      const input = await openEditorAndStartEdit(mainWindow);
      await input.fill('use 42');
      await mainWindow.keyboard.press('Enter');
      const reject = mainWindow.getByRole('button', { name: 'Reject' });
      await expect(reject).toBeVisible();
      await reject.focus();
      await expect(mainWindow.getByRole('button', { name: /^Accept/ })).toBeEnabled({ timeout: 8000 });
      await expect(reject).toBeFocused();
    });

    test('Enter on the inline edit Cancel button cancels instead of submitting', async ({ electronApp, mainWindow }) => {
      await electronApp.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('inline-edit-start');
        ipcMain.handle('inline-edit-start', () => { globalThis.__inlineEditStarted = true; return { ok: true }; });
      });
      const input = await openEditorAndStartEdit(mainWindow);
      await input.fill('use 42');
      await mainWindow.locator('.inline-edit-prompt').getByRole('button', { name: 'Cancel' }).focus();
      await mainWindow.keyboard.press('Enter');
      await expect(mainWindow.locator('.inline-edit-prompt')).toHaveCount(0);
      await expect(mainWindow.locator('.inline-edit-stream')).toHaveCount(0);
      expect(await electronApp.evaluate(() => !!globalThis.__inlineEditStarted)).toBe(false);
    });
  });
});
