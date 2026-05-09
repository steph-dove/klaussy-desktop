# Linux smoke checklist

This file is for whoever runs the first manual verification of the Linux
port. Code-level changes are in place; what's left is to confirm the
assumptions hold under bash on Ubuntu, and that the AppImage / deb
installers work.

Primary target distro is **Ubuntu 22.04+** but the AppImage should run
on most modern x86_64 Linux. The deb is Debian/Ubuntu-specific.

## Prereqs on the test machine

- **Ubuntu 22.04 / 24.04** (or any glibc 2.31+ distro for the AppImage).
- **Node 20 LTS** — install via NodeSource or `nvm`.
- **Git** (`apt install git`).
- **build-essential + libnss3 + libsecret-1-dev** — needed for both
  electron-rebuild (node-pty native build) and the deb runtime deps.
  ```bash
  sudo apt install build-essential python3 libnss3 libsecret-1-dev libnotify-dev
  ```
- **Optional**: snap (for the Ollama install path), gh CLI, claude CLI.

```bash
git clone https://github.com/steph-dove/klausify-desktop.git
cd klausify-desktop
npm ci
npm run rebuild     # rebuilds node-pty against Electron's ABI
npm start           # `electron .` — should open the main window
```

## Smoke run order

Run in dev mode (`npm start`) for everything except §6 (build).

### Shell + PTY

- [ ] Open a folder with no git (the empty-state link). A terminal opens.
- [ ] Type `echo hello` ⏎. Output appears.
- [ ] Confirm the resolved shell is whatever `$SHELL` points at (usually
      `/bin/bash` on Ubuntu).
- [ ] Create a Worktree from a real git project. Terminal opens with
      Claude (if `claude` is on PATH) or the shell.
- [ ] Open a sub-terminal in an existing task. Subterminal works.
- [ ] Restart Task. PTY rebinds to a fresh shell.

### fixSpawnPath + LSP install messages

- [ ] **fixSpawnPath**: launch the AppImage from a desktop launcher (not
      a terminal). Open a terminal and run `which claude` / `which gh`.
      They resolve. (If they don't, the install put them outside the
      user's session-PATH; not a Klaussy regression.)
- [ ] Open a `.py` file when pyright is missing. Hint dialog points at
      `pipx install pyright` or `npm install -g pyright`. *Not* brew.
- [ ] Open a `.cpp` file when clangd is missing. Hint suggests apt /
      dnf / package-manager install paths (the `default` branch in
      lsp-manager.js).
- [ ] Open a `.md` file when marksman is missing. Hint points at the
      GitHub releases page since most distros don't package marksman.

### Ollama

- [ ] When ollama isn't on PATH and snap is installed, the consent flow
      offers to install via snap. Click Install — it runs
      `snap install ollama --classic` without hanging.
- [ ] After snap completes, the model pull begins automatically.
- [ ] When snap isn't installed (e.g. minimal Ubuntu Server), the modal
      surfaces the `curl … install.sh | sh` recipe so the user can run
      it themselves.

### Build

- [ ] `npm run dist:linux` produces:
      - [ ] `dist/Klaussy-<version>-x64.AppImage` (universal)
      - [ ] `dist/Klaussy-<version>-x64.deb` (Debian/Ubuntu)
- [ ] Make the AppImage executable (`chmod +x`) and double-click. App
      launches without writing to the system.
- [ ] `sudo dpkg -i Klaussy-<version>-x64.deb`. App appears in the
      Activities/applications menu.
- [ ] Launch from Activities menu. App opens normally.
- [ ] `sudo apt remove klaussy`. App is gone; `~/.config/Klaussy/`
      (config.json, sessions) is preserved.

## Known gaps (deferred from this slice)

- **No code signing on Linux.** Linux desktop signing is essentially
  optional — most users don't have a way to verify it anyway. AppImages
  can be signed with `gpg` and verified by `appimaged`, but the value
  is small and we'll skip until a user asks.
- **deb and AppImage published in the same GitHub Release.** The deb
  has `apt`-friendly auto-update (via a custom apt repo) but we're not
  hosting one yet — users who want auto-updates should use the AppImage
  (electron-updater handles its update flow natively).
- **No flatpak or snap publishing.** Both require their own publishing
  pipelines and account setup. Skip until the AppImage / deb pair
  proves insufficient.
- **arm64 Linux** is not currently a build target. Add later if anyone
  with a Linux ARM box (Raspberry Pi, Apple Silicon Asahi, etc.) asks.
- **e2e CI on Linux** stays off until the manual smoke confirms the
  shell + AppImage. Then add `ubuntu-latest` to the matrix in
  `.github/workflows/ci.yml` — it'll be the *cheapest* runner of the
  three (1× billing rate vs Mac's 10× and Windows's 2×).

## What to do if something fails

Capture: `npm start` console output, plus
`~/.config/Klaussy/logs/main.log` and the trace from
`~/.config/Klaussy/logs/renderer.log`. Open an issue with the spec
section that broke, the failing command/click, and the log tails.
