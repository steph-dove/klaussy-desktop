# Task: Inline Diff Annotations (Monaco Editor UI & Agent Integration)

## 📋 Context & Goal
Enable developers to add inline feedback comments on any line of a diff inside the Monaco diff viewer. These comments must be aggregated and sent back directly to the active terminal agent (e.g. Claude Code or Codex) as prompt instructions.

---

## 📂 Files to Touch
*   [diff-panel-diff.js](file:///Users/stephaniedover/projects/klaussy-desktop/renderer/diff-panel-diff.js) (UI modifications for Monaco diff editor lines)
*   [diff-panel.js](file:///Users/stephaniedover/projects/klaussy-desktop/renderer/diff-panel.js) (Managing comment overlays and aggregation state)
*   [terminal-manager.js](file:///Users/stephaniedover/projects/klaussy-desktop/renderer/terminal-manager.js) (Injecting comments into the active agent command stream)

---

## ⚙️ Functional Requirements
1.  **Hover Indicators:** Hovering over a diff line should show a "+" indicator button.
2.  **Inline Edit Panel:** Clicking "+" must spawn a non-blocking comment editor text-area directly under that line.
3.  **Aggregation:** Support adding multiple comments across different lines and files. Show a floating "Send Comments to Agent" button when annotations are active.
4.  **Terminal Injection:** Clicking "Send" must format the comments into a structured prompt (e.g., `Review feedback on file X: Line Y: "..."`) and write it directly into the active PTY stream.

---

## 🛠️ Implementation Steps
1.  In `renderer/diff-panel-diff.js`, hook into the Monaco editor's mouse/hover events. Use Monaco's `changeViewZones` API to insert the comment element inline.
2.  Add a state array `activeAnnotations` in `renderer/diff-panel.js` containing `{ filePath, line, text }`.
3.  Implement a floating control bar in `renderer/diff-panel.js` that displays the current annotation count and has a "Send" button.
4.  Add a method in `renderer/terminal-manager.js` to write instructions to the active terminal using `pty.write()`.

---

## 🧪 Verification Plan
*   **Test Case 1:** Open a diff panel. Hover over a line, click "+", and ensure the inline text box renders correctly.
*   **Test Case 2:** Type a comment, add a second comment on another file, and verify both show up in the floating count.
*   **Test Case 3:** Click "Send to Agent" and verify the terminal receives the formatted text exactly.
