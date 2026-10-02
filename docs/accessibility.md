# Accessibility

Klaussy aims to meet WCAG 2.2 AA and to be usable with the keyboard alone and with a screen reader (VoiceOver, NVDA, JAWS).

## Keyboard

| Keys | What they do |
|---|---|
| F6 / Shift+F6 | Move between areas: sidebar, terminals (or PR review), changes panel, editor. This is also how you leave a terminal, which keeps Tab and Escape for the shell. |
| Tab / Shift+Tab | Move between controls. Inside a dialog, focus stays in the dialog. |
| Arrow keys | Move within lists, tab strips, menus, the file tree and radio groups. |
| Enter / Space | Activate the focused control. |
| Escape | Close the open dialog, menu or composer. Focus returns to where it was. Plan approval is the exception: rejecting a plan can't be undone, so it needs the Reject button. |
| Shift+F10 or the Menu key | Open the context menu for the focused item. |
| Cmd+K (Ctrl+Shift+K on Windows/Linux) | Command palette. |
| Cmd+P (Ctrl+Shift+P) | Quick open a file. |
| F1 | Keyboard shortcuts. |

Surface-specific keys:

- **Sidebar**: F2 renames a task; Alt+Up/Down reorders it.
- **Changes list**: Enter shows the diff; Shift+Enter opens the file in the editor.
- **Diffs** (Changes panel and PR review): Tab into the diff, then Up/Down move line by line. Alt+Up/Down jump between hunks. Enter or C on a line opens a comment on it; E explains the hunk the line is in.
- **File tree**: Right/Left expand and collapse, Enter opens, F2 renames, Delete deletes.
- **Editor tabs and terminal sub-tabs**: Delete closes the focused tab.
- **Resize handles**: arrow keys resize, Shift makes larger steps, Home/End go to the minimum or maximum.

## Screen readers

Preferences → Terminal → **Optimize for screen readers** turns on xterm's screen-reader mode and Monaco's accessibility support. It also turns on automatically when the OS reports a screen reader at launch.

## Building UI

The shared helpers live in `renderer/a11y.js` (`window.A11y`); use them instead of hand-rolling:

- **Dialogs**: any overlay matching the selectors at the top of `a11y.js` becomes a modal dialog automatically, with focus moved in and kept there, Escape to close, and focus restored afterwards. Give a new overlay one of those classes, or `data-a11y-dialog`.
- **Clickable elements**: use a `<button>`. If an element can't be a button, `A11y.makeButton(el, label)` adds the role and Enter/Space handling.
- **Lists and tab strips**: `arrowNav`, `tabs`, `radios`, `combobox`, `dropdownMenu`, `popupList` and `splitter` take their state from the `.active`/`.selected` classes the code already toggles.
- **Re-rendering with `innerHTML`**: wrap it in `A11y.preserveFocus(host, fn)` so keyboard focus survives.
- **Focus rescue (safety net)**: if a re-render removes, hides or disables the focused control, `a11y.js` puts focus back instead of leaving it on `<body>`. Inside a diff it returns to the line the user was on. A control disabled while busy gets focus back when it's re-enabled. A re-rendered copy of the control gets focus, and otherwise the control now in the same position, or the dialog's first field. Still move focus on purpose when there's a better destination (e.g. the new field after "Add").
- **Focus ring**: the global `:focus-visible` ring is `!important`, so a component's `outline: none` can't hide it. Don't fight it. Use `outline-offset` if it clips.
- **Asking for input**: Electron has no `window.prompt()`. Use `AppUtils.promptDialog({ title, fields })`, which returns a labelled modal and resolves with the values, or `null` if cancelled.
- **Status messages**: `A11y.announce(msg)`, or `A11y.announce(msg, 'assertive')` for errors. Toasts announce themselves.
- **Colours**: use the theme tokens (`--text`, `--text-muted`, `--text-dim`, `--accent`, `--border-strong`, `--accent-contrast` for text on filled accent). Don't use raw hex values or opacity to dim text. Put `--success`/`--error`/`--warning`/`--accent` text on a tinted outline rather than a fill of the same hue, which drops it below 4.5:1, and give status dots a shape per state (disc, ring, square) so colour isn't the only cue. `test/util/theme-contrast.test.js` checks every preset, the syntax palettes, and fails on raw `color:` values in `renderer/styles/`.

## Testing

- **Automated**: `e2e/a11y-*.spec.js`. `a11y-axe.spec.js` runs axe-core (WCAG 2.2 A/AA) over the main window, dialogs, Preferences and PR review, plus a colour-contrast pass across all themes.
- **Manual VoiceOver pass** (Cmd+F5), before a release that changes UI:
  1. Launch the app and turn on *Optimize for screen readers*.
  2. Using only the keyboard, open a folder, switch between two tasks from the sidebar, and rename one with F2.
  3. Press F6 to reach each area and check that VoiceOver announces the area's name.
  4. Type in a terminal. Leave it with F6, then come back with Shift+F6.
  5. Open the Changes panel, pick a file, walk the diff with the arrows, and add a line comment with Enter.
  6. Open the file tree, expand a folder, and open a file. Check that the editor announces the file name.
  7. Open the command palette and New Session dialog. Check that the highlighted item is read, Escape closes, and focus returns.
  8. Open a PR review. Switch tabs, open a file, draft a line comment, and open the Merge menu.
  9. Trigger an error toast and a commit, and check that both are announced.
  10. Repeat steps 2–4 with *Increase contrast* and *Reduce motion* turned on in macOS settings.
