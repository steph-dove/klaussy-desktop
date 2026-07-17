# Task: Visual Pre-Commit Hook Setup Wizard

## 📋 Context & Goal
A core value of Klaussy is the commit-time review gate. Developers currently have to set this up manually in the command line. This task adds a single-click button in the repository view that automatically writes the pre-commit audit hooks to the local `.git/hooks/` directory.

---

## 📂 Files to Touch
*   [sidebar-manager.js](file:///Users/stephaniedover/projects/klaussy-desktop/renderer/sidebar-manager.js) (UI button triggering hook installer)
*   `main/ipc/repo.js` (IPC handler to execute hook injection)
*   `main/util/exec.js` (Writing file permissions and hook templates)

---

## ⚙️ Functional Requirements
1.  **Detect Status:** Detect if a pre-commit hook is already active in the current workspace.
2.  **Wizard UI:** Display a banner/button: "Enable Commit Review Gate" in the project details.
3.  **File Generation:** Generate a standard `.git/hooks/pre-commit` script that triggers `klaussy-agents review --staged`.
4.  **Executable Permissions:** Ensure the file is executable (`chmod +x`) on macOS/Linux.

---

## 🛠️ Implementation Steps
1.  Add a `checkPreCommitHook` method in `main/ipc/repo.js` that checks for the existence of `.git/hooks/pre-commit`.
2.  Add a button in `renderer/sidebar-manager.js` that calls the IPC channel `repo:install-hook`.
3.  In `main/ipc/repo.js`, implement the install handler. Write the shell script template and use Node's `fs.chmodSync` to make it executable.

---

## 🧪 Verification Plan
*   **Test Case 1:** Verify the banner shows up when a repo has no hook.
*   **Test Case 2:** Click the button, and verify the file `.git/hooks/pre-commit` is created with correct contents.
*   **Test Case 3:** Try to make a commit in the repository and verify the hook runs prior to commit completion.
