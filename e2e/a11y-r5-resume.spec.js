/* global window,document */
const { test, expect } = require('./fixtures');

const SESSION_ROOT = '/tmp/klaussy-e2e-r5/klaussy/sessions/demo';

async function showInactive(mainWindow, list) {
  await mainWindow.evaluate((wts) => {
    window.AppState.inactiveWorktrees = wts;
    window.Sidebar.rebuild();
  }, list);
}

test.describe('resume accessibility', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await mainWindow.waitForLoadState('networkidle');
    await mainWindow.addStyleTag({ content: '#ollama-consent-overlay { display: none !important; }' });
  });

  test('arrowing agents on the Existing tab moves focus without handing the session off', async ({ mainWindow }) => {
    await mainWindow.evaluate(() => window.App.showModal());
    await mainWindow.locator('#modal-tabs .modal-tab[data-tab="existing"]').click();
    const group = mainWindow.getByRole('radiogroup', { name: 'Run' });
    await expect(group).toHaveAttribute('aria-describedby', 'resume-agent-hint');
    await expect(group.locator('[aria-checked="true"]')).toHaveCount(0);

    const first = group.getByRole('radio').first();
    await first.focus();
    await mainWindow.keyboard.press('ArrowRight');
    await mainWindow.keyboard.press('ArrowRight');
    const third = group.getByRole('radio').nth(2);
    await expect(third).toBeFocused();
    await expect(group.locator('[aria-checked="true"]')).toHaveCount(0);
    expect(await mainWindow.evaluate(() => window.App.resumeAllAgentsWanted())).toBe(true);

    // Space is the deliberate pick; Shell avoids the agent-setup prompt for a missing CLI.
    await mainWindow.keyboard.press('End');
    const shell = group.getByRole('radio', { name: 'Shell' });
    await expect(shell).toBeFocused();
    await expect(group.locator('[aria-checked="true"]')).toHaveCount(0);
    await mainWindow.keyboard.press('Space');
    await expect(shell).toHaveAttribute('aria-checked', 'true');
    expect(await mainWindow.evaluate(() => window.App.resumeAllAgentsWanted())).toBe(false);

    await mainWindow.locator('#modal-tabs .modal-tab[data-tab="new"]').click();
    await expect(group).not.toHaveAttribute('aria-describedby', /.+/);
    await mainWindow.evaluate(() => window.App.hideModal());
  });

  test('saved-session buttons name the repo and agents', async ({ mainWindow }) => {
    await showInactive(mainWindow, [{
      isSavedSession: true, path: '/tmp/klaussy-e2e-r5/solo-wt', repoPath: '/tmp/klaussy-e2e-r5/my-repo', branch: 'feat-x',
      mode: 'claude', savedAt: Date.now(),
      savedAgents: [
        { mode: 'claude', sessionId: 'a', worktreePath: '/tmp/klaussy-e2e-r5/solo-wt' },
        { mode: 'copilot', sessionId: 'b', worktreePath: '/tmp/klaussy-e2e-r5/solo-wt' },
      ],
    }]);
    const resume = mainWindow.locator('.saved-session-resume');
    await expect(resume).toHaveAttribute('aria-label', /^Resume my-repo on feat-x \(Claude Code \+ GitHub Copilot\)$/);
    await expect(mainWindow.getByRole('button', { name: 'New session in my-repo on feat-x' })).toBeVisible();
  });

  test('a failed Resume keeps focus on the button and restores its label', async ({ electronApp, mainWindow }) => {
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('resume-session');
      ipcMain.handle('resume-session', () => new Promise((r) => setTimeout(() => r({ error: 'session file missing' }), 400)));
    });
    await showInactive(mainWindow, [{
      isSavedSession: true, path: '/tmp/klaussy-e2e-r5/one-wt', repoPath: '/tmp/klaussy-e2e-r5/one-repo', branch: 'main',
      mode: 'claude', sessionId: 'x', savedAt: Date.now(),
    }]);
    const resume = mainWindow.locator('.saved-session-resume');
    await resume.focus();
    await mainWindow.keyboard.press('Enter');
    await expect(resume).toHaveAttribute('aria-busy', 'true');
    await expect(resume).toHaveText('Resuming…');
    await expect(resume).toBeFocused();

    await expect(mainWindow.locator('.klaussy-toast', { hasText: 'Resume failed: session file missing' })).toBeVisible();
    await expect(resume).not.toHaveAttribute('aria-busy', 'true');
    await expect(resume).toHaveText('Resume');
    await expect(resume).toHaveAttribute('aria-label', /^Resume one-repo on main/);
    await expect(resume).toBeFocused();
  });

  test('Resume All reports failures instead of failing silently', async ({ electronApp, mainWindow }) => {
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('attach-worktree');
      ipcMain.handle('attach-worktree', (event, { worktreePath }) => new Promise((r) => setTimeout(() => (
        worktreePath.endsWith('repo-a') ? r({ error: 'not a git worktree' }) : r(null)
      ), 300)));
    });
    await showInactive(mainWindow, [
      { path: SESSION_ROOT + '/repo-a', repoPath: '/tmp/klaussy-e2e-r5/repo-a', branch: 'demo' },
      { path: SESSION_ROOT + '/repo-b', repoPath: '/tmp/klaussy-e2e-r5/repo-b', branch: 'demo' },
    ]);
    const resumeAll = mainWindow.locator('.session-group[data-session="demo"] .session-group-resume-btn');
    await resumeAll.focus();
    await mainWindow.keyboard.press('Enter');
    await expect(resumeAll).toHaveAttribute('aria-busy', 'true');
    await expect(resumeAll).toHaveAttribute('aria-disabled', 'true');
    await expect(resumeAll).toBeFocused();

    const toast = mainWindow.locator('.klaussy-toast', { hasText: 'Could not resume 2 of 2 in demo' });
    await expect(toast).toContainText('repo-a: not a git worktree');
    await expect(toast).toContainText('repo-b: no response from main process');
    await expect(resumeAll).not.toHaveAttribute('aria-busy', 'true');
    await expect(resumeAll).toBeFocused();
  });
});
