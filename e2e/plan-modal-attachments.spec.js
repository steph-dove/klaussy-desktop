/* global window, document, DataTransfer, DragEvent, File, atob, Uint8Array */

// Covers the action modal's attachments: text and files together, and images
// that arrive as bytes with no file behind them.
//
// Set QA_OUT to also write screenshots of each step into that directory.

const path = require('path');
const fs = require('fs');
const os = require('os');
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
  const before = await win.locator('#plan-file-list .plan-file-row').count();
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
  // Counted rather than matched by name, since two drops can share one.
  await expect(win.locator('#plan-file-list .plan-file-row')).toHaveCount(before + 1);
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

  // The task survives the drop; the paths land inline rather than replacing it.
  await expect(win.locator('#plan-modal-text')).toHaveValue(new RegExp('Fix the header alignment'));
  await expect(win.locator('#plan-modal-text')).toHaveValue(/\[settings-header-bug\.png\]/);
  const submitted = await win.evaluate(() =>
    window.ActionModal.attachments().compose(document.getElementById('plan-modal-text').value));
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

// The New Session dev-loop field runs through app-functions-2, not plan-modal.
test('the New Session dev loop field takes attachments alongside its task', async ({ mainWindow: win }) => {
  await win.evaluate(() => {
    window.App.showModal();
    const check = document.getElementById('modal-devloop-check');
    check.checked = true;
    check.dispatchEvent(new Event('change'));
  });
  await expect(win.locator('#modal-devloop-fields')).toBeVisible();

  await win.locator('#modal-devloop-prompt').fill(TASK);
  await win.evaluate(({ b64 }) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'session-bug.png', { type: 'image/png' }));
    document.getElementById('modal-devloop-fields').dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
  }, { b64: PNG_B64 });
  await expect(win.locator('#modal-devloop-file-list .plan-file-row')).toHaveCount(1);

  await expect(win.locator('#modal-devloop-prompt')).toHaveValue(new RegExp('Fix the header alignment'));
  const composed = await win.evaluate(() =>
    window.App.devLoopAttachments.compose(document.getElementById('modal-devloop-prompt').value));
  expect(composed).toContain('Fix the header alignment');
  expect(composed).toMatch(/klaussy-attachments\/[0-9a-f]+\/session-bug\.png/);
});

test('reopening New Session drops the previous run attachments', async ({ mainWindow: win }) => {
  await win.evaluate(() => {
    window.App.showModal();
    const check = document.getElementById('modal-devloop-check');
    check.checked = true;
    check.dispatchEvent(new Event('change'));
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3])], 'stale.png', { type: 'image/png' }));
    document.getElementById('modal-devloop-fields').dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
  });
  await expect(win.locator('#modal-devloop-file-list .plan-file-row')).toHaveCount(1);

  await win.evaluate(() => window.App.showModal());
  await expect(win.locator('#modal-devloop-file-list .plan-file-row')).toHaveCount(0);
});

test('a drop lands at the cursor so images sit next to what describes them', async ({ mainWindow: win }) => {
  await openModal(win);
  await win.locator('#plan-modal-text').fill('Current state:\n\nWhat it should be:');

  // Put the caret at the end of the first label, then drop.
  await win.evaluate(() => {
    const ta = document.getElementById('plan-modal-text');
    ta.focus();
    ta.selectionStart = ta.selectionEnd = 'Current state:'.length;
    ta.dispatchEvent(new Event('select'));
  });
  await dropImage(win, 'broken.png');

  await win.evaluate(() => {
    const ta = document.getElementById('plan-modal-text');
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    ta.dispatchEvent(new Event('select'));
  });
  await dropImage(win, 'goal.png');

  const value = await win.locator('#plan-modal-text').inputValue();
  expect(value.indexOf('Current state:')).toBeLessThan(value.indexOf('broken.png'));
  expect(value.indexOf('broken.png')).toBeLessThan(value.indexOf('What it should be:'));
  expect(value.indexOf('What it should be:')).toBeLessThan(value.indexOf('goal.png'));

  // Both are placed, so nothing gets repeated in a trailing block, and the
  // markers resolve to the real temp paths.
  const submitted = await win.evaluate(() =>
    window.ActionModal.attachments().compose(document.getElementById('plan-modal-text').value));
  expect(submitted).not.toContain('Attached files/folders');
  expect(submitted).not.toContain('[broken.png]');
  expect(submitted).toMatch(/klaussy-attachments\/[0-9a-f]+\/broken\.png/);
  expect(submitted.indexOf('Current state:')).toBeLessThan(submitted.indexOf('broken.png'));
});

test('removing an attachment takes its line out of the text', async ({ mainWindow: win }) => {
  await openModal(win);
  await win.locator('#plan-modal-text').fill('Look at this:');
  await win.evaluate(() => {
    const ta = document.getElementById('plan-modal-text');
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    ta.dispatchEvent(new Event('select'));
  });
  await dropImage(win, 'unwanted.png');
  await expect(win.locator('#plan-modal-text')).toHaveValue(/\[unwanted\.png\]/);

  await win.locator('.plan-file-remove').first().click();
  await expect(win.locator('#plan-modal-text')).not.toHaveValue(/unwanted\.png/);
  await expect(win.locator('#plan-modal-text')).toHaveValue(/Look at this:/);
});

test('clearing takes the markers with it, so none ship pointing at nothing', async ({ mainWindow: win }) => {
  await win.evaluate(() => {
    window.App.showModal();
    const check = document.getElementById('modal-devloop-check');
    check.checked = true;
    check.dispatchEvent(new Event('change'));
  });
  await win.locator('#modal-devloop-prompt').fill('Broken here:');
  await win.evaluate(() => {
    const ta = document.getElementById('modal-devloop-prompt');
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    ta.dispatchEvent(new Event('select'));
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3])], 'stale.png', { type: 'image/png' }));
    document.getElementById('modal-devloop-fields').dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
  });
  await expect(win.locator('#modal-devloop-prompt')).toHaveValue(/\[stale\.png\]/);

  // This dialog keeps its prose across opens, so a leftover marker would be
  // sent to the agent as literal text.
  await win.evaluate(() => window.App.showModal());
  await expect(win.locator('#modal-devloop-prompt')).not.toHaveValue(/stale\.png/);
  const composed = await win.evaluate(() =>
    window.App.devLoopAttachments.compose(document.getElementById('modal-devloop-prompt').value));
  expect(composed).not.toContain('stale.png');
});

test('removing an attachment leaves indented prose alone', async ({ mainWindow: win }) => {
  await openModal(win);
  const CODE = 'Repro:\n\n    function f() {\n        return 1;\n    }\n\nScreenshot:';
  await win.locator('#plan-modal-text').fill(CODE);
  await win.evaluate(() => {
    const ta = document.getElementById('plan-modal-text');
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    ta.dispatchEvent(new Event('select'));
  });
  await dropImage(win, 'shot.png');

  await win.locator('.plan-file-remove').first().click();
  // The snippet's indentation has to survive; only the marker goes.
  await expect(win.locator('#plan-modal-text')).toHaveValue(CODE);
});

test('a drop still in flight when the dialog resets is discarded', async ({ mainWindow: win }) => {
  await win.evaluate(() => {
    window.App.showModal();
    const check = document.getElementById('modal-devloop-check');
    check.checked = true;
    check.dispatchEvent(new Event('change'));
    document.getElementById('modal-devloop-prompt').value = 'first run';

    // Saving the bytes is async; resetting synchronously after the drop means
    // clear() lands first and the late result must not write itself back in.
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3])], 'inflight.png', { type: 'image/png' }));
    document.getElementById('modal-devloop-fields').dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
    window.App.showModal();
  });
  await win.waitForTimeout(1200);

  await expect(win.locator('#modal-devloop-prompt')).not.toHaveValue(/inflight\.png/);
  await expect(win.locator('#modal-devloop-file-list .plan-file-row')).toHaveCount(0);
});

test('markers stay out of the branch name derived from the task', async ({ mainWindow: win }) => {
  await win.evaluate(() => {
    window.App.showModal();
    const check = document.getElementById('modal-devloop-check');
    check.checked = true;
    check.dispatchEvent(new Event('change'));
  });
  await win.locator('#modal-devloop-prompt').fill('Fix the login redirect');
  await win.evaluate(() => {
    const ta = document.getElementById('modal-devloop-prompt');
    ta.focus();
    ta.selectionStart = ta.selectionEnd = 'Fix the'.length;
    ta.dispatchEvent(new Event('select'));
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' }));
    document.getElementById('modal-devloop-fields').dispatchEvent(
      new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
  });
  await expect(win.locator('#modal-devloop-prompt')).toHaveValue(/\[shot\.png\]/);

  // The name is derived from this; a marker mid-prose would land in the branch.
  const plain = await win.evaluate(() =>
    window.App.devLoopAttachments.plain(document.getElementById('modal-devloop-prompt').value));
  expect(plain).toBe('Fix the login redirect');
});

test('two files sharing a name get distinct markers', async ({ mainWindow: win }) => {
  await openModal(win);
  await dropImage(win, 'shot.png');
  await dropImage(win, 'shot.png');

  // Each drop of raw bytes is its own file, so the second must not point at
  // the first. The list carries both.
  const value = await win.locator('#plan-modal-text').inputValue();
  expect(value).toContain('[shot.png]');
  expect(value).toContain('[shot.png 2]');
  await expect(win.locator('#plan-file-list .plan-file-row')).toHaveCount(2);

  const submitted = await win.evaluate(() =>
    window.ActionModal.attachments().compose(document.getElementById('plan-modal-text').value));
  expect(submitted).not.toContain('[shot.png');
  const paths = await win.evaluate(() => window.ActionModal.attachments().paths());
  expect(new Set(paths).size).toBe(2);
  paths.forEach((p) => expect(submitted).toContain(p));
});

test('re-picking the same on-disk file references it again instead of doing nothing', async ({ mainWindow: win }) => {
  // A real file on disk resolves through getPathForFile, so both picks are the
  // same attachment. Dropped bytes mint a fresh temp path each time and so
  // cannot exercise this branch.
  const real = path.join(os.tmpdir(), `klaussy-e2e-dup-${Date.now()}.png`);
  fs.writeFileSync(real, Buffer.from(PNG_B64, 'base64'));
  const marker = `[${path.basename(real)}]`;

  await openModal(win);
  await win.locator('#plan-modal-text').fill('Before:\n\nAfter:');

  for (const at of ['Before:'.length, null]) {
    await win.evaluate(({ at }) => {
      const ta = document.getElementById('plan-modal-text');
      ta.focus();
      ta.selectionStart = ta.selectionEnd = at === null ? ta.value.length : at;
      ta.dispatchEvent(new Event('select'));
    }, { at });
    // Setting the same file twice is a no-op, so the input is emptied between
    // picks. add() ignores an empty selection.
    await win.locator('#plan-file-input').setInputFiles([]);
    await win.locator('#plan-file-input').setInputFiles(real);
    await win.waitForTimeout(400);
  }

  const value = await win.locator('#plan-modal-text').inputValue();
  expect(value.split(marker).length - 1).toBe(2);
  // One attachment, referenced at both spots.
  await expect(win.locator('#plan-file-list .plan-file-row')).toHaveCount(1);

  const submitted = await win.evaluate(() =>
    window.ActionModal.attachments().compose(document.getElementById('plan-modal-text').value));
  expect(submitted).not.toContain(marker);
  expect(submitted.split(real).length - 1).toBe(2);
  fs.rmSync(real, { force: true });
});
