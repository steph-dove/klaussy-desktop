/* global window,document */
// The chat agent and implement runs each get their own xterm; sharing one let a
// TUI repaint over the other's output and garble the screen.
const { test, expect } = require('./fixtures');

const STATE = {
  number: 5,
  meta: { title: 'Terminal split', state: 'OPEN', author: { login: 'dev' }, headRefName: 'f', baseRefName: 'main' },
  diff: '',
  threads: [],
};

function visibleText(page) {
  return page.evaluate(() => {
    const PR = window.PrReview;
    const body = document.querySelector('#pr-implement-terminal-host .pr-implement-terminal-body');
    if (!body) return { mounted: 0, text: '' };
    const shown = [PR.chatTerminal, PR.implTerminal].find((rt) => rt && rt.terminal.element && rt.terminal.element.parentElement === body);
    return {
      mounted: body.querySelectorAll('.xterm').length,
      text: shown ? shown.terminal.buffer.active.getLine(0).translateToString(true) : '',
    };
  });
}

test('chat and implement runs render in separate xterms with a switch', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');
  await mainWindow.addStyleTag({ content: '#ollama-consent-overlay { display: none !important; }' });

  // The embedded PR review (the pop-out window doesn't load xterm). Mounting
  // fetches the (empty) review state, so wait for that before rendering ours.
  await mainWindow.evaluate(() => {
    const root = document.getElementById('pr-review-root');
    root.style.display = '';
    window.PrReview.mount({ host: root, isPopout: false });
  });
  await expect.poll(() => mainWindow.locator('#pr-review-root .pr-review-loading').textContent(), { timeout: 8000 }).toMatch(/No active/);
  await mainWindow.evaluate((s) => {
    const PR = window.PrReview;
    // First render of a PR resets its terminals, so set them up after it.
    PR.render(s);
    PR.activeTab = 'terminal';
    PR.ensureChatTerminal().terminal.write('CHAT-SCREEN');
    PR.ensureImplTerminal().terminal.write('IMPL-SCREEN');
    PR.implRun = { requestId: 'impl-test', status: 'done', finalized: true };
    PR.terminalView = 'impl';
    PR.render(s);
  }, STATE);

  await expect.poll(() => visibleText(mainWindow)).toEqual({ mounted: 1, text: 'IMPL-SCREEN' });
  await expect(mainWindow.locator('.pr-term-view[data-view="impl"]')).toHaveAttribute('aria-pressed', 'true');

  await mainWindow.locator('.pr-term-view[data-view="chat"]').click();
  await expect.poll(() => visibleText(mainWindow)).toEqual({ mounted: 1, text: 'CHAT-SCREEN' });
  await expect(mainWindow.locator('.pr-term-view[data-view="chat"]')).toHaveAttribute('aria-pressed', 'true');

  await mainWindow.locator('.pr-term-view[data-view="impl"]').click();
  await expect.poll(() => visibleText(mainWindow)).toEqual({ mounted: 1, text: 'IMPL-SCREEN' });
});
