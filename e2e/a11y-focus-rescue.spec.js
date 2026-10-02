/* global window,document */
const { test, expect } = require('./fixtures');

const activeId = (page) => page.evaluate(() => document.activeElement && document.activeElement.id);

async function mountFixture(page, html, onBody) {
  await page.evaluate(([markup, toBody]) => {
    const old = document.getElementById('focus-fixture');
    if (old) old.remove();
    const host = document.createElement('section');
    host.id = 'focus-fixture';
    host.setAttribute('role', 'region');
    host.setAttribute('aria-label', 'Fixture');
    host.innerHTML = markup;
    (toBody ? document.body : document.getElementById('app')).appendChild(host);
  }, [html, !!onBody]);
}

test.describe('focus rescue', () => {
  test.beforeEach(async ({ mainWindow }) => {
    await mainWindow.waitForLoadState('networkidle');
    await mainWindow.addStyleTag({ content: '#ollama-consent-overlay { display: none !important; }' });
  });

  test('a re-rendered control gets focus back', async ({ mainWindow }) => {
    await mountFixture(mainWindow, '<div id="list"><button data-file="a.js" id="a1">a</button><button data-file="b.js">b</button></div>');
    await mainWindow.locator('[data-file="b.js"]').focus();
    await mainWindow.evaluate(() => {
      document.getElementById('list').innerHTML = '<button data-file="a.js">a</button><button data-file="b.js" id="b2">b</button>';
    });
    await expect.poll(() => activeId(mainWindow)).toBe('b2');
  });

  test('a swapped control hands focus to whatever took its place', async ({ mainWindow }) => {
    await mountFixture(mainWindow, '<div id="row"><button id="before">x</button><button class="run">Run</button><button id="after">y</button></div>');
    await mainWindow.locator('.run').focus();
    await mainWindow.evaluate(() => {
      document.querySelector('.run').outerHTML = '<button class="cancel" id="cancel">Cancel</button>';
    });
    await expect.poll(() => activeId(mainWindow)).toBe('cancel');
  });

  test('a control disabled while busy gets focus back when re-enabled', async ({ mainWindow }) => {
    await mountFixture(mainWindow, '<button id="other">o</button><button id="busy">Test</button>');
    await mainWindow.locator('#busy').focus();
    await mainWindow.evaluate(() => { document.getElementById('busy').disabled = true; });
    await mainWindow.waitForTimeout(300);
    expect(await mainWindow.evaluate(() => document.activeElement === document.body)).toBe(true);
    await mainWindow.evaluate(() => { document.getElementById('busy').disabled = false; });
    await expect.poll(() => activeId(mainWindow)).toBe('busy');
  });

  test('closing an inline panel in a diff returns to its line', async ({ mainWindow }) => {
    await mountFixture(mainWindow, '<pre id="diff"><div class="diff-line" id="l1">one</div><div class="diff-line" id="l2">two</div></pre>');
    await mainWindow.evaluate(() => {
      window.A11y.lineNav(document.getElementById('diff'), { lineSelector: '.diff-line', hunkSelector: '.diff-hunk', label: 'Diff' });
    });
    await mainWindow.locator('#diff').focus();
    await mainWindow.keyboard.press('ArrowDown');
    await mainWindow.keyboard.press('ArrowDown');
    await expect.poll(() => activeId(mainWindow)).toBe('l2');
    await mainWindow.evaluate(() => {
      const panel = document.createElement('div');
      panel.innerHTML = '<button id="close-panel">×</button>';
      document.getElementById('l2').after(panel);
      document.getElementById('close-panel').focus();
      panel.remove();
    });
    await expect.poll(() => activeId(mainWindow)).toBe('l2');
  });

  test('a dialog whose content is swapped keeps a name and focus', async ({ mainWindow }) => {
    await mountFixture(mainWindow, '<div data-a11y-dialog id="swap-dialog"><div class="body"><h2>List</h2><button id="go">Add</button><button>Cancel</button></div></div>', true);
    const dialog = mainWindow.locator('#swap-dialog [role="dialog"], #swap-dialog[role="dialog"]').first();
    await expect(dialog).toHaveAccessibleName('List');
    await mainWindow.locator('#go').focus();
    await mainWindow.evaluate(() => {
      document.querySelector('#swap-dialog .body').innerHTML = '<h2>Add server</h2><label>Name <input id="name"></label><button>Back</button>';
    });
    await expect.poll(() => activeId(mainWindow)).toBe('name');
    await expect(dialog).toHaveAccessibleName('Add server');
    await mainWindow.evaluate(() => document.getElementById('focus-fixture').remove());
  });

  test('picking a dropdown item returns focus to its trigger', async ({ mainWindow }) => {
    await mountFixture(mainWindow, '<button id="trigger">Merge ▾</button><button id="between">x</button><div id="menu" hidden><button class="item" id="squash">Squash</button></div>');
    await mainWindow.evaluate(() => {
      const trigger = document.getElementById('trigger');
      const menu = document.getElementById('menu');
      trigger.addEventListener('click', () => { menu.hidden = !menu.hidden; });
      menu.addEventListener('click', () => { menu.hidden = true; });
      window.A11y.dropdownMenu(trigger, menu, '.item');
      trigger.click();
    });
    await mainWindow.locator('#squash').focus();
    await mainWindow.keyboard.press('Enter');
    await expect.poll(() => activeId(mainWindow)).toBe('trigger');
  });

  test('preserveFocus restores focus before the generic rescue runs', async ({ mainWindow }) => {
    await mountFixture(mainWindow, '<div id="host"><button>a</button><button class="pick">b</button></div>');
    await mainWindow.locator('.pick').focus();
    const sync = await mainWindow.evaluate(() => {
      const host = document.getElementById('host');
      window.A11y.preserveFocus(host, () => { host.innerHTML = '<button>a</button><button class="pick" id="pick2">b</button>'; });
      return document.activeElement && document.activeElement.id;
    });
    expect(sync).toBe('pick2');
  });

  test('input while a control is busy cancels the refocus', async ({ mainWindow }) => {
    await mountFixture(mainWindow, '<button id="other">o</button><button id="busy">Test</button>');
    await mainWindow.locator('#busy').focus();
    await mainWindow.evaluate(() => { document.getElementById('busy').disabled = true; });
    await mainWindow.waitForTimeout(300);
    await mainWindow.evaluate(() => window.dispatchEvent(new window.PointerEvent('pointerdown')));
    await mainWindow.evaluate(() => { document.getElementById('busy').disabled = false; });
    await mainWindow.waitForTimeout(500);
    expect(await activeId(mainWindow)).not.toBe('busy');
  });

  test('checkboxes show a focus ring', async ({ mainWindow }) => {
    await mountFixture(mainWindow, '<button id="start">s</button><input type="checkbox" id="cb" aria-label="Pick">');
    await mainWindow.locator('#start').focus();
    await mainWindow.keyboard.press('Tab');
    await expect.poll(() => activeId(mainWindow)).toBe('cb');
    const outline = await mainWindow.evaluate(() => {
      const cs = window.getComputedStyle(document.getElementById('cb'));
      return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
    });
    expect(outline.style).toBe('solid');
    expect(outline.width).toBeGreaterThanOrEqual(2);
  });
});
