const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global.window || {};
require('../../renderer/theme');
const presets = global.window.ThemeManager.presets;
const cssVars = global.window.ThemeManager.cssVars;

function parseColour(c) {
  if (c.startsWith('#')) {
    const h = c.slice(1);
    return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)), a: 1 };
  }
  const parts = c.match(/rgba?\(([^)]+)\)/)[1].split(',').map(Number);
  return { rgb: parts.slice(0, 3), a: parts.length > 3 ? parts[3] : 1 };
}

// Flattens a translucent colour onto an opaque one, as the browser paints it.
function over(top, under) {
  const t = parseColour(top);
  const u = parseColour(under);
  return '#' + t.rgb.map((v, i) => Math.round(v * t.a + u.rgb[i] * (1 - t.a)).toString(16).padStart(2, '0')).join('');
}

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

// Mirrors readableOn() in renderer/theme.js, which picks --accent-contrast.
function readableOn(fill) {
  return ratio('#ffffff', fill) >= ratio('#0b0b0f', fill) ? '#ffffff' : '#0b0b0f';
}

// WCAG 2.2 AA: 4.5:1 for text (1.4.3), 3:1 for form-control edges (1.4.11).
const TEXT_ON_ALL = ['text', 'textMuted', 'textDim'];
const PANELS = ['bg', 'sidebarBg', 'surface', 'surfaceHover'];
const TEXT_ON_BG = ['accent', 'success', 'error', 'warning'];

for (const [name, t] of Object.entries(presets)) {
  test(`${name}: body, muted and dim text reach 4.5:1 on every panel`, () => {
    for (const fg of TEXT_ON_ALL) {
      for (const bg of PANELS) {
        assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${fg} ${t[fg]} on ${bg} ${t[bg]} is ${ratio(t[fg], t[bg]).toFixed(2)}`);
      }
    }
  });

  // surfaceHover is included because status letters and counts sit on hovered rows.
  test(`${name}: accent, success, error, warning and diff colours work as text on every panel`, () => {
    const v = cssVars(name);
    const colours = { ...Object.fromEntries(TEXT_ON_BG.map((k) => [k, t[k]])), diffAddFg: v['--diff-add-fg'], diffDelFg: v['--diff-del-fg'] };
    for (const [fg, c] of Object.entries(colours)) {
      for (const bg of PANELS) {
        assert.ok(ratio(c, t[bg]) >= 4.5, `${fg} ${c} on ${bg} ${t[bg]} is ${ratio(c, t[bg]).toFixed(2)}`);
      }
    }
  });

  test(`${name}: filled accent/success/error/warning have a readable text colour`, () => {
    for (const fill of TEXT_ON_BG) {
      const best = Math.max(ratio('#ffffff', t[fill]), ratio('#0b0b0f', t[fill]));
      assert.ok(best >= 4.5, `${fill} ${t[fill]} has no readable text colour (${best.toFixed(2)})`);
    }
  });

  test(`${name}: accent-contrast text stays readable on accentHover`, () => {
    const fg = readableOn(t.accent);
    assert.ok(ratio(fg, t.accentHover) >= 4.5, `${fg} on accentHover ${t.accentHover} is ${ratio(fg, t.accentHover).toFixed(2)}`);
  });

  test(`${name}: form-field borders reach 3:1`, () => {
    for (const bg of ['bg', 'surface', 'inputBg']) {
      assert.ok(ratio(t.borderStrong, t[bg]) >= 3, `borderStrong ${t.borderStrong} on ${bg} ${t[bg]} is ${ratio(t.borderStrong, t[bg]).toFixed(2)}`);
    }
  });
}

// Tinted chip fills used behind --diff-add-fg / --diff-del-fg text (PR state chips, deps icons, banners).
const ADD_TINTS = ['rgba(35, 134, 54, 0.25)', 'rgba(46, 160, 67, 0.2)'];
const DEL_TINTS = ['rgba(218, 54, 51, 0.2)'];
const DIFF_PANELS = ['bg', 'sidebarBg', 'surface'];

for (const name of Object.keys(presets)) {
  const t = presets[name];
  const v = cssVars(name);

  test(`${name}: diff add/del foregrounds read as text on panels and their tints`, () => {
    for (const [fg, tints] of [['--diff-add-fg', [v['--diff-add-bg'], ...ADD_TINTS]], ['--diff-del-fg', [v['--diff-del-bg'], ...DEL_TINTS]]]) {
      for (const panel of DIFF_PANELS) {
        for (const bg of [t[panel], ...tints.map((tint) => over(tint, t[panel]))]) {
          const r = ratio(v[fg], bg);
          assert.ok(r >= 4.5, `${fg} ${v[fg]} on ${bg} (${panel}) is ${r.toFixed(2)}`);
        }
      }
    }
  });

  test(`${name}: diff gutter numbers stay readable on add/del lines`, () => {
    for (const tint of [v['--diff-add-bg'], v['--diff-del-bg']]) {
      const bg = over(tint, t.bg);
      assert.ok(ratio(t.textMuted, bg) >= 4.5, `textMuted on ${bg} is ${ratio(t.textMuted, bg).toFixed(2)}`);
    }
  });

  test(`${name}: status dots reach 3:1 on every panel`, () => {
    for (const fg of ['success', 'error', 'warning', 'accent', 'textMuted', 'textDim']) {
      for (const bg of PANELS) {
        assert.ok(ratio(t[fg], t[bg]) >= 3, `${fg} ${t[fg]} on ${bg} ${t[bg]} is ${ratio(t[fg], t[bg]).toFixed(2)}`);
      }
    }
  });

  test(`${name}: --accent-dim is a faint tint of the accent that keeps body text readable`, () => {
    const dim = parseColour(v['--accent-dim']);
    assert.deepEqual(dim.rgb, parseColour(t.accent).rgb);
    assert.ok(dim.a > 0 && dim.a <= 0.2, `alpha ${dim.a}`);
    for (const panel of DIFF_PANELS) {
      const bg = over(v['--accent-dim'], t[panel]);
      assert.ok(ratio(t.text, bg) >= 4.5, `text on accent-dim over ${panel} is ${ratio(t.text, bg).toFixed(2)}`);
    }
  });
}

const STYLES = path.join(__dirname, '..', '..', 'renderer', 'styles');

// [{ selector, prop, value }] for every declaration in a stylesheet; nested at-rules flatten to their inner rules.
function declarations(file) {
  const css = fs.readFileSync(path.join(STYLES, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      out.push({ selector, prop: decl.slice(0, i).trim(), value: decl.slice(i + 1).replace('!important', '').trim() });
    }
  }
  return out;
}

// Covers both the #diff-view/#file-viewer-view palette and the markdown code-block override of stock vs2015.min.css.
function syntaxPalette(light, scope) {
  return declarations('02-toolbar-diff.css')
    .filter((d) => d.prop === 'color' && d.selector.includes('.hljs-') && d.selector.includes('.light-syntax') === light && d.value.startsWith('#'))
    .filter((d) => !scope || d.selector.includes(scope))
    .map((d) => d.value);
}

test('syntax palettes are found in 02-toolbar-diff.css', () => {
  for (const light of [false, true]) {
    assert.ok(syntaxPalette(light, '#diff-view').length >= 20);
    assert.ok(syntaxPalette(light, '.file-md-preview').length >= 10);
  }
});

for (const name of Object.keys(presets)) {
  const t = presets[name];
  const v = cssVars(name);
  test(`${name}: every syntax colour reaches 4.5:1 on code backgrounds and add/del lines`, () => {
    const bgs = [t.bg, t.surface, t.inputBg, over(v['--diff-add-bg'], t.bg), over(v['--diff-del-bg'], t.bg)];
    for (const fg of new Set(syntaxPalette(!!t.lightSyntax))) {
      for (const bg of bgs) {
        assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg} is ${ratio(fg, bg).toFixed(2)}`);
      }
    }
  });
}

for (const name of Object.keys(presets)) {
  const t = presets[name];
  const v = cssVars(name);

  test(`${name}: selected diff text keeps 4.5:1 on the opaque --diff-selection`, () => {
    const sel = v['--diff-selection'];
    assert.match(sel, /^#[0-9a-f]{6}$/i, 'must be opaque so line tints underneath cannot shift it');
    // Hunk headers, file headers (.diff-header, --accent) and meta lines (.diff-meta, --text-dim) are selectable too.
    const fgs = [t.text, v['--diff-text'], v['--diff-add-fg'], v['--diff-del-fg'], v['--diff-hunk-fg'], t.accent, t.textDim, ...syntaxPalette(!!t.lightSyntax, '#diff-view')];
    for (const fg of new Set(fgs)) {
      assert.ok(ratio(fg, sel) >= 4.5, `${fg} on ${sel} is ${ratio(fg, sel).toFixed(2)}`);
    }
  });

  // Hunk header rows carry the hunk label, gutter numbers and the Explain/Stage buttons (muted, accent while busy).
  test(`${name}: text on --diff-hunk-bg reaches 4.5:1`, () => {
    const bg = v['--diff-hunk-bg'];
    for (const fg of [t.text, t.textMuted, t.accent, v['--diff-hunk-fg']]) {
      assert.ok(ratio(fg, bg) >= 4.5, `${fg} on hunk ${bg} is ${ratio(fg, bg).toFixed(2)}`);
    }
  });
}

// Text colours must come from theme tokens. These are the deliberate exceptions: white on a fixed-colour fill and light text on a theme-independent dark glass.
const RAW_TEXT_COLOUR_ALLOWED = {
  '02-toolbar-diff.css': ['#comment-selection-btn'],
  '01-base.css': ['#sidebar.collapsed .task-item .collapsed-icon','.terminal-warning', '.terminal-warning-link', '#broadcast-input', '#broadcast-input::placeholder', '#btn-broadcast-close', '#btn-broadcast-close:hover', '#broadcast-toggle'],
  '05-pr-review-surface.css': ['.pr-conv-avatar', '.pr-ai-verdict-badge'],
};

test('stylesheets set text colours through theme tokens, not raw hex/rgb', () => {
  const offenders = [];
  for (const file of fs.readdirSync(STYLES).filter((f) => f.endsWith('.css'))) {
    const allowed = RAW_TEXT_COLOUR_ALLOWED[file] || [];
    for (const d of declarations(file)) {
      if (d.prop !== 'color' || !/^(#|rgb|hsl)/.test(d.value)) continue;
      if (d.selector.includes('.hljs')) continue;
      if (allowed.includes(d.selector)) continue;
      offenders.push(`${file}: ${d.selector} { color: ${d.value} }`);
    }
  }
  assert.deepEqual(offenders, []);
});

// Aliases from the :root block in 01-base.css that older rules still use.
const ALIASES = { '--danger': '--error', '--muted': '--text-muted', '--text-main': '--text', '--bg-card': '--surface', '--bg-hover': '--surface-hover', '--hover-bg': '--surface-hover', '--surface-active': '--surface-hover', '--bg-input': '--input-bg', '--bg-elev': '--surface', '--panel-bg': '--surface', '--surface-alt': '--surface', '--surface-secondary': '--surface', '--bg-deep': '--bg', '--accent-glow': '--accent-dim' };

// Resolves a colour value against a preset to { rgb, a }, or null when it can't be resolved statically.
function resolveColour(value, vars) {
  const v = value.trim();
  let m;
  if (v === 'transparent') return { rgb: [0, 0, 0], a: 0 };
  if ((m = v.match(/^var\((--[\w-]+)\s*(?:,.*)?\)$/))) {
    const name = ALIASES[m[1]] || m[1];
    return vars[name] ? resolveColour(vars[name], vars) : null;
  }
  if (/^#[0-9a-f]{6}$/i.test(v) || /^rgba?\(/.test(v)) return parseColour(v);
  if ((m = v.match(/^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*(.+)\)$/))) {
    const a = resolveColour(m[1], vars);
    const b = resolveColour(m[3], vars);
    const p = Number(m[2]) / 100;
    if (!a || !b) return null;
    if (b.a === 0) return { rgb: a.rgb, a: a.a * p };
    if (a.a < 1 || b.a < 1) return null;
    return { rgb: a.rgb.map((x, i) => x * p + b.rgb[i] * (1 - p)), a: 1 };
  }
  return null;
}

function toHex(rgb) {
  return '#' + rgb.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
}

function flatten(c, underHex) {
  const u = parseColour(underHex).rgb;
  return toHex(c.rgb.map((x, i) => x * c.a + u[i] * (1 - c.a)));
}

// A same-hue tint can pull a status token under 4.5:1 even when it passes on the bare panel.
test('text on translucent tinted fills keeps 4.5:1 over every panel in every preset', () => {
  const offenders = [];
  for (const file of fs.readdirSync(STYLES).filter((f) => f.endsWith('.css'))) {
    const rules = new Map();
    for (const d of declarations(file)) {
      if (!rules.has(d.selector)) rules.set(d.selector, []);
      rules.get(d.selector).push(d);
    }
    for (const [selector, decls] of rules) {
      const colour = decls.filter((d) => d.prop === 'color').pop();
      const fill = decls.filter((d) => d.prop === 'background' || d.prop === 'background-color').pop();
      if (!colour || !fill) continue;
      for (const name of Object.keys(presets)) {
        const vars = cssVars(name);
        const bg = resolveColour(fill.value, vars);
        const fg = resolveColour(colour.value, vars);
        if (!bg || !fg || bg.a === 0 || bg.a === 1) continue;
        for (const panel of DIFF_PANELS) {
          const under = flatten(bg, presets[name][panel]);
          const r = ratio(flatten(fg, under), under);
          if (r < 4.5) offenders.push(`${file} ${selector} in ${name} over ${panel}: ${r.toFixed(2)}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, []);
});

// Rules whose elements hold no text: dividers, icon glyphs, chart bars, drag ghosts and resize handles.
const OPACITY_NON_TEXT_ALLOWED = {
  '01-base.css': ['.sidebar-section-header::after'],
  '02-toolbar-diff.css': ['.actions-dropdown-btn .actions-chevron', '.terminal-container.dragging', '#diff-resize-handle:hover, #diff-resize-handle.active'],
  '04-editor.css': ['.inline-edit-prompt::before'],
  '05-pr-review-surface.css': ['.task-item.dragging', '.plan-phase-icon-todo::before'],
  '06-searchable-select.css': ['.ss-trigger .ss-caret'],
};
// Keyframes on purely decorative layers (the dashboard's empty-state glow).
const OPACITY_NON_TEXT_KEYFRAMES = ['pulseGlow'];

// Opacity multiplies down whatever text the element contains, so any rule may hold text unless allowlisted above; hidden (0) and disabled are exempt.
test('stylesheets do not dim text with opacity', () => {
  const offenders = [];
  const isStop = (s) => /^(\d+(\.\d+)?%|from|to)(\s*,\s*(\d+(\.\d+)?%|from|to))*$/.test(s);
  const dims = (v) => { const o = Number(v); return o > 0 && o < 1; };
  for (const file of fs.readdirSync(STYLES).filter((f) => f.endsWith('.css'))) {
    const allowed = OPACITY_NON_TEXT_ALLOWED[file] || [];
    const rules = new Map();
    for (const d of declarations(file)) {
      if (!rules.has(d.selector)) rules.set(d.selector, []);
      rules.get(d.selector).push(d);
    }
    for (const [selector, decls] of rules) {
      const opacity = decls.filter((d) => d.prop === 'opacity').pop();
      if (!opacity || !dims(opacity.value) || isStop(selector)) continue;
      if (/disabled/.test(selector) || allowed.includes(selector)) continue;
      offenders.push(`${file}: ${selector} { opacity: ${opacity.value} }`);
    }
    const css = fs.readFileSync(path.join(STYLES, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)) {
      if (OPACITY_NON_TEXT_KEYFRAMES.includes(m[1])) continue;
      for (const o of m[2].matchAll(/opacity\s*:\s*([\d.]+)/g)) {
        if (dims(o[1])) offenders.push(`${file}: @keyframes ${m[1]} { opacity: ${o[1]} }`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

// Muted, dim and status tokens have no headroom over the --accent-dim selection fill, so text inside a selected row must be checked against it.
test('text inside --accent-dim selections keeps 4.5:1 in every preset', () => {
  const offenders = [];
  for (const file of fs.readdirSync(STYLES).filter((f) => f.endsWith('.css'))) {
    const decls = declarations(file);
    const hosts = decls.filter((d) => /^background(-color)?$/.test(d.prop) && d.value.includes('var(--accent-dim)'))
      .flatMap((d) => d.selector.split(',').map((s) => s.trim()));
    for (const d of decls.filter((x) => x.prop === 'color')) {
      for (const part of d.selector.split(',').map((s) => s.trim())) {
        if (!hosts.some((h) => part.startsWith(h + ' '))) continue;
        for (const name of Object.keys(presets)) {
          const vars = cssVars(name);
          const fg = resolveColour(d.value, vars);
          assert.ok(fg, `${file}: can't resolve ${d.value} in ${part}`);
          for (const panel of DIFF_PANELS) {
            const under = flatten(resolveColour('var(--accent-dim)', vars), presets[name][panel]);
            const r = ratio(flatten(fg, under), under);
            if (r < 4.5) offenders.push(`${file} ${part} in ${name} over ${panel}: ${r.toFixed(2)}`);
          }
        }
      }
    }
  }
  assert.deepEqual(offenders, []);
});
