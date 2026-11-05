#!/usr/bin/env node
// Screenshots the real app past its first-run screens, for plans and QA that need
// "the app as it is". Boots it like e2e/fixtures.js (fresh userData, KLAUSSY_E2E=1,
// the Setup check dialog removed), loads a repo into the Files tab, and saves a PNG.
//
//   npm run screenshot -- --out shots/tree.png
//   npm run screenshot -- --out shots/menu.png --repo ~/code/app --right-click src
//
// No display (CI, containers): run it under `xvfb-run -a`. For other screens, require
// this file and use launch(), which returns the app with that setup done.

/* global document, window, MutationObserver -- the evaluate() callbacks run in the page */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { _electron: electron } = require('@playwright/test');

const repoRoot = path.resolve(__dirname, '..');

// A small repo for when none is given, with a folder to open and files to point at.
function sampleRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-shot-repo-'));
  const files = {
    'README.md': '# sample\n',
    'package.json': '{ "name": "sample" }\n',
    'src/index.js': 'module.exports = {};\n',
    'src/util.js': '',
    'src/components/Button.js': '',
    'docs/notes.md': '# notes\n',
  };
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=shot@klaussy.test', '-c', 'user.name=shot', 'add', '.');
  git('-c', 'user.email=shot@klaussy.test', '-c', 'user.name=shot', 'commit', '-q', '-m', 'init');
  return dir;
}

async function launch({ repo } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'klaussy-shot-'));
  const repoDir = repo ? path.resolve(repo) : sampleRepo();
  const app = await electron.launch({
    args: [path.join(repoRoot, 'main.js'), `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: { ...process.env, KLAUSSY_E2E: '1' },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  // The Setup check dialog pops whenever a CLI is missing, which is always true in a sandbox.
  await win.evaluate(() => {
    const kill = () => { const o = document.getElementById('deps-overlay'); if (o) o.remove(); };
    kill();
    new MutationObserver(kill).observe(document.documentElement, { childList: true, subtree: true });
  });
  await win.waitForLoadState('networkidle');
  // With no task open, the panel button does nothing, so open the panel on the repo directly.
  await win.evaluate(async (dir) => {
    window.DiffPanel.show(dir);
    window.App.forceFilesTab();
    await window.FileBrowser.loadFileTree(dir);
  }, repoDir);
  await win.locator('#file-tree .file-tree-label').first().waitFor();
  const close = async () => {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    if (!repo) fs.rmSync(repoDir, { recursive: true, force: true });
  };
  return { app, win, repoDir, close };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!['--out', '--repo', '--right-click'].includes(flag) || i + 1 >= argv.length) {
      throw new Error(`usage: screenshot --out FILE.png [--repo DIR] [--right-click NAME] (got ${flag})`);
    }
    args[flag.slice(2)] = argv[(i += 1)];
  }
  if (!args.out) throw new Error('usage: screenshot --out FILE.png [--repo DIR] [--right-click NAME]');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { win, close } = await launch({ repo: args.repo });
  try {
    if (args['right-click']) {
      const row = win.locator('#file-tree .file-tree-label', { hasText: args['right-click'] }).first();
      await row.click({ button: 'right' });
      await win.waitForTimeout(300);
    }
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    await win.screenshot({ path: args.out });
    console.log(`saved ${args.out}`);
  } finally {
    await close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { launch };
