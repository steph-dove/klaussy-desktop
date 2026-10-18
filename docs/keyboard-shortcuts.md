# Keyboard shortcuts

Every keyboard shortcut Klaussy handles, grouped by where it works. Press **F1** in the app for a shorter list.

**Windows and Linux use Ctrl+Shift for app shortcuts.** On macOS they're Cmd+key. On Windows and Linux, plain Ctrl+letter belongs to the shell running in the terminal (Ctrl+C, Ctrl+R, Ctrl+L and so on), so Klaussy's own shortcuts add Shift: Cmd+K on a Mac is Ctrl+Shift+K elsewhere. Menu items, the code editor and the "send" key in text boxes use plain Ctrl.

The tables use the Mac's names for keys: Option is Alt on a PC keyboard, and Delete in the Mac column is the forward-delete key (Fn+Delete on a laptop).

## Anywhere in the app window

These work in the main window, whatever has focus, terminals included, except where a row says otherwise.

| macOS | Windows / Linux | What it does | Where it works |
|---|---|---|---|
| Cmd+K | Ctrl+Shift+K | Open the command palette | Anywhere outside the code editor. In the editor, Cmd+K (Ctrl+K on Windows/Linux) starts an inline edit instead (see [Code editor](#code-editor)). |
| Cmd+P | Ctrl+Shift+P | Quick open a file | Anywhere |
| Cmd+/ | Ctrl+Shift+/ | Pick a slash command and send it to the active terminal | Anywhere, except the code editor on macOS, where Cmd+/ toggles a comment |
| Cmd+G | Ctrl+Shift+G | Show or hide the Changes panel for the current task | Anywhere, except the code editor on macOS, where Cmd+G is Find Next |
| Cmd+Shift+T | Ctrl+Shift+T | Reopen the last closed tab | Anywhere |
| Cmd+Shift+A | Ctrl+Shift+A | Show or hide the active agents panel | Anywhere. On Windows/Linux, not while a terminal has focus (the shell gets Ctrl+A). |
| Cmd+Shift+E | Ctrl+Shift+E | Send the selected text to the active task's terminal and ask the agent to review it. With nothing selected, sends every hunk of the file selected in the Changes panel. | Needs a file selected in the Changes panel. On Windows/Linux, not while a terminal has focus (the shell gets Ctrl+E). |
| Hold Cmd+Shift+Space | Hold Ctrl+Shift+Space | Dictate into the active agent; let go to stop | Voice input on (Preferences). Takes the key from the editor's AI completion while voice is on. Also works in the PR review window, but not in extra windows opened with New Window. |
| Hold Cmd+Shift+; | Hold Ctrl+Shift+; | Speak a command, such as "open pr review"; let go to stop | Voice input on (Preferences). Also works in the PR review window, but not in extra windows opened with New Window. |
| F6 / Shift+F6 | F6 / Shift+F6 | Move focus to the next / previous area: sidebar, terminals, Changes panel, agents panel, notifications, editor. This is also how you leave a terminal. | Anywhere except inside a dialog. Also works in the PR review window, where the areas are the review's own sections. |
| Shift+F10 | Shift+F10 or the Menu key | Open the context menu for the focused item | Anywhere |

## App menu

The first three are Klaussy's own. The rest are Electron's standard menu items and use Electron's default keys for them. They work in every Klaussy window.

| macOS | Windows / Linux | What it does | Where it works |
|---|---|---|---|
| Cmd+, | Ctrl+, | Preferences | Any window |
| F1 | F1 | Keyboard shortcuts list (View menu) | Any window except the code editor, where F1 opens the editor's own command list. The list opens in the focused app window, or the main window if a PR review, Preferences or pop-out window has focus. |
| Cmd+N | Ctrl+N | New window | Any window |
| Cmd+H | None | Hide Klaussy | macOS only |
| Cmd+Option+H | None | Hide other apps | macOS only |
| Cmd+Q | Ctrl+Q on Linux; none on Windows | Quit | Any window |
| Cmd+Z | Ctrl+Z | Undo | Text fields |
| Cmd+Shift+Z | Ctrl+Y on Windows, Ctrl+Shift+Z on Linux | Redo | Text fields |
| Cmd+X | Ctrl+X | Cut | Text fields |
| Cmd+C | Ctrl+C | Copy | Text fields |
| Cmd+V | Ctrl+V | Paste | Text fields |
| Cmd+Option+Shift+V | Ctrl+Shift+V | Paste and match style | Text fields |
| Cmd+A | Ctrl+A | Select all | Text fields |
| Cmd+R | Ctrl+R | Reload the window | Any window |
| Cmd+Option+I | Ctrl+Shift+I | Toggle developer tools | Any window |
| Cmd+0 | Ctrl+0 | Actual size | Any window. On macOS, Cmd+0 in a terminal resets the terminal's font size instead; on Windows/Linux that's Ctrl+Shift+0 (see [Terminals](#terminals)). |
| Cmd+Plus | Ctrl+Plus | Zoom in | Any window. In a terminal, Cmd+= changes the terminal's font size instead. |
| Cmd+- | Ctrl+- | Zoom out | Any window. In a terminal, Cmd+- changes the terminal's font size instead. |
| Ctrl+Cmd+F | F11 | Toggle full screen | Any window |
| Cmd+M | Ctrl+M | Minimize | Any window |
| Cmd+W | Ctrl+W | Close the window | Any window. In the code editor it closes the editor tab instead. |

## Terminals

A task's main terminal gets all of these. Sub-tab terminals and pop-out terminal windows get only some, as marked.

| macOS | Windows / Linux | What it does | Where it works |
|---|---|---|---|
| Cmd+C | Ctrl+Shift+C | Copy the selected text | All terminals, when text is selected |
| Cmd+V | Ctrl+Shift+V | Paste | All terminals |
| Shift+Enter | Shift+Enter | New line without sending. In the main terminal this sends the agent's line-continuation (`\` then Enter); sub-tabs and pop-outs get a plain newline. | All terminals |
| Cmd+Shift+K | Ctrl+L (the shell's own) | Clear the terminal | All terminals |
| Cmd+F | Ctrl+Shift+F | Search in the terminal | Main terminal only |
| Cmd+= or Cmd++ | Ctrl+Shift+= | Bigger terminal text | Main terminal only |
| Cmd+- | Ctrl+Shift+- | Smaller terminal text | Main terminal only |
| Cmd+0 | Ctrl+Shift+0 | Reset terminal text size | Main terminal only |

**Terminal search bar** (opened with Cmd+F / Ctrl+Shift+F):

| macOS | Windows / Linux | What it does |
|---|---|---|
| Enter | Enter | Next match |
| Shift+Enter | Shift+Enter | Previous match |
| Esc | Esc | Close the search bar |

**Panes and sub-tabs:**

| macOS | Windows / Linux | What it does | Where it works |
|---|---|---|---|
| Option+Arrow keys | Alt+Arrow keys | Move the pane left/up or right/down | Focus on a pane's name, in the columns or grid layout |
| Left / Right, Home / End | Left / Right, Home / End | Move between sub-tabs | Sub-tab strip |
| Delete | Delete | Close the focused sub-tab | Sub-tab strip |

## Code editor

The editor is Monaco, so its usual editing keys work as well. These are the ones Klaussy adds.

| macOS | Windows / Linux | What it does | Where it works |
|---|---|---|---|
| Cmd+S | Ctrl+S | Save the file | Editor |
| Cmd+W | Ctrl+W | Close the editor tab | Editor |
| Cmd+1 … Cmd+9 | Ctrl+1 … Ctrl+9 | Go to editor tab 1 to 9 | Editor |
| Cmd+Option+Left | Ctrl+Alt+Left | Go back to the previous location | Editor |
| Cmd+Option+Right | Ctrl+Alt+Right | Go forward | Editor |
| Cmd+K | Ctrl+K | Inline AI edit: describe a change and the agent proposes it in place | Editor |
| Cmd+Shift+Space | Ctrl+Shift+Space | Ask for an AI completion at the cursor. Tab accepts it, Esc dismisses it. | Editor, when voice input is off |
| Left / Right, Home / End | Left / Right, Home / End | Move between editor tabs | Editor tab strip |
| Delete | Delete | Close the focused editor tab | Editor tab strip |
| + / = and - | + / = and - | Zoom an image in and out | Focused image preview |

**Inline edit:**

| macOS | Windows / Linux | What it does |
|---|---|---|
| Enter | Enter | Send the prompt; once the proposal is ready, accept it |
| Esc | Esc | Cancel the prompt, or reject the proposal |

## Sidebar

| macOS | Windows / Linux | What it does | Where it works |
|---|---|---|---|
| Up / Down, Home / End | Up / Down, Home / End | Move between tasks | Task list |
| F2 | F2 | Rename the task | Focused task |
| Enter / Esc | Enter / Esc | Save / cancel the new name | Task rename box |
| Option+Up / Option+Down | Alt+Up / Alt+Down | Move the task up or down the list | Focused task |
| Cmd+Enter, Esc or Tab | Ctrl+Enter, Esc or Tab | Leave the task's note and go back to its Notes button | Task note editor |
| Enter / Esc | Enter / Esc | Send / collapse the broadcast command | Broadcast box |

## Changes panel and diffs

| macOS | Windows / Linux | What it does | Where it works |
|---|---|---|---|
| Up / Down, Home / End | Up / Down, Home / End | Move between changed files | Changes list |
| Enter | Enter | Show the file's diff | Changes list |
| Shift+Enter | Shift+Enter | Open the file in the editor | Changes list |
| Up / Down | Up / Down | Move line by line | Diff view |
| Option+Up / Option+Down | Alt+Up / Alt+Down | Jump to the previous / next hunk | Diff view |
| Shift+Up / Shift+Down | Shift+Up / Shift+Down | Select a range of lines | Diff view |
| Enter or C | Enter or C | Comment on the line (or the selected lines, in PR review) | Diff line, in the Changes panel and PR review |
| E | E | Explain the selected lines, or the hunk the line is in | Diff line, in the Changes panel and PR review |
| P | P | Start a PR review comment on the selected lines (or the current line) | Diff line in the Changes panel, when the worktree has a PR |
| Cmd+Enter / Esc | Ctrl+Enter / Esc | Save / cancel the comment | Comment box |
| Cmd+Enter | Ctrl+Enter | Commit | Commit message box |
| Esc | Esc | Close the commit box | Commit message box |
| Up / Down, Home / End | Up / Down, Home / End | Move through the history | History tab |
| Esc | Esc | Close the new-tag form | History tab |

## File tree and project search

| macOS | Windows / Linux | What it does | Where it works |
|---|---|---|---|
| Up / Down, Home / End | Up / Down, Home / End | Move through the tree | File tree |
| Right | Right | Expand a folder, or move into it | File tree |
| Left | Left | Collapse a folder, or go to the parent folder | File tree |
| Enter or Space | Enter or Space | Open the file, or expand/collapse the folder | File tree |
| F2 | F2 | Rename | File tree |
| Delete | Delete | Delete (asks first) | File tree |
| Enter / Esc | Enter / Esc | Confirm / cancel a rename or new file or folder name | File tree name box |
| Down | Down | Jump from the filter box into the tree | File tree filter |
| Enter | Enter | Search now | Project search box |
| Down | Down | Jump to the first result | Project search box |
| Up / Down, Home / End | Up / Down, Home / End | Move between results | Project search results |
| Enter | Enter | Replace in all files | Replace box |

## PR review

Diff keys (line moves, comments, E to explain) are in [Changes panel and diffs](#changes-panel-and-diffs).

| macOS | Windows / Linux | What it does | Where it works |
|---|---|---|---|
| Cmd+Enter | Ctrl+Enter | Post the comment | New conversation comment |
| Cmd+Enter / Esc | Ctrl+Enter / Esc | Send / close the reply | Reply box |
| Cmd+Enter / Esc | Ctrl+Enter / Esc | Save / close the line comment | Line comment box |
| Cmd+Enter | Ctrl+Enter | Send | AI review finding chat, CI debug chat |
| Up / Down, Home / End | Up / Down, Home / End | Move between files | PR file list |
| Enter | Enter | Load the PR from the URL | PR picker URL box |
| Down | Down | Jump from the search box to the PR list | PR picker |
| Up / Down, Home / End | Up / Down, Home / End | Move through the PR list | PR picker |

## Pickers, menus and dialogs

| macOS | Windows / Linux | What it does | Where it works |
|---|---|---|---|
| Up / Down | Up / Down | Move the highlight | Command palette, quick open, slash command picker, searchable dropdowns |
| Enter | Enter | Run the command / open the file / pick the option | Command palette, quick open, searchable dropdowns |
| Enter | Enter | Run the slash command in the active terminal | Slash command picker |
| Cmd+Enter | Ctrl+Enter | Insert the slash command without running it | Slash command picker |
| Esc | Esc | Close | Command palette, quick open, slash command picker, searchable dropdowns |
| Up / Down, Home / End | Up / Down, Home / End | Move through the items | Context menus and dropdown menus |
| A letter | A letter | Jump to the next item starting with it | Context menus |
| Esc or Tab | Esc or Tab | Close the menu | Context menus and dropdown menus |
| Up / Down, Home / End, Esc | Up / Down, Home / End, Esc | Move through / close the list | Recent folders list in the folder picker and new session dialog |
| Left / Right, Home / End | Left / Right, Home / End | Move between tabs; Enter or Space opens the focused one | Tab strips: side panel, PR review sections, dev loop views, new session type, history views, plan source |
| Up / Down, Home / End | Up / Down, Home / End | Move through the list | Skills & Commands and Plugins lists |
| Esc | Esc | Close the dialog; focus goes back where it was | Dialogs, except plan approval, which needs its Reject button |
| Tab / Shift+Tab | Tab / Shift+Tab | Move through the dialog's controls; focus stays inside it | Dialogs |
| Enter / Esc | Enter / Esc | OK / cancel | New session name, folder picker, "type delete to confirm", skill create dialogs |
| Enter | Enter | OK (Cmd+Enter in a multi-line field) | Text prompt dialogs |
| Cmd+Enter / Esc | Ctrl+Enter / Esc | Start / close | Plan a task and the other agent-workflow dialogs |
| Cmd+S | Ctrl+S | Save | Skill and command editor |
| Arrow keys | Arrow keys | Choose an option | Radio groups, such as Run in the new session dialog. On the Existing tab, arrows only move focus and Space picks the agent. |
| Arrow keys | Arrow keys | Move between cards | Empty dashboard |
| Esc | Esc | Dismiss the focused notification (or the newest one) | Notification stack |
| Left / Right (Shift for bigger steps), Home / End | Left / Right (Shift for bigger steps), Home / End | Resize the sidebar, Changes panel or preview | Focused resize handle |
| Enter | Enter | Switch between the default and wide Changes panel | Changes panel resize handle |

Tab, Shift+Tab, Enter and Space work on buttons, links and tabs as usual. [Accessibility](./accessibility.md) covers keyboard and screen reader use in more detail.
