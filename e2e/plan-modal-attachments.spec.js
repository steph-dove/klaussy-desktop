/* global window, document, DataTransfer, DragEvent, File, atob, Uint8Array */

// Covers the action modal's attachments: text and files together, and images
// that arrive as bytes with no file behind them.
//
// Set QA_OUT to also write screenshots of each step into that directory.

const path = require('path');
const fs = require('fs');
const { test, expect } = require('./fixtures');

const QA_OUT = process.env.QA_OUT;
if (QA_OUT) fs.mkdirSync(QA_OUT, { recursive: true });

const TASK = 'Fix the header alignment on the settings page.\nThe spacing collapses below 900px.';

// A real 1x1 PNG. Dropped as bytes with no backing file, which is the shape a
// browser drag or a clipboard screenshot arrives in.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function shot(win, name) {
  if (QA_OUT) await win.screenshot({ path: path.join(QA_OUT, `${name}.png`) });
}

async function openModal(win) {
  await win.evaluate(() => {
    window.AppState = window.AppState || { tasks: new Map(), activeTaskId: 1 };
    window.AppState.tasks.set(1, { id: 1, name: 'QA task', worktreePath: '/tmp/qa' });
    window.ActionModal.open(1, 'rest-of-the-owl');
  });
  await expect(win.locator('#plan-modal-overlay')).toBeVisible();
}

async function dropImage(win, name) {
  await win.evaluate(({ b64, name }) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: 'image/png' }));
    document.getElementById('plan-modal').dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
  }, { b64: PNG_B64, name });
  // The bytes round-trip through main to get a temp path before the row lands.
  await expect(win.locator('#plan-file-list .plan-file-row', { hasText: name })).toBeVisible();
}

test('a dropped image attaches alongside the typed task instead of replacing it', async ({ mainWindow: win }) => {
  await openModal(win);
  await shot(win, '1-empty');

  await win.locator('#plan-modal-text').fill(TASK);
  await shot(win, '2-task-typed');

  await dropImage(win, 'settings-header-bug.png');
  await shot(win, '3-image-dropped');
  await dropImage(win, 'settings-header-expected.png');
  await shot(win, '4-second-image');

  // The task survives the drop, in the box and in what would be submitted.
  await expect(win.locator('#plan-modal-text')).toHaveValue(TASK);
  const submitted = await win.evaluate(() => window.ActionModal.composeSubmission(
    document.getElementById('plan-modal-text').value,
    Array.from(document.querySelectorAll('#plan-file-list .plan-file-row > span')).map((s) => s.title),
  ));
  expect(submitted).toContain('Fix the header alignment');
  expect(submitted).toContain('settings-header-bug.png');
  expect(submitted).toContain('settings-header-expected.png');
});

test('an image with no file behind it is persisted so it has a path to send', async ({ mainWindow: win }) => {
  await openModal(win);
  await dropImage(win, 'pasted.png');

  const attached = await win.evaluate(() =>
    Array.from(document.querySelectorAll('#plan-file-list .plan-file-row > span')).map((s) => s.title));
  expect(attached).toHaveLength(1);
  expect(path.isAbsolute(attached[0])).toBe(true);
  // Main wrote the real bytes, so the path points at a readable PNG.
  expect(fs.readFileSync(attached[0]).subarray(1, 4).toString()).toBe('PNG');
});

test('an attachment that main refuses says why, not just that it failed', async ({ mainWindow: win }) => {
  await openModal(win);
  await win.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([], 'broken.png', { type: 'image/png' }));
    document.getElementById('plan-modal').dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
  });
  await expect(win.locator('#plan-modal-error')).toContainText('broken.png');
  await expect(win.locator('#plan-modal-error')).toContainText('empty');
  await expect(win.locator('#plan-file-list .plan-file-row')).toHaveCount(0);
});

test('the modal titles itself by the action that opened it', async ({ mainWindow: win }) => {
  await openModal(win);
  await expect(win.locator('#plan-modal-title')).toContainText('Full Dev Loop');

  await win.evaluate(() => window.ActionModal.open(1, 'debug'));
  await expect(win.locator('#plan-modal-title')).toContainText('Debug');
});

test('an attachment can be removed again', async ({ mainWindow: win }) => {
  await openModal(win);
  await dropImage(win, 'one.png');
  await dropImage(win, 'two.png');
  await expect(win.locator('#plan-file-list .plan-file-row')).toHaveCount(2);

  await win.locator('.plan-file-remove').first().click();
  await expect(win.locator('#plan-file-list .plan-file-row')).toHaveCount(1);
  await expect(win.locator('#plan-file-display')).toContainText('two.png');
});

test('reopening the modal starts clean', async ({ mainWindow: win }) => {
  await openModal(win);
  await win.locator('#plan-modal-text').fill(TASK);
  await dropImage(win, 'stale.png');

  await win.evaluate(() => window.ActionModal.open(1, 'rest-of-the-owl'));
  await expect(win.locator('#plan-modal-text')).toHaveValue('');
  await expect(win.locator('#plan-file-list .plan-file-row')).toHaveCount(0);
  await expect(win.locator('#plan-file-display')).toContainText('No files attached');
});
