// Theme manager — presets + CSS custom properties
window.ThemeManager = (function () {
  var presets = {
    dark: {
      name: 'Dark',
      bg: '#0f0f1a', sidebarBg: '#16162a', border: '#2a2a4a',
      accent: '#6c5ce7', accentHover: '#7d6ef0',
      text: '#e0e0e0', textMuted: '#888', textDim: '#666',
      surface: '#1e1e36', surfaceHover: '#2a2a4a',
      inputBg: '#0f0f1a', success: '#00e676', error: '#ff5252',
      termBg: '#0f0f1a', termFg: '#e0e0e0', termCursor: '#6c5ce7', termSelection: '#6c5ce744',
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
    light: {
      name: 'Light',
      bg: '#ffffff', sidebarBg: '#f5f5f7', border: '#d1d1d6',
      accent: '#5856d6', accentHover: '#6e6cd8',
      text: '#1c1c1e', textMuted: '#6e6e73', textDim: '#aeaeb2',
      surface: '#f2f2f7', surfaceHover: '#e5e5ea',
      inputBg: '#ffffff', success: '#34c759', error: '#ff3b30',
      termBg: '#ffffff', termFg: '#1c1c1e', termCursor: '#5856d6', termSelection: '#5856d633',
      diffText: '#24292f',
      diffAddBg: 'rgba(35, 134, 54, 0.1)', diffAddFg: '#1a7f37',
      diffDelBg: 'rgba(218, 54, 51, 0.1)', diffDelFg: '#cf222e',
      diffHunkBg: '#ddf4ff', diffHunkFg: '#0969da',
      lightSyntax: true,
    },
  };

  var currentPreset = 'dark';
  var isSystemMode = false;

  function init() {
    window.klaus.getTheme().then(function (theme) {
      if (theme && theme.preset === 'system') {
        applySystem();
      } else if (theme && theme.preset && presets[theme.preset]) {
        apply(theme.preset);
      } else {
        apply('dark');
      }
    });

    // Listen for system theme changes from main process
    if (window.klaus.onSystemThemeChanged) {
      window.klaus.onSystemThemeChanged(function (isDark) {
        if (isSystemMode) {
          applyPresetColors(isDark ? 'dark' : 'light');
        }
      });
    }
  }

  function applySystem() {
    isSystemMode = true;
    currentPreset = 'system';
    window.klaus.setTheme({ preset: 'system' });
    // Ask main process for current system theme
    if (window.klaus.getSystemTheme) {
      window.klaus.getSystemTheme().then(function (isDark) {
        applyPresetColors(isDark ? 'dark' : 'light');
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
    window.klaus.setTheme({ preset: presetName });
  }

  function getTerminalTheme() {
    var resolvedPreset = currentPreset;
    if (currentPreset === 'system') {
      // Use CSS variable values directly since they're already set
      var style = getComputedStyle(document.documentElement);
      return {
        background: style.getPropertyValue('--term-bg').trim(),
        foreground: style.getPropertyValue('--term-fg').trim(),
        cursor: style.getPropertyValue('--term-cursor').trim(),
        selectionBackground: style.getPropertyValue('--term-selection').trim(),
      };
    }
    var theme = presets[resolvedPreset];
    return {
      background: theme.termBg,
      foreground: theme.termFg,
      cursor: theme.termCursor,
      selectionBackground: theme.termSelection,
    };
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
