// Theme manager — presets + CSS custom properties
window.ThemeManager = (function () {
  var presets = {
    dark: {
      name: 'Dark',
      // Polished dark — soft, faintly-cool near-black with a clean elevation
      // ladder (bg → sidebar → surface → hover) so panels/cards separate
      // without hard lines. Inputs sit recessed below bg; calm blue accent.
      bg: '#0e0e13', sidebarBg: '#16161d', border: '#272730',
      accent: '#4a9eff', accentHover: '#6cb2ff',
      text: '#e8e8ee', textMuted: '#9a9aa6', textDim: '#64646f',
      surface: '#1c1c24', surfaceHover: '#26262f',
      inputBg: '#0a0a0e', success: '#46c463', error: '#f0584f',
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
      bg: '#0d1117', sidebarBg: '#161b22', border: '#30363d',
      accent: '#58a6ff', accentHover: '#79c0ff',
      text: '#c9d1d9', textMuted: '#8b949e', textDim: '#6e7681',
      surface: '#21262d', surfaceHover: '#30363d',
      inputBg: '#0d1117', success: '#3fb950', error: '#f85149',
      termBg: '#0d1117', termFg: '#c9d1d9', termCursor: '#58a6ff', termSelection: '#58a6ff44',
    },
    monokai: {
      name: 'Monokai',
      bg: '#272822', sidebarBg: '#1e1f1c', border: '#3e3d32',
      accent: '#a6e22e', accentHover: '#b6f23e',
      text: '#f8f8f2', textMuted: '#75715e', textDim: '#555550',
      surface: '#3e3d32', surfaceHover: '#49483e',
      inputBg: '#272822', success: '#a6e22e', error: '#f92672',
      termBg: '#272822', termFg: '#f8f8f2', termCursor: '#f92672', termSelection: '#a6e22e44',
    },
    nord: {
      name: 'Nord',
      bg: '#2e3440', sidebarBg: '#3b4252', border: '#4c566a',
      accent: '#88c0d0', accentHover: '#8fbcbb',
      text: '#eceff4', textMuted: '#d8dee9', textDim: '#a5b1c2',
      surface: '#434c5e', surfaceHover: '#4c566a',
      inputBg: '#2e3440', success: '#a3be8c', error: '#bf616a',
      termBg: '#2e3440', termFg: '#eceff4', termCursor: '#88c0d0', termSelection: '#88c0d044',
    },
    solarized: {
      name: 'Solarized',
      bg: '#002b36', sidebarBg: '#073642', border: '#586e75',
      accent: '#268bd2', accentHover: '#2aa198',
      text: '#839496', textMuted: '#657b83', textDim: '#586e75',
      surface: '#073642', surfaceHover: '#0a4050',
      inputBg: '#002b36', success: '#859900', error: '#dc322f',
      termBg: '#002b36', termFg: '#839496', termCursor: '#268bd2', termSelection: '#268bd244',
    },
    rose: {
      name: 'Rose Pine',
      bg: '#191724', sidebarBg: '#1f1d2e', border: '#26233a',
      accent: '#c4a7e7', accentHover: '#ebbcba',
      text: '#e0def4', textMuted: '#908caa', textDim: '#6e6a86',
      surface: '#26233a', surfaceHover: '#2a2837',
      inputBg: '#191724', success: '#9ccfd8', error: '#eb6f92',
      termBg: '#191724', termFg: '#e0def4', termCursor: '#c4a7e7', termSelection: '#c4a7e744',
    },
    synthwave: {
      name: 'Synthwave \'84',
      bg: '#2b213a', sidebarBg: '#241b2f', border: '#372948',
      accent: '#ff7edb', accentHover: '#f97e72',
      text: '#f0eff5', textMuted: '#b6b1cf', textDim: '#706b8c',
      surface: '#372948', surfaceHover: '#423257',
      inputBg: '#1e1628', success: '#36f9f6', error: '#fe4450',
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
      bg: '#282828', sidebarBg: '#1d2021', border: '#3c3836',
      accent: '#fe8019', accentHover: '#d65d0e',
      text: '#ebdbb2', textMuted: '#a89984', textDim: '#928374',
      surface: '#3c3836', surfaceHover: '#504945',
      inputBg: '#282828', success: '#b8bb26', error: '#fb4934',
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
      bg: '#1e1e2e', sidebarBg: '#11111b', border: '#313244',
      accent: '#cba6f7', accentHover: '#f5c2e7',
      text: '#cdd6f4', textMuted: '#a6adc8', textDim: '#6c7086',
      surface: '#313244', surfaceHover: '#45475a',
      inputBg: '#1e1e2e', success: '#a6e3a1', error: '#f38ba8',
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
      bg: '#1a1b26', sidebarBg: '#16161e', border: '#24283b',
      accent: '#7aa2f7', accentHover: '#89ddff',
      text: '#a9b1d6', textMuted: '#787c99', textDim: '#565f89',
      surface: '#24283b', surfaceHover: '#2f3549',
      inputBg: '#1a1b26', success: '#9ece6a', error: '#f7768e',
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
      bg: '#ffffff', sidebarBg: '#f5f5f7', border: '#d1d1d6',
      accent: '#5856d6', accentHover: '#6e6cd8',
      text: '#1c1c1e', textMuted: '#6e6e73', textDim: '#aeaeb2',
      surface: '#f2f2f7', surfaceHover: '#e5e5ea',
      inputBg: '#ffffff', success: '#34c759', error: '#ff3b30',
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
      // Soft, muted add/del foreground — not muddy-dark, not neon — so the
      // file-list stat bars + counts sit calmly on the light background.
      diffAddBg: 'rgba(35, 134, 54, 0.1)', diffAddFg: '#4f9e6b',
      diffDelBg: 'rgba(218, 54, 51, 0.1)', diffDelFg: '#d0665e',
      diffHunkBg: '#ddf4ff', diffHunkFg: '#0969da',
      lightSyntax: true,
    },
  };

  var currentPreset = 'dark';
  var resolvedSystemPreset = 'dark';
  var isSystemMode = false;

  function init() {
    window.klaus.ui.getTheme().then(function (theme) {
      if (theme && theme.preset === 'system') {
        applySystem();
      } else if (theme && theme.preset && presets[theme.preset]) {
        apply(theme.preset);
      } else {
        apply('dark');
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
  }

  function applySystem() {
    isSystemMode = true;
    currentPreset = 'system';
    window.klaus.ui.setTheme({ preset: 'system' });
    // Ask main process for current system theme
    if (window.klaus.ui.getSystemTheme) {
      window.klaus.ui.getSystemTheme().then(function (isDark) {
        resolvedSystemPreset = isDark ? 'dark' : 'light';
        applyPresetColors(resolvedSystemPreset);
      });
    }
  }

  function applyPresetColors(presetName) {
    var theme = presets[presetName];
    if (!theme) return;

    var root = document.documentElement;
    root.style.setProperty('--bg', theme.bg);
    root.style.setProperty('--sidebar-bg', theme.sidebarBg);
    root.style.setProperty('--border', theme.border);
    root.style.setProperty('--accent', theme.accent);
    root.style.setProperty('--accent-hover', theme.accentHover);
    root.style.setProperty('--text', theme.text);
    root.style.setProperty('--text-muted', theme.textMuted);
    root.style.setProperty('--text-dim', theme.textDim);
    root.style.setProperty('--surface', theme.surface);
    root.style.setProperty('--surface-hover', theme.surfaceHover);
    root.style.setProperty('--input-bg', theme.inputBg);
    root.style.setProperty('--success', theme.success);
    root.style.setProperty('--error', theme.error);
    root.style.setProperty('--term-bg', theme.termBg);
    root.style.setProperty('--term-fg', theme.termFg);
    root.style.setProperty('--term-cursor', theme.termCursor);
    root.style.setProperty('--term-selection', theme.termSelection);
    // Diff colors (with fallbacks for presets that don't define them)
    root.style.setProperty('--diff-text', theme.diffText || '#9CDCFE');
    root.style.setProperty('--diff-add-bg', theme.diffAddBg || 'rgba(35, 134, 54, 0.15)');
    root.style.setProperty('--diff-add-fg', theme.diffAddFg || '#7ce27c');
    root.style.setProperty('--diff-del-bg', theme.diffDelBg || 'rgba(218, 54, 51, 0.15)');
    root.style.setProperty('--diff-del-fg', theme.diffDelFg || '#e27c7c');
    root.style.setProperty('--diff-hunk-bg', theme.diffHunkBg || '#1a2a3a');
    root.style.setProperty('--diff-hunk-fg', theme.diffHunkFg || '#7cace2');
    // Toggle light syntax highlighting class
    document.body.classList.toggle('light-syntax', !!theme.lightSyntax);

    window.dispatchEvent(new CustomEvent('theme-changed'));
  }

  function apply(presetName) {
    if (presetName === 'system') {
      applySystem();
      return;
    }
    isSystemMode = false;
    var theme = presets[presetName];
    if (!theme) return;
    currentPreset = presetName;
    applyPresetColors(presetName);
    window.klaus.ui.setTheme({ preset: presetName });
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

  return { init: init, apply: apply, getTerminalTheme: getTerminalTheme, getPresetList: getPresetList, getCurrent: getCurrent };
})();
