/* global window,document */
// Azure DevOps UI: the Connect dialog, its Git Accounts section and the PR
// picker, with the main-process IPC stubbed so no token or network is involved.
const path = require('path');
const { test, expect } = require('./fixtures');
const AxeBuilder = require('@axe-core/playwright').default;

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const CONTOSO = {
  id: 'azure:dev.azure.com:contoso:ada%40contoso.com',
  host: 'dev.azure.com',
  collectionPath: 'contoso',
  collectionUrl: 'https://dev.azure.com/Contoso',
  user: 'ada@contoso.com',
  active: true,
  needsReentry: false,
};
const SERVER = {
  id: 'azure:tfs.contoso.local:tfs%2Fdefaultcollection:ada',
  host: 'tfs.contoso.local',
  collectionPath: 'tfs/defaultcollection',
  collectionUrl: 'https://tfs.contoso.local/tfs/DefaultCollection',
  user: 'ada',
  active: true,
  needsReentry: false,
};

// contextBridge objects are frozen, so IPC is stubbed in the main process.
// Each stub records the args it was called with on global.__azureCalls.
async function stubIpc(electronApp, replies) {
  await electronApp.evaluate(({ ipcMain }, byChannel) => {
    global.__azureCalls = global.__azureCalls || {};
    for (const [channel, reply] of Object.entries(byChannel)) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_e, args) => {
        (global.__azureCalls[channel] = global.__azureCalls[channel] || []).push(args);
        return reply;
      });
    }
  }, replies);
}

const callsTo = (electronApp, channel) => electronApp.evaluate((_e, ch) => (global.__azureCalls || {})[ch] || [], channel);

const NO_OTHER_ACCOUNTS = {
  'gh-list-accounts': { accounts: [] },
  'glab-list-accounts': { accounts: [] },
  'bitbucket-list-accounts': { accounts: [] },
};

test.describe('Azure DevOps', () => {
  test.beforeEach(async ({ electronApp, mainWindow }) => {
    await mainWindow.waitForLoadState('networkidle');
    await mainWindow.addStyleTag({ content: '#ollama-consent-overlay { display: none !important; }' });
    await electronApp.evaluate(() => { global.__azureCalls = {}; });
  });

  test('Connect dialog: a non-Azure URL errors on the field without calling main', async ({ electronApp, mainWindow }) => {
    await stubIpc(electronApp, { 'azure-save-account': { account: CONTOSO } });
    await mainWindow.evaluate(() => window.Dialogs.showAzureLogin());
    const url = mainWindow.locator('#az-url-input');
    await expect(url).toBeFocused();

    await url.fill('https://github.com/contoso');
    await mainWindow.locator('#az-pat-input').fill('token');
    await mainWindow.locator('#az-save-btn').click();
    await expect(url).toBeFocused();
    await expect(url).toHaveAttribute('aria-invalid', 'true');
    await expect(url).toHaveAccessibleDescription(/isn't an Azure DevOps URL/);
    expect(await callsTo(electronApp, 'azure-save-account')).toHaveLength(0);
  });

  test('Connect dialog: a rejected token and missing secure storage each say what to do', async ({ electronApp, mainWindow }) => {
    await stubIpc(electronApp, { 'azure-save-account': { error: 'HTTP 401: ', errorKind: 'auth', errorSummary: 'x', errorFix: 'y' } });
    await mainWindow.evaluate(() => window.Dialogs.showAzureLogin());
    await mainWindow.locator('#az-url-input').fill('https://dev.azure.com/contoso');
    await mainWindow.locator('#az-pat-input').fill('expired-token');
    await mainWindow.locator('#az-save-btn').click();

    const err = mainWindow.locator('#az-login-error');
    await expect(err).toHaveAttribute('role', 'alert');
    await expect(err).toHaveText(/didn't accept that token/);
    await expect(mainWindow.locator('#az-pat-input')).toBeFocused();
    await expect(mainWindow.locator('#az-save-btn')).toHaveText('Connect');
    expect(await callsTo(electronApp, 'azure-save-account')).toEqual([{ collection: 'https://dev.azure.com/contoso', pat: 'expired-token' }]);

    await stubIpc(electronApp, { 'azure-save-account': { error: 'no keychain', errorKind: 'unavailable', errorSummary: 'x', errorFix: '' } });
    await mainWindow.locator('#az-save-btn').click();
    await expect(err).toHaveText(/AZURE_DEVOPS_EXT_PAT/);
  });

  test('Connect dialog: a saved token closes the dialog', async ({ electronApp, mainWindow }) => {
    await stubIpc(electronApp, { 'azure-save-account': { account: CONTOSO } });
    await mainWindow.evaluate(() => window.Dialogs.showAzureLogin());
    await mainWindow.locator('#az-url-input').fill('contoso');
    await mainWindow.locator('#az-pat-input').fill('good-token');
    await mainWindow.locator('#az-save-btn').click();
    await expect(mainWindow.locator('#az-title')).toHaveCount(0);
  });

  test('Connect dialog passes an axe scan', async ({ mainWindow }) => {
    await mainWindow.evaluate(() => window.Dialogs.showAzureLogin());
    await expect(mainWindow.locator('#az-title')).toBeVisible();
    const { violations } = await new AxeBuilder({ page: mainWindow }).setLegacyMode(true).withTags(TAGS)
      .include('.gh-login-dialog').analyze();
    expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  test('Git Accounts lists Azure accounts with a named Remove and flags an unreadable token', async ({ electronApp, mainWindow }) => {
    await stubIpc(electronApp, {
      ...NO_OTHER_ACCOUNTS,
      'azure-list-accounts': { accounts: [{ ...CONTOSO, needsReentry: true }, { ...SERVER, active: false }] },
    });
    await mainWindow.evaluate(() => window.Dialogs.showGhAccounts());
    const rows = mainWindow.locator('.gh-account-row[data-forge="azure"]');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('Re-enter PAT');
    await expect(rows.first()).toContainText('dev.azure.com/Contoso');
    await expect(mainWindow.getByRole('button', { name: 'Remove ada (tfs.contoso.local/tfs/DefaultCollection)' })).toBeVisible();
    await expect(mainWindow.locator('.gh-accounts-body')).toContainText('This happens after the system keychain is reset');

    await rows.first().click();
    await expect(mainWindow.locator('#az-url-input')).toHaveValue('https://dev.azure.com/Contoso');
    await expect(mainWindow.locator('#az-pat-input')).toBeFocused();
  });

  test('PR picker: a pasted Azure URL picks the account for its organization', async ({ electronApp, mainWindow }) => {
    await stubIpc(electronApp, {
      ...NO_OTHER_ACCOUNTS,
      'azure-list-accounts': { accounts: [SERVER, CONTOSO] },
      'pr-recent': { items: [{ number: 482, title: 'Retry the webhook', url: 'https://dev.azure.com/Contoso/Web/_git/web/pullrequest/482', state: 'OPEN' }] },
      'pr-recent-repos': { repos: [] },
      'pr-authored': { prs: [] },
    });
    await mainWindow.evaluate(() => window.App.showPrPicker());
    const overlay = mainWindow.locator('.pr-picker-overlay');
    await expect(overlay.locator('.pr-picker-account option')).toHaveCount(2);
    await expect(overlay.locator('.pr-forge-azure')).toHaveText('Azure DevOps');

    await overlay.locator('.pr-picker-url').fill('https://dev.azure.com/Contoso/Web/_git/web/pullrequest/482');
    await expect(overlay.locator('.pr-picker-account-hint')).toHaveText('Azure DevOps PR detected. Will use ada@contoso.com (Contoso).');
    await expect(overlay.locator('.pr-picker-account')).toHaveValue(CONTOSO.id);

    // A project-less Server URL under /tfs/DefaultCollection still finds its saved account.
    await overlay.locator('.pr-picker-url').fill('https://tfs.contoso.local/tfs/DefaultCollection/_git/web/pullrequest/3');
    await expect(overlay.locator('.pr-picker-account-hint')).toHaveText('Azure DevOps PR detected. Will use ada (tfs.contoso.local).');
    await expect(overlay.locator('.pr-picker-account')).toHaveValue(SERVER.id);
  });

  test('PR picker: with no Azure account, a pasted Azure URL offers Connect', async ({ electronApp, mainWindow }) => {
    await stubIpc(electronApp, {
      ...NO_OTHER_ACCOUNTS,
      'gh-list-accounts': { accounts: [{ username: 'ada-lovelace', active: true, valid: true }] },
      'azure-list-accounts': { accounts: [] },
      'pr-recent': { items: [] },
      'pr-recent-repos': { repos: [] },
      'pr-authored': { prs: [] },
    });
    await mainWindow.evaluate(() => window.App.showPrPicker());
    const overlay = mainWindow.locator('.pr-picker-overlay');
    await expect(overlay.getByRole('button', { name: 'Connect Azure DevOps…' })).toBeVisible();
    await overlay.locator('.pr-picker-url').fill('https://contoso.visualstudio.com/Web/_git/web/pullrequest/9');
    await expect(overlay.locator('.pr-picker-account-hint')).toHaveText('Azure DevOps PR detected. Connect an Azure DevOps account, or set AZURE_DEVOPS_EXT_PAT.');
  });

  test('PR window shows the diff being prepared, then a failure with Retry', async ({ electronApp, mainWindow }) => {
    await mainWindow.waitForLoadState('domcontentloaded');
    await stubIpc(electronApp, { 'pr-retry-diff': { ok: true } });
    const repoRoot = path.resolve(__dirname, '..');
    const [win] = await Promise.all([
      electronApp.waitForEvent('window'),
      electronApp.evaluate(({ BrowserWindow }, args) => {
        const w = new BrowserWindow({
          width: 1000, height: 700, show: false,
          webPreferences: { preload: args.preload, contextIsolation: true, nodeIntegration: false },
        });
        w.loadFile(args.htmlPath);
      }, { preload: path.join(repoRoot, 'preload.js'), htmlPath: path.join(repoRoot, 'renderer', 'pr-review.html') }),
    ]);
    await win.waitForLoadState('domcontentloaded');
    await expect.poll(() => win.locator('.pr-review-loading').textContent(), { timeout: 8000 }).toMatch(/No active PR review/);

    const base = {
      number: 482, forge: 'azure', diff: '', threads: [],
      meta: { title: 'Retry the webhook', state: 'OPEN', url: 'https://dev.azure.com/contoso/Web/_git/web/pullrequest/482' },
    };
    await win.evaluate((s) => window.PrReview.render(s), { ...base, diffPending: true });
    await expect(win.locator('.pr-review-preparing[role="status"]')).toContainText('Preparing the diff… fetching Web/web from Azure DevOps');

    await win.evaluate((s) => window.PrReview.render(s), { ...base, diffPending: false, diffError: 'Could not resolve host: dev.azure.com' });
    const alert = win.locator('.pr-review-load-error[role="alert"]');
    await expect(alert.getByRole('heading')).toHaveText('Couldn’t fetch Web/web from Azure DevOps');
    await expect(alert).toContainText('Could not resolve host: dev.azure.com');
    await expect(alert.getByRole('link', { name: 'Open on Azure DevOps' })).toBeVisible();
    const retry = alert.getByRole('button', { name: 'Retry' });
    await expect(retry).toBeFocused();

    // A later broadcast with the same error repaints without pulling focus back to Retry.
    await win.evaluate(() => document.activeElement.blur());
    await win.evaluate((s) => window.PrReview.render(s), { ...base, diffPending: false, diffError: 'Could not resolve host: dev.azure.com', threads: [] });
    await expect(retry).not.toBeFocused();

    await retry.click();
    await expect.poll(() => callsTo(electronApp, 'pr-retry-diff').then((c) => c.length)).toBe(1);
  });
});
