# Task: Live HTML/JS Artifact & Markdown Preview Tab

## 📋 Context & Goal
When developers use agents to write UI elements, they want to see live previews of the rendered output (HTML, SVG, React, Markdown) in-app, instead of opening an external browser.

---

## 📂 Files to Touch
*   [markdown-preview.js](file:///Users/stephaniedover/projects/klaussy-desktop/renderer/markdown-preview.js) (Extend to handle raw HTML/JS rendering)
*   [app.js](file:///Users/stephaniedover/projects/klaussy-desktop/renderer/app.js) (Add split preview pane layout)
*   `renderer/artifact-preview.js` (New file: handles iframe rendering, isolation, and reload events)

---

## ⚙️ Functional Requirements
1.  **Split View Panel:** Add a toggleable split view next to the code editor.
2.  **Safe Rendering:** Render HTML and SVG in an isolated iframe (`sandbox="allow-scripts"`).
3.  **Auto-Reload:** Whenever the active file is saved or modified by the agent, automatically trigger a refresh of the iframe.

---

## 🛠️ Implementation Steps
1.  Create `renderer/artifact-preview.js` managing a `<webview>` or `<iframe>` component.
2.  Add a configuration listener that checks the file extension of the active tab. Show the preview tab option if the extension is `.html`, `.svg`, or `.md`.
3.  Listen to the file watcher events in `renderer/app.js` and reload the iframe when changes are detected in the active file.

---

## 🧪 Verification Plan
*   **Test Case 1:** Open an HTML file and toggle split-preview. Verify the rendered HTML displays correctly.
*   **Test Case 2:** Edit a style or text in the HTML, save it, and verify the preview automatically reloads the new changes.
