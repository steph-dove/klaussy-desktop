/* global window,document */
const { test, expect } = require('./fixtures');

const announced = (page) => page.evaluate(() =>
  Array.from(document.querySelectorAll('.a11y-live')).map((el) => el.textContent).join(' | '));

const SKILLS = {
  skills: [{ name: 'demo-skill', path: '/tmp/a11y-r4/SKILL.md', source: 'user', kind: 'user', description: 'Demo', insert: '/demo-skill' }],
  commands: [],
};

// contextBridge objects are frozen, so IPC is stubbed in the main process.
async function stubIpc(electronApp, replies) {
  await electronApp.evaluate(({ ipcMain }, byChannel) => {
    for (const [channel, reply] of Object.entries(byChannel)) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => reply);
    }
  }, replies);
}

test.describe('about-log dialogs', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await mainWindow.waitForLoadState('networkidle');
    await mainWindow.addStyleTag({ content: '#ollama-consent-overlay { display: none !important; }' });
  });

  test('Bitbucket empty fields get an error tied to the field, which takes focus', async ({ mainWindow }) => {
    await mainWindow.evaluate(() => window.Dialogs.showBitbucketLogin());
    const username = mainWindow.locator('#bb-username-input');
    const password = mainWindow.locator('#bb-password-input');

    await mainWindow.locator('#bb-save-btn').click();
    await expect(username).toBeFocused();
    await expect(username).toHaveAttribute('aria-invalid', 'true');
    await expect(username).toHaveAccessibleDescription('Please enter a username.');

    await username.fill('someone');
    await expect(username).not.toHaveAttribute('aria-invalid', 'true');
    await mainWindow.locator('#bb-save-btn').click();
    await expect(password).toBeFocused();
    await expect(password).toHaveAccessibleDescription('Please enter an App Password or Token.');
    await expect(mainWindow.locator('#bb-login-error')).toHaveAttribute('role', 'alert');
  });

  test('MCP add-server: card pick focuses Name, errors land on fields, env rows are named', async ({ electronApp, mainWindow }) => {
    await stubIpc(electronApp, {
      'mcp-catalog': { catalog: [], categories: [] },
      'mcp-targets': { targets: [{ id: 'claude', name: 'Claude', installed: true, verified: true, isDefault: true, hasProjectScope: false, canSecretRef: true }] },
      'mcp-list': { servers: [] },
      'mcp-status': { byName: {} },
    });
    await mainWindow.evaluate(() => window.Dialogs.showMcpServers());
    await mainWindow.getByRole('button', { name: '+ Add server' }).click();
    await mainWindow.locator('.mcp-card-custom').click();

    const name = mainWindow.locator('#mcp-name');
    await expect(name).toBeFocused();

    await mainWindow.locator('.mcp-submit').click();
    await expect(name).toBeFocused();
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(name).toHaveAccessibleDescription('A server name is required.');
    await expect(mainWindow.locator('#mcp-error')).toHaveAttribute('role', 'alert');

    const add = mainWindow.getByRole('button', { name: '+ Add variable' });
    await add.click();
    await expect(mainWindow.getByRole('textbox', { name: 'Variable name 1' })).toBeFocused();
    await expect(mainWindow.getByRole('textbox', { name: 'Value 1' })).toBeVisible();
    await add.click();
    const second = mainWindow.getByRole('textbox', { name: 'Variable name 2' });
    await expect(second).toBeFocused();
    await second.fill('KEEP_ME');

    await mainWindow.getByRole('button', { name: 'Remove variable 1' }).click();
    const renumbered = mainWindow.getByRole('textbox', { name: 'Variable name 1' });
    await expect(renumbered).toBeFocused();
    await expect(renumbered).toHaveValue('KEEP_ME');
    await mainWindow.getByRole('button', { name: 'Remove variable 1' }).click();
    await expect(add).toBeFocused();

    await name.fill('demo');
    await mainWindow.locator('#mcp-command').fill('npx');
    await add.click();
    const bad = mainWindow.getByRole('textbox', { name: 'Variable name 1' });
    await bad.fill('bad-name');
    await mainWindow.locator('.mcp-submit').click();
    await expect(bad).toBeFocused();
    await expect(bad).toHaveAttribute('aria-invalid', 'true');
    await expect(bad).toHaveAccessibleDescription(/bad-name/);
  });

  test('skills search and editor have names', async ({ electronApp, mainWindow }) => {
    await stubIpc(electronApp, { 'list-skills': SKILLS, 'read-skill-file': { content: 'hello' } });
    await mainWindow.evaluate(() => window.Dialogs.showSkills());
    await expect(mainWindow.getByRole('textbox', { name: 'Search skills and commands' })).toBeVisible();
    await expect(mainWindow.getByRole('textbox', { name: 'Edit demo-skill' })).toHaveValue('hello');
  });

  test('slash launcher announces an empty result once, not per keystroke', async ({ electronApp, mainWindow }) => {
    await stubIpc(electronApp, { 'list-skills': SKILLS });
    await mainWindow.evaluate(() => window.Dialogs.showSlashLauncher());
    const input = mainWindow.locator('.slash-launcher .palette-input');
    await expect(mainWindow.locator('.slash-launcher .palette-item[data-i]')).toHaveCount(1);
    await input.focus();
    await mainWindow.keyboard.type('zzz');
    await expect.poll(() => announced(mainWindow)).toContain('No matching commands');
    const count = await announced(mainWindow).then((t) => t.split('No matching commands').length - 1);
    expect(count).toBe(1);
  });
});
