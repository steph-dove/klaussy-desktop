// Terminal pipeline: spawn a shell instance via open-folder, write a
// command into the pty, read it back through the terminal-data event
// stream. Exercises node-pty + write-terminal IPC + terminal-data fan-out
// — the riskiest plumbing in the app, and the bit that breaks when the
// asarUnpack config or electron-rebuild step regresses.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { test, expect } = require('./fixtures');

test('open-folder spawns a shell that echoes input via terminal-data', async ({ mainWindow }) => {
  await mainWindow.waitForLoadState('networkidle');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-e2e-shell-'));
  let taskId = null;
  try {
    const inst = await mainWindow.evaluate(
      (folderPath) => window.klaus.task.openFolder(folderPath, 'shell'),
      tmpDir,
    );
    expect(inst, 'open-folder should return an instance').toBeTruthy();
    expect(inst.id).toBeDefined();
    taskId = inst.id;

    // Subscribe in the renderer, write a marker through write-terminal,
    // resolve when the marker comes back via terminal-data. The shell
    // echoes the typed command line + the printf output.
    const output = await mainWindow.evaluate((id) => new Promise((resolve) => {
      let buf = '';
      const unsub = window.klaus.terminal.onData(id, (data) => {
        buf += data;
        if (buf.includes('hi-from-e2e')) {
          unsub();
          resolve(buf);
        }
      });
      // Tiny delay so the shell prompt is up before we type into it.
      setTimeout(() => {
        window.klaus.terminal.write(id, 'printf hi-from-e2e\\n\n');
      }, 250);
      // Safety timeout — fail loud rather than hang the test runner.
      setTimeout(() => { unsub(); resolve(buf); }, 8000);
    }), taskId);

    expect(output, `terminal output:\n${output}`).toContain('hi-from-e2e');
  } finally {
    if (taskId != null) {
      await mainWindow.evaluate((id) => window.klaus.task.kill(id), taskId).catch(() => {});
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
