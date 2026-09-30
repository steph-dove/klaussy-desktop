const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global.window || {};
require('../../renderer/theme');
const presets = global.window.ThemeManager.presets;

function luminance(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// WCAG 2.2 AA: 4.5:1 for text (1.4.3), 3:1 for form-control edges (1.4.11).
const TEXT_ON_ALL = ['text', 'textMuted', 'textDim'];
const PANELS = ['bg', 'sidebarBg', 'surface', 'surfaceHover'];
const TEXT_ON_BG = ['accent', 'success', 'error'];

for (const [name, t] of Object.entries(presets)) {
  test(`${name}: body, muted and dim text reach 4.5:1 on every panel`, () => {
    for (const fg of TEXT_ON_ALL) {
      for (const bg of PANELS) {
        assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${fg} ${t[fg]} on ${bg} ${t[bg]} is ${ratio(t[fg], t[bg]).toFixed(2)}`);
      }
    }
  });

  test(`${name}: accent, success and error work as text`, () => {
    for (const fg of TEXT_ON_BG) {
      for (const bg of ['bg', 'surface']) {
        assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${fg} ${t[fg]} on ${bg} ${t[bg]} is ${ratio(t[fg], t[bg]).toFixed(2)}`);
      }
    }
  });

  test(`${name}: filled accent/success/error have a readable text colour`, () => {
    for (const fill of TEXT_ON_BG) {
      const best = Math.max(ratio('#ffffff', t[fill]), ratio('#0b0b0f', t[fill]));
      assert.ok(best >= 4.5, `${fill} ${t[fill]} has no readable text colour (${best.toFixed(2)})`);
    }
  });

  test(`${name}: form-field borders reach 3:1`, () => {
    for (const bg of ['bg', 'surface', 'inputBg']) {
      assert.ok(ratio(t.borderStrong, t[bg]) >= 3, `borderStrong ${t.borderStrong} on ${bg} ${t[bg]} is ${ratio(t.borderStrong, t[bg]).toFixed(2)}`);
    }
  });
}
