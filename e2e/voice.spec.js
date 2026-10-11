// CI has no microphone or model, so transcripts go straight to Voice.handleTranscript and voice-prepare is stubbed.

/* global window,document */
const fs = require('fs');
const path = require('path');
const { test, expect } = require('./fixtures');
const { openShellTask, tmpDir, rm } = require('./helpers');

function readConfig(userDataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8')); } catch { return {}; }
}

async function ready(mainWindow) {
  await mainWindow.waitForLoadState('networkidle');
  await mainWindow.addStyleTag({ content: '#ollama-consent-overlay { display: none !important; }' });
  await expect(mainWindow.locator('#btn-new-task')).toBeVisible();
}

async function withShellTask(mainWindow, fn) {
  const dir = tmpDir('voice');
  try {
    const id = await openShellTask(mainWindow, dir);
    await fn(id);
  } finally {
    rm(dir);
  }
}

test.describe('voice input off', () => {
  test('the mic button is always shown and starts off', async ({ mainWindow }) => {
    await ready(mainWindow);
    const btn = mainWindow.locator('#btn-voice');
    await expect(btn).toBeVisible();
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  test('clicking the mic button turns voice on and off and saves it', async ({ electronApp, mainWindow, userDataDir }) => {
    await ready(mainWindow);
    const btn = mainWindow.locator('#btn-voice');
    const [prefsWin] = await Promise.all([
      electronApp.waitForEvent('window'),
      mainWindow.evaluate(() => window.klaus.ui.openPreferences()),
    ]);
    await prefsWin.waitForLoadState('domcontentloaded');
    const box = prefsWin.locator('#pref-voice-input');
    await expect(box).not.toBeChecked();

    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => readConfig(userDataDir).voiceInput, { timeout: 5000 }).toBe(true);
    await expect(box).toBeChecked();

    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => readConfig(userDataDir).voiceInput, { timeout: 5000 }).toBe(false);
    await expect(box).not.toBeChecked();
    await prefsWin.close();
  });

  test('ticking the Preferences checkbox turns voice on right away', async ({ electronApp, mainWindow, userDataDir }) => {
    await ready(mainWindow);
    const [prefsWin] = await Promise.all([
      electronApp.waitForEvent('window'),
      mainWindow.evaluate(() => window.klaus.ui.openPreferences()),
    ]);
    await prefsWin.waitForLoadState('domcontentloaded');
    await prefsWin.locator('#pref-voice-input').check();
    await expect.poll(() => readConfig(userDataDir).voiceInput, { timeout: 5000 }).toBe(true);
    await expect(mainWindow.locator('#btn-voice')).toHaveAttribute('aria-pressed', 'true');
    await prefsWin.close();
  });
});

test.describe('voice input on', () => {
  test.use({ configSeed: { voiceInput: true } });

  test.beforeEach(async ({ mainWindow }) => {
    await ready(mainWindow);
    await expect(mainWindow.locator('#btn-voice')).toHaveAttribute('aria-pressed', 'true');
  });

  test('"open pr review" opens the PR picker', async ({ mainWindow }) => {
    const ran = await mainWindow.evaluate(() => window.Voice.handleTranscript('Open PR review.', 'command'));
    expect(ran).toBe(true);
    await expect(mainWindow.locator('.pr-picker-overlay')).toBeVisible();
  });

  test('"new session" opens the New Task dialog', async ({ mainWindow }) => {
    await mainWindow.evaluate(() => window.Voice.handleTranscript('new session', 'command'));
    await expect(mainWindow.locator('#modal-overlay')).toBeVisible();
    await mainWindow.locator('#modal-cancel').click();
  });

  test('"view changes" shows the diff panel for the active task', async ({ mainWindow }) => {
    await withShellTask(mainWindow, async () => {
      await mainWindow.evaluate(() => window.Voice.handleTranscript('view changes', 'command'));
      await expect(mainWindow.locator('#diff-panel')).toBeVisible();
    });
  });

  test('an unmatched command says so instead of guessing', async ({ mainWindow }) => {
    const ran = await mainWindow.evaluate(() => window.Voice.handleTranscript('what is the weather', 'command'));
    expect(ran).toBe(false);
    await expect(mainWindow.locator('.klaussy-toast', { hasText: 'No command matched' })).toBeVisible();
  });

  test('dictation pastes sanitized text into the active terminal without Enter', async ({ mainWindow }) => {
    await withShellTask(mainWindow, async (id) => {
      const pasted = await mainWindow.evaluate((taskId) => {
        const term = window.AppState.tasks.get(taskId).terminal;
        const calls = [];
        const orig = term.paste.bind(term);
        term.paste = (s) => { calls.push(s); orig(s); };
        window.Voice.handleTranscript('echo hello\x1b[201~\rworld', 'dictate');
        term.paste = orig;
        return calls;
      }, id);
      expect(pasted).toEqual(['echo hello world ']);
    });
  });

  test('dictation with no open task explains what to do', async ({ mainWindow }) => {
    const ran = await mainWindow.evaluate(() => window.Voice.handleTranscript('hello', 'dictate'));
    expect(ran).toBe(false);
    await expect(mainWindow.locator('.klaussy-toast', { hasText: 'Open an agent tab' })).toBeVisible();
  });

  test('the dictate shortcut starts voice input and never reaches the terminal', async ({ electronApp, mainWindow }) => {
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('voice-prepare');
      ipcMain.handle('voice-prepare', () => ({ ok: false, error: 'stubbed: no microphone in e2e' }));
    });
    await withShellTask(mainWindow, async (id) => {
      await mainWindow.evaluate((taskId) => {
        const term = window.AppState.tasks.get(taskId).terminal;
        window.__typed = '';
        window.__typedSub = term.onData((d) => { window.__typed += d; });
        term.focus();
      }, id);
      const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
      await mainWindow.keyboard.press(`${mod}+Shift+Space`);
      await expect(mainWindow.locator('.klaussy-toast', { hasText: 'stubbed: no microphone' })).toBeVisible();
      await mainWindow.keyboard.type('x');
      await expect.poll(() => mainWindow.evaluate(() => window.__typed)).toBe('x');
      await mainWindow.evaluate(() => window.__typedSub.dispose());
      await expect(mainWindow.locator('#btn-voice')).not.toHaveClass(/recording/);
    });
  });

  test('the shortcut is listed in the Keyboard shortcuts dialog', async ({ mainWindow }) => {
    const rows = await mainWindow.evaluate(() => {
      window.Dialogs.showShortcuts();
      return document.body.innerText;
    });
    expect(rows).toContain('Dictate into the active agent');
    expect(rows).toContain('Speak a command');
  });
});
