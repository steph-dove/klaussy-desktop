// Every visible button and tab on the main screens must be reachable by saying
// its name, and saying a control's exact name must not run some other command.

/* global window,document */
const { test, expect } = require('./fixtures');
const { openShellTask, buildRepo } = require('./helpers');

const PR_STATE = {
  number: 5,
  meta: { title: 'Coverage PR', state: 'OPEN', author: { login: 'dev' }, headRefName: 'f', baseRefName: 'main' },
  diff: 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-a\n+b\n',
  threads: [],
};

function audit(page) {
  return page.evaluate(() => {
    const sel = 'button, [role="tab"], [role="button"], [role="menuitem"], a[href]';
    const nameOf = (el) => (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
    const names = [...document.querySelectorAll(sel)]
      .filter((el) => !el.classList.contains('voice-btn') && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
        && !el.closest('[inert]') && el.getClientRects().length)
      .map(nameOf)
      .filter((n) => n && n.length <= 60);
    const V = window.VoiceText;
    const palette = window.App.buildPaletteCommands();
    const dialog = document.body.classList.contains('dialog-open');
    const problems = [];
    names.forEach((name) => {
      const i = V.pickControl('select ' + name, names, window.AppUtils.fuzzyMatch);
      if (i < 0 || V.normalize(names[i]) !== V.normalize(name)) problems.push('unreachable: ' + name);
      if (dialog || V.exactControl(name, names) >= 0) return;
      const m = V.matchCommand(name, palette);
      if (m && m.kind === 'command' && V.normalize(m.command.label) !== V.normalize(name)) {
        problems.push('hijacked: ' + name + ' -> ' + m.command.label);
      }
    });
    return problems;
  });
}

test.describe('voice reaches every control by name', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await mainWindow.waitForLoadState('networkidle');
    await mainWindow.addStyleTag({ content: '#ollama-consent-overlay { display: none !important; }' });
  });

  test('dashboard and New Session', async ({ mainWindow }) => {
    expect(await audit(mainWindow)).toEqual([]);
    await mainWindow.evaluate(() => window.Voice.handleTranscript('new session', 'auto'));
    await expect(mainWindow.locator('#modal-overlay')).toBeVisible();
    expect(await audit(mainWindow)).toEqual([]);
  });

  test('a session with its side panel and the agents list', async ({ mainWindow }) => {
    await openShellTask(mainWindow, buildRepo());
    await mainWindow.evaluate(() => window.Voice.handleTranscript('show changes', 'auto'));
    expect(await audit(mainWindow)).toEqual([]);
    await mainWindow.evaluate(() => window.AgentsPanel.show());
    expect(await audit(mainWindow)).toEqual([]);
  });

  test('every PR review tab', async ({ mainWindow }) => {
    await mainWindow.evaluate(() => window.App.enterPrReviewMode());
    await expect.poll(() => mainWindow.locator('#pr-review-root .pr-review-loading').textContent(), { timeout: 8000 }).toMatch(/No active/);
    for (const tab of ['files', 'conversation', 'checks', 'ai-review', 'terminal']) {
      await mainWindow.evaluate(({ s, tab }) => { window.PrReview.activeTab = tab; window.PrReview.render(s); }, { s: PR_STATE, tab });
      expect(await audit(mainWindow), tab).toEqual([]);
    }
  });
});
