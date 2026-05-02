# Windows smoke checklist

This file is for whoever runs the first manual verification of the Windows
port on a real Win11 host. The code-level slices (§1–§5 in the
`Windows spike` commit and its follow-ups) are all in place; what's left
is to confirm the assumptions hold under PowerShell and the WindowsHost
PATH layout.

## Prereqs on the test machine

- **Win11 22H2 or later** (older builds don't have ConPTY, which node-pty
  needs).
- **Node 20 LTS** (`winget install OpenJS.NodeJS.LTS`).
- **Git for Windows** (`winget install Git.Git`).
- **Visual Studio Build Tools** with the "Desktop development with C++"
  workload (needed for `electron-rebuild` to compile node-pty).
- **Optional**: pipx, gh, claude — exercise the install prompts when
  they're missing.

```powershell
git clone https://github.com/steph-dove/klausify-desktop.git
cd klausify-desktop
npm ci
npm run rebuild     # rebuilds node-pty against Electron's ABI
npm start           # `electron .` — should open the main window
```

## Smoke run order

Run in dev mode (`npm start`) for everything except §6 (build).

### §1 + §2 — PTY spawn

- [ ] Open a folder with no git (the empty-state link). A terminal opens.
- [ ] Type `echo hello` ⏎. Output appears.
- [ ] Confirm the resolved shell is `pwsh.exe` if installed, else
      `powershell.exe`. (Cmd palette > "Reload" if you swap shells via
      `$env:SHELL` between tests.)
- [ ] Create a Worktree from a real git project. Terminal opens with
      Claude (if `claude.exe` is on PATH) or the shell.
- [ ] Open a sub-terminal in an existing task. Subterminal works.
- [ ] Restart Task. PTY rebinds to a fresh shell.

### §3 — Path probes + LSP messages

- [ ] **fixSpawnPath**: launch the packaged build (NSIS) from the Start
      menu. Open a terminal and run `where claude` / `where gh`. They
      resolve. (If they don't, the install put them outside the user's
      registry-PATH; not a Klaussy regression.)
- [ ] Open a `.py` file when pyright is missing. Install hint dialog
      appears with the `pipx install pyright` text.
- [ ] Open a `.cpp` file when clangd is missing. Hint suggests
      `winget install LLVM.LLVM` / `scoop install llvm`. *Not* the
      brew text.
- [ ] Open a `.md` file when marksman is missing. Hint suggests
      `scoop install marksman` / GitHub releases. *Not* brew.

### §4 — Ollama

- [ ] When `ollama.exe` is not on PATH, the consent flow offers to
      install via winget. Click Install. winget kicks off without a
      Y/N prompt that hangs the modal.
- [ ] After winget completes, the model pull begins automatically.
- [ ] If `winget` itself isn't installed, the modal points at
      `https://ollama.com/download/windows` instead.

### §5 — Build

- [ ] `npm run dist:win` produces:
      - [ ] `dist/Klaussy-<version>-x64-nsis.exe` (installer)
      - [ ] `dist/Klaussy-<version>-x64-portable.exe` (portable)
- [ ] Run the installer. Choose a non-default install dir. App lands
      there, Start menu shortcut "Klaussy" is created.
- [ ] Launch from Start menu. App opens normally.
- [ ] Quit the installer-installed instance. Run the portable.exe.
      It launches without writing to the install dir.
- [ ] Uninstall via "Add or remove programs". Klaussy is gone;
      `%APPDATA%\Klaussy\` (config.json, sessions) is preserved
      (deleteAppDataOnUninstall: false).

### Polish — klausify prompt

- [ ] With pipx not installed: New Worktree → klausify prompt shows the
      Windows variant ("python -m pip install --user pipx") instead of
      the brew variant.
- [ ] With pipx installed but klausify missing: clicking "Install with
      pipx" runs successfully.

## Known gaps (deferred from this slice)

- **Project search in non-git folders** falls back to `grep -rnF`. Plain
  Windows doesn't ship grep, but Git for Windows does — and we already
  require Git for Windows for everything else, so its bin dir on PATH
  carries grep along. Confirm during smoke that searching inside a
  *non-git* folder (open-folder flow) still returns hits. If it doesn't,
  the fix is replacing the grep fallback with an in-process JS walker.
- **No code signing** yet. SmartScreen will warn on first launch of the
  NSIS installer until a real Authenticode cert is wired via `CSC_LINK`
  + `CSC_KEY_PASSWORD`. Both are read by electron-builder automatically
  once they're in env.
- **`.ico` is rebuilt from `icon.png`** via `node scripts/generate-icon-ico.js`
  whenever the source icon changes. Bundles 16/32/48/256. The 256 entry
  is BMP-encoded (~270K of the 285K total) instead of PNG-embedded —
  bloated but valid; if installer size becomes a concern, swap the
  generator for one that PNG-embeds the 256.
- **Auto-updater on Windows** is wired (electron-updater works on both
  platforms), but signed installers are needed for the update flow to
  not flag SmartScreen on every release.
- **e2e CI on Windows** stays off until the manual smoke confirms the
  shell path. Then add `windows-latest` to the matrix in
  `.github/workflows/ci.yml`.

## What to do if something fails

Capture: `npm start` console output, plus
`%APPDATA%\Klaussy\logs\main.log` and the trace from
`%APPDATA%\Klaussy\logs\renderer.log`. Open an issue with the spec
section that broke, the failing command/click, and the log tails.
