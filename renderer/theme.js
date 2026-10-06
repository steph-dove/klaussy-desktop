// Theme manager — presets + CSS custom properties
window.ThemeManager = (function () {
  var presets = {
    dark: {
      name: 'Dark',
      // Polished dark — soft, faintly-cool near-black with a clean elevation
      // ladder (bg → sidebar → surface → hover) so panels/cards separate
      // without hard lines. Inputs sit recessed below bg; calm blue accent.
      bg: '#0e0e13', sidebarBg: '#16161d', border: '#272730', borderStrong: '#67677f',
      accent: '#4a9eff', accentHover: '#6cb2ff',
      text: '#e8e8ee', textMuted: '#9a9aa6', textDim: '#8d8d98',
      surface: '#1c1c24', surfaceHover: '#26262f',
      inputBg: '#0a0a0e', success: '#46c463', error: '#f05d54', warning: '#c8951b',
      // termFg softer than the UI text — pure white in a full terminal is
      // fatiguing.
      termBg: '#0d0d12', termFg: '#d2d2da', termCursor: '#4a9eff', termSelection: 'rgba(74, 158, 255, 0.26)',
      // Slightly desaturated ANSI palette so agent output reads as calm and
      // cohesive instead of harsh primary colors.
      termAnsi: {
        black: '#2a2a33', red: '#f0796f', green: '#6ece8a', yellow: '#e3c179',
        blue: '#6cb2ff', magenta: '#c699f0', cyan: '#5fcfd0', white: '#c8c8d2',
        brightBlack: '#52525e', brightRed: '#ff8b80', brightGreen: '#88dc9e', brightYellow: '#f0d089',
        brightBlue: '#88c2ff', brightMagenta: '#d4b0ff', brightCyan: '#7fdede', brightWhite: '#f0f0f5',
      },
    },
    midnight: {
      name: 'Midnight',
      bg: '#0d1117', sidebarBg: '#161b22', border: '#30363d', borderStrong: '#657180',
      accent: '#58a6ff', accentHover: '#79c0ff',
      text: '#c9d1d9', textMuted: '#97a0a8', textDim: '#999fa8',
      surface: '#21262d', surfaceHover: '#30363d',
      inputBg: '#0d1117', success: '#3fb950', error: '#f9766f', warning: '#c9961d',
      termBg: '#0d1117', termFg: '#c9d1d9', termCursor: '#58a6ff', termSelection: '#58a6ff44',
    },
    monokai: {
      name: 'Monokai',
      bg: '#272822', sidebarBg: '#1e1f1c', border: '#3e3d32', borderStrong: '#8c8971',
      accent: '#a6e22e', accentHover: '#b6f23e',
      text: '#f8f8f2', textMuted: '#bbb8aa', textDim: '#b7b7b2',
      surface: '#3e3d32', surfaceHover: '#49483e',
      inputBg: '#272822', success: '#a6e22e', error: '#fc99bd', warning: '#ddb148',
      diffDelFg: '#ffa1a1',
      termBg: '#272822', termFg: '#f8f8f2', termCursor: '#f92672', termSelection: '#a6e22e44',
    },
    nord: {
      name: 'Nord',
      bg: '#2e3440', sidebarBg: '#3b4252', border: '#4c566a', borderStrong: '#909bb0',
      accent: '#aad2de', accentHover: '#8fbcbb',
      text: '#eceff4', textMuted: '#d8dee9', textDim: '#c5cdd8',
      surface: '#434c5e', surfaceHover: '#4c566a',
      inputBg: '#2e3440', success: '#bfd2af', error: '#e6c3c6', warning: '#ecc770',
      diffAddFg: '#86e486', diffDelFg: '#ffbcbc',
      termBg: '#2e3440', termFg: '#eceff4', termCursor: '#88c0d0', termSelection: '#88c0d044',
    },
    solarized: {
      name: 'Solarized',
      bg: '#002b36', sidebarBg: '#073642', border: '#586e75', borderStrong: '#668088',
      accent: '#60ace2', accentHover: '#2aa198',
      text: '#9aa8aa', textMuted: '#96a8ae', textDim: '#96a8ae',
      surface: '#073642', surfaceHover: '#0a4050',
      inputBg: '#002b36', success: '#9cae1f', error: '#eb8a89', warning: '#cd9f30',
      // Solarized body text has the least headroom, so its selection tint stays faint enough to keep 4.5:1.
      accentDimAlpha: 0.09,
      termBg: '#002b36', termFg: '#839496', termCursor: '#268bd2', termSelection: '#268bd244',
    },
    rose: {
      name: 'Rose Pine',
      bg: '#191724', sidebarBg: '#1f1d2e', border: '#26233a', borderStrong: '#7069a4',
      accent: '#c4a7e7', accentHover: '#ebbcba',
      text: '#e0def4', textMuted: '#938fac', textDim: '#928fa6',
      surface: '#26233a', surfaceHover: '#2a2837',
      inputBg: '#191724', success: '#9ccfd8', error: '#eb6f92', warning: '#c8951b',
      termBg: '#191724', termFg: '#e0def4', termCursor: '#c4a7e7', termSelection: '#c4a7e744',
    },
    synthwave: {
      name: 'Synthwave \'84',
      bg: '#2b213a', sidebarBg: '#241b2f', border: '#372948', borderStrong: '#8a6dac',
      accent: '#ff7edb', accentHover: '#f97e72',
      text: '#f0eff5', textMuted: '#b6b1cf', textDim: '#a4a1b7',
      surface: '#372948', surfaceHover: '#423257',
      inputBg: '#1e1628', success: '#36f9f6', error: '#fe7a82', warning: '#cc9c2b',
      termBg: '#261e35', termFg: '#f0eff5', termCursor: '#ff7edb', termSelection: 'rgba(255, 126, 219, 0.25)',
      termAnsi: {
        black: '#1e1628', red: '#fe4450', green: '#72f1b8', yellow: '#fede5d',
        blue: '#36f9f6', magenta: '#ff7edb', cyan: '#01cdfe', white: '#f0eff5',
        brightBlack: '#524366', brightRed: '#ff6b75', brightGreen: '#90f7ca', brightYellow: '#ffe27a',
        brightBlue: '#73fbfd', brightMagenta: '#ff9ee2', brightCyan: '#38dbff', brightWhite: '#ffffff',
      }
    },
    gruvbox: {
      name: 'Gruvbox',
      bg: '#282828', sidebarBg: '#1d2021', border: '#3c3836', borderStrong: '#8b827e',
      accent: '#fea65e', accentHover: '#d65d0e',
      text: '#ebdbb2', textMuted: '#c3b9ab', textDim: '#c1b9b0',
      surface: '#3c3836', surfaceHover: '#504945',
      inputBg: '#282828', success: '#bec13a', error: '#fda398', warning: '#dcb65c',
      diffDelFg: '#ffa1a1',
      termBg: '#282828', termFg: '#ebdbb2', termCursor: '#fe8019', termSelection: 'rgba(254, 128, 25, 0.25)',
      termAnsi: {
        black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921',
        blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
        brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f',
        brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
      }
    },
    catppuccin: {
      name: 'Catppuccin',
      bg: '#1e1e2e', sidebarBg: '#11111b', border: '#313244', borderStrong: '#797b9f',
      accent: '#cca8f7', accentHover: '#f5c2e7',
      text: '#cdd6f4', textMuted: '#b1b7cf', textDim: '#b1b7cf',
      surface: '#313244', surfaceHover: '#45475a',
      inputBg: '#1e1e2e', success: '#a6e3a1', error: '#f59fb7', warning: '#d7b35b',
      diffDelFg: '#ff9c9c',
      termBg: '#1e1e2e', termFg: '#cdd6f4', termCursor: '#f5e0dc', termSelection: 'rgba(203, 166, 247, 0.25)',
      termAnsi: {
        black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
        blue: '#89b4fa', magenta: '#cba6f7', cyan: '#94e2d5', white: '#bac2de',
        brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af',
        brightBlue: '#89b4fa', brightMagenta: '#cba6f7', brightCyan: '#94e2d5', brightWhite: '#a6adc8',
      }
    },
    tokyo: {
      name: 'Tokyo Night',
      bg: '#1a1b26', sidebarBg: '#16161e', border: '#24283b', borderStrong: '#6670a2',
      accent: '#7aa2f7', accentHover: '#89ddff',
      text: '#a9b1d6', textMuted: '#9b9eb3', textDim: '#9b9eb3',
      surface: '#24283b', surfaceHover: '#2f3549',
      inputBg: '#1a1b26', success: '#9ece6a', error: '#f7768e', warning: '#c9961d',
      termBg: '#1a1b26', termFg: '#a9b1d6', termCursor: '#c0caf5', termSelection: 'rgba(122, 162, 247, 0.25)',
      termAnsi: {
        black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
        blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
        brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68',
        brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
      }
    },
    light: {
      name: 'Light',
      bg: '#ffffff', sidebarBg: '#f5f5f7', border: '#d1d1d6', borderStrong: '#8a8a96',
      accent: '#5755d4', accentHover: '#5f5dd4',
      text: '#1c1c1e', textMuted: '#65656a', textDim: '#65656a',
      surface: '#f2f2f7', surfaceHover: '#e5e5ea',
      inputBg: '#ffffff', success: '#1f7534', error: '#ce0b00', warning: '#816112',
      termBg: '#ffffff', termFg: '#1c1c1e', termCursor: '#5856d6', termSelection: '#5856d633',
      // On a light background, the ANSI "white" colors are the trap: programs
      // assume a dark terminal and emit white / bright-white foreground text,
      // which vanishes on white. So white maps to a readable gray and
      // brightWhite to a dark gray (NOT near-white) — the bright/emphasis color
      // on a light theme should be the highest-contrast, i.e. dark.
      termAnsi: {
        black: '#1c1c1e', red: '#c41a16', green: '#007400', yellow: '#b5890a',
        blue: '#0451a5', magenta: '#a626a4', cyan: '#0b7261', white: '#6e6e73',
        brightBlack: '#6e6e73', brightRed: '#cf222e', brightGreen: '#1a7f37', brightYellow: '#a67c00',
        brightBlue: '#0969da', brightMagenta: '#8b57ce', brightCyan: '#0e8585', brightWhite: '#48484a',
      },
      diffText: '#24292f',
      // Add/del foregrounds double as text (sidebar counts, PR chips, errors), so they hold 4.5:1 on their tinted chips too.
      diffAddBg: 'rgba(35, 134, 54, 0.1)', diffAddFg: '#15662c',
      diffDelBg: 'rgba(218, 54, 51, 0.1)', diffDelFg: '#b01d27',
      diffHunkBg: '#ddf4ff', diffHunkFg: '#0969da',
      lightSyntax: true,
    },
  };

  // Text on a filled colour (buttons, badges) uses whichever of white or near-black contrasts more.
  function luminance(hexColor) {
    var h = hexColor.replace('#', '');
    return [0, 2, 4].map(function (i) {
      var v = parseInt(h.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }).reduce(function (sum, v, i) { return sum + v * [0.2126, 0.7152, 0.0722][i]; }, 0);
  }
  function readableOn(fill) {
    var l = luminance(fill);
    return (1.05 / (l + 0.05)) >= ((l + 0.05) / (luminance('#0b0b0f') + 0.05)) ? '#ffffff' : '#0b0b0f';
  }

  var currentPreset = 'dark';
  var resolvedSystemPreset = 'dark';
  var isSystemMode = false;

  function init() {
    window.klaus.ui.getTheme().then(function (theme) {
      if (theme && theme.preset === 'system') {
        applySystem(false);
      } else if (theme && theme.preset && presets[theme.preset]) {
        apply(theme.preset, { persist: false });
      } else {
        apply('dark', { persist: false });
      }
    });

    // Listen for system theme changes from main process
    if (window.klaus.ui.onSystemThemeChanged) {
      window.klaus.ui.onSystemThemeChanged(function (isDark) {
        if (isSystemMode) {
          resolvedSystemPreset = isDark ? 'dark' : 'light';
          applyPresetColors(resolvedSystemPreset);
        }
      });
    }

    // Another window picked a theme; follow it without writing it back.
    if (window.klaus.ui.onThemeChanged) {
      window.klaus.ui.onThemeChanged(function (theme) {
        if (theme && theme.preset) apply(theme.preset, { persist: false });
      });
    }
  }

  function applySystem(persist) {
    isSystemMode = true;
    currentPreset = 'system';
    if (persist !== false) window.klaus.ui.setTheme({ preset: 'system' });
    // Ask main process for current system theme
    if (window.klaus.ui.getSystemTheme) {
      window.klaus.ui.getSystemTheme().then(function (isDark) {
        resolvedSystemPreset = isDark ? 'dark' : 'light';
        applyPresetColors(resolvedSystemPreset);
      });
    }
  }

  function withAlpha(hexColor, alpha) {
    var h = hexColor.replace('#', '');
    return 'rgba(' + [0, 2, 4].map(function (i) { return parseInt(h.slice(i, i + 2), 16); }).join(', ') + ', ' + alpha + ')';
  }

  // The CSS custom properties a preset sets, including the fallbacks for presets that leave a token out.
  function cssVars(presetName) {
    var theme = presets[presetName];
    if (!theme) return null;
    return {
      '--bg': theme.bg,
      '--sidebar-bg': theme.sidebarBg,
      '--border': theme.border,
      '--border-strong': theme.borderStrong,
      '--accent': theme.accent,
      '--accent-hover': theme.accentHover,
      '--accent-dim': withAlpha(theme.accent, theme.accentDimAlpha || 0.16),
      '--text': theme.text,
      '--text-muted': theme.textMuted,
      '--text-dim': theme.textDim,
      '--surface': theme.surface,
      '--surface-hover': theme.surfaceHover,
      '--input-bg': theme.inputBg,
      '--success': theme.success,
      '--error': theme.error,
      '--accent-contrast': readableOn(theme.accent),
      '--success-contrast': readableOn(theme.success),
      '--error-contrast': readableOn(theme.error),
      '--warning': theme.warning,
      '--warning-contrast': readableOn(theme.warning),
      '--term-bg': theme.termBg,
      '--term-fg': theme.termFg,
      '--term-cursor': theme.termCursor,
      '--term-selection': theme.termSelection,
      '--diff-text': theme.diffText || '#9CDCFE',
      '--diff-add-bg': theme.diffAddBg || 'rgba(35, 134, 54, 0.15)',
      '--diff-add-fg': theme.diffAddFg || '#7ce27c',
      '--diff-del-bg': theme.diffDelBg || 'rgba(218, 54, 51, 0.15)',
      '--diff-del-fg': theme.diffDelFg || '#ff8a8a',
      '--diff-hunk-bg': theme.diffHunkBg || '#1a2a3a',
      '--diff-hunk-fg': theme.diffHunkFg || '#7cace2',
    };
  }

  function applyPresetColors(presetName) {
    var theme = presets[presetName];
    if (!theme) return;

    var root = document.documentElement;
    var vars = cssVars(presetName);
    Object.keys(vars).forEach(function (name) { root.style.setProperty(name, vars[name]); });
    // Toggle light syntax highlighting class
    document.body.classList.toggle('light-syntax', !!theme.lightSyntax);

    window.dispatchEvent(new CustomEvent('theme-changed'));
  }

  function apply(presetName, opts) {
    var persist = !(opts && opts.persist === false);
    if (presetName === 'system') {
      applySystem(persist);
      return;
    }
    isSystemMode = false;
    var theme = presets[presetName];
    if (!theme) return;
    currentPreset = presetName;
    applyPresetColors(presetName);
    if (persist) window.klaus.ui.setTheme({ preset: presetName });
  }

  function getTerminalTheme() {
    var resolvedPreset = currentPreset;
    if (currentPreset === 'system') {
      var style = getComputedStyle(document.documentElement);
      var sysResult = {
        background: style.getPropertyValue('--term-bg').trim(),
        foreground: style.getPropertyValue('--term-fg').trim(),
        cursor: style.getPropertyValue('--term-cursor').trim(),
        selectionBackground: style.getPropertyValue('--term-selection').trim(),
      };
      var sysTheme = presets[resolvedSystemPreset];
      if (sysTheme && sysTheme.termAnsi) {
        var a = sysTheme.termAnsi;
        sysResult.black = a.black; sysResult.red = a.red; sysResult.green = a.green; sysResult.yellow = a.yellow;
        sysResult.blue = a.blue; sysResult.magenta = a.magenta; sysResult.cyan = a.cyan; sysResult.white = a.white;
        sysResult.brightBlack = a.brightBlack; sysResult.brightRed = a.brightRed; sysResult.brightGreen = a.brightGreen; sysResult.brightYellow = a.brightYellow;
        sysResult.brightBlue = a.brightBlue; sysResult.brightMagenta = a.brightMagenta; sysResult.brightCyan = a.brightCyan; sysResult.brightWhite = a.brightWhite;
      }
      return sysResult;
    }
    var theme = presets[resolvedPreset];
    var result = {
      background: theme.termBg,
      foreground: theme.termFg,
      cursor: theme.termCursor,
      selectionBackground: theme.termSelection,
    };
    if (theme.termAnsi) {
      result.black = theme.termAnsi.black;
      result.red = theme.termAnsi.red;
      result.green = theme.termAnsi.green;
      result.yellow = theme.termAnsi.yellow;
      result.blue = theme.termAnsi.blue;
      result.magenta = theme.termAnsi.magenta;
      result.cyan = theme.termAnsi.cyan;
      result.white = theme.termAnsi.white;
      result.brightBlack = theme.termAnsi.brightBlack;
      result.brightRed = theme.termAnsi.brightRed;
      result.brightGreen = theme.termAnsi.brightGreen;
      result.brightYellow = theme.termAnsi.brightYellow;
      result.brightBlue = theme.termAnsi.brightBlue;
      result.brightMagenta = theme.termAnsi.brightMagenta;
      result.brightCyan = theme.termAnsi.brightCyan;
      result.brightWhite = theme.termAnsi.brightWhite;
    }
    return result;
  }

  function getPresetList() {
    var list = [{ id: 'system', name: 'Match System' }];
    Object.keys(presets).forEach(function (id) {
      list.push({ id: id, name: presets[id].name });
    });
    return list;
  }

  function getCurrent() {
    return currentPreset;
  }

  return { init: init, apply: apply, getTerminalTheme: getTerminalTheme, getPresetList: getPresetList, getCurrent: getCurrent, presets: presets, cssVars: cssVars };
})();
