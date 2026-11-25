#!/usr/bin/env node
// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Runs only the e2e specs a change can affect, instead of all of them (~40 min).
//
//   npm run test:e2e:affected                 changes since origin/main, incl. uncommitted
//   npm run test:e2e:affected -- --base main  another base
//   npm run test:e2e:affected -- --list       print the specs and why, run nothing
//   npm run test:e2e:affected -- --all        run everything anyway
//   ... -- <after a second --, args pass to playwright>
//
// Playwright's own --only-changed can't do this: specs launch Electron rather than
// importing the app, so it only sees changes to the specs themselves. Instead,
// from each changed file:
//   - a spec runs; a shared fixture, main.js, startup code, CSS, a dependency
//     change or a deleted app file runs everything;
//   - a preload.js change: the channels on the lines it changed (anything else
//     on those lines runs everything);
//   - a main-process file: the IPC channels it (or anything requiring it)
//     registers, the preload APIs that call those channels, the renderer files
//     using those APIs, and the DOM ids and globals those files own;
//   - a renderer file: the DOM ids and globals it owns (one owning none runs
//     everything); an HTML file, its ids;
//   - then every spec that mentions any of those runs.
// A changed file no spec reaches is reported, so "nothing to run" is never silent.
// It errs toward running more: a spec that merely mentions an id runs.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const fileCache = new Map();
const read = (p) => {
  if (!fileCache.has(p)) {
    let text = '';
    try { text = fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { /* missing: '' */ }
    fileCache.set(p, text);
  }
  return fileCache.get(p);
};
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A JS identifier as a whole word (`\b` doesn't treat `$` as part of a name).
const word = (n) => `(?<![\\w$])${esc(n)}(?![\\w$])`;

// Changes to these can break any spec. (NO_E2E is checked first, so the two
// packaged-only files it lists are skipped even though they sit in main/bootstrap.)
const RUN_ALL = [
  /^e2e\/(fixtures|helpers|global-teardown)\.js$/, /^playwright\.config\.js$/,
  /^main\.js$/, /^main\/bootstrap\//, /^package(-lock)?\.json$/,
  /^renderer\/index\.html$/, /^renderer\/app\.js$/, /\.css$/, /^renderer\/vendor\//,
];
// Changes to these can't reach an e2e spec.
const NO_E2E = [
  // Inert unless the app is packaged, and e2e runs it unpackaged.
  /^main\/bootstrap\/auto-updater\.js$/, /^main\/util\/bundle-rename\.js$/,
  // web/ is browser mode, which e2e doesn't load (npm run test:web covers it);
  // build/ is electron-builder's packaging; images and icons don't change behavior.
  /\.md$/, /^docs\//, /^test\//, /^web\//, /^\.github\//,
  /^LICENSE/, /^\.gitignore$/, /^build\//, /^assets\/(?!.*\.(html|js)$)/,
];
// A script under scripts/ only matters when the app or a spec loads it.
function scriptMatters(file) {
  const name = path.basename(file, '.js');
  const re = new RegExp(`scripts\\/${esc(name)}(?:\\.js)?['"]`);
  const users = ['main.js', 'preload.js', ...walk('main', (p) => p.endsWith('.js')), ...walk('e2e', (p) => p.endsWith('.js'))];
  return users.some((f) => re.test(read(f)));
}
// Files with one spec of their own.
const OWN_SPEC = { 'scripts/screenshot.js': 'e2e/screenshot-script.spec.js' };

// Runs git; a failure stops the script with git's message, since a silent ''
// would read as "nothing changed". `allowFail` for questions whose no is an answer.
function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (allowFail) return '';
    const msg = (err.stderr || err.message || '').toString().trim();
    throw new Error(`git ${args.join(' ')} failed: ${msg}`);
  }
}

// Where this branch left `base`: every diff is taken from there, so commits that
// landed on main since aren't counted as this branch's.
function mergeBase(base) {
  if (!git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { allowFail: true }).trim()) {
    throw new Error(`--base ${base} isn't a commit git knows (try git fetch, or another --base)`);
  }
  return git(['merge-base', base, 'HEAD']).trim();
}

// Files changed since `from` (a commit), committed or not, plus untracked ones.
function changedFiles(from) {
  const lines = [
    git(['diff', '--name-only', from]),
    git(['ls-files', '--others', '--exclude-standard']),
  ].join('\n').split('\n').map((s) => s.trim()).filter(Boolean);
  return [...new Set(lines)];
}

// Whether package.json changed anything the app runs with: not the build config
// (electron-builder's), npm scripts, the version or description.
function packageJsonMatters(base) {
  try {
    const before = JSON.parse(git(['show', `${base}:package.json`], { allowFail: true }));
    const after = JSON.parse(read('package.json'));
    for (const o of [before, after]) { delete o.build; delete o.version; delete o.scripts; delete o.description; }
    return JSON.stringify(before) !== JSON.stringify(after);
  } catch { return true; }
}

function walk(dir, pred, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'vendor') walk(p, pred, out); } else if (pred(p)) out.push(p);
  }
  return out;
}

// ---- main process: who requires whom, and the channels each registers -----------

// The repo-relative file a relative require in `from` loads, as Node would.
function resolveRequire(from, spec) {
  const target = rel(path.resolve(ROOT, path.dirname(from), spec));
  if (target.endsWith('.js')) return target;
  if (fs.existsSync(path.join(ROOT, `${target}.js`))) return `${target}.js`;
  return `${target}/index.js`;
}

// `const x = require('./y')` and `const { a, b: c } = require('./y')` lines:
// [{ target, binding, names: [[exported, local], ...] }].
function requireBindings(file) {
  const out = [];
  for (const m of read(file).matchAll(/^(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/gm)) {
    const target = resolveRequire(file, m[2]);
    if (m[1].startsWith('{')) {
      const names = m[1].replace(/[{}]/g, '').split(',').map((x) => x.trim()).filter(Boolean)
        .map((x) => { const [orig, local] = x.split(':').map((y) => y.trim()); return [orig, local || orig]; });
      out.push({ target, binding: null, names });
    } else out.push({ target, binding: m[1], names: [] });
  }
  return out;
}

function mainGraph() {
  const files = ['main.js', ...walk('main', (p) => p.endsWith('.js'))];
  const dependents = new Map(files.map((f) => [f, new Set()]));
  const channels = new Map();
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const target = resolveRequire(f, m[1]);
      if (dependents.has(target)) dependents.get(target).add(f);
    }
    channels.set(f, new Set([...src.matchAll(/ipcMain\.(?:handle|on|once)\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1])));
  }
  return { dependents, channels };
}

// `file` and the modules that require it, directly or not, stopping at IPC
// handler files: a handler file's channels are what the rest of the app sees of
// it, so a change there doesn't spread to whatever else requires it.
const isHandlerFile = (f) => /^main\/ipc\//.test(f) || f === 'main.js';
function upward(file, dependents) {
  const seen = new Set([file]);
  const todo = isHandlerFile(file) ? [] : [file];
  while (todo.length) {
    for (const d of dependents.get(todo.pop()) || []) {
      if (seen.has(d)) continue;
      seen.add(d);
      if (!isHandlerFile(d)) todo.push(d);
    }
  }
  return seen;
}

// The channels on preload.js lines that changed, or null when a changed line
// isn't a channel wrapper (then anything could be affected).
function preloadChangedChannels(base) {
  const diff = git(['diff', '-U0', base, '--', 'preload.js']);
  const chans = new Set();
  for (const line of diff.split('\n')) {
    if (!/^[+-](?![+-])/.test(line)) continue;
    const body = line.slice(1).trim();
    if (!body || body.startsWith('//')) continue;
    const found = [...body.matchAll(/ipcRenderer\.(?:invoke|send|sendSync|on|once)\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    if (!found.length) return null;
    found.forEach((c) => chans.add(c));
  }
  return chans;
}

// ---- which handlers a change to a handler file touched --------------------------

// The new-side line numbers where a diff changed code in `file` (a deleted line
// counts as where it was), skipping blank lines and `//` comments: those can't
// change what runs. (Block comments count as code; running more is the safe side.)
// null for a file git doesn't have at `base`.
const isNoise = (t) => { const x = t.trim(); return !x || x.startsWith('//'); };
function changedLines(file, base) {
  if (!git(['ls-tree', '--name-only', base, '--', file], { allowFail: true }).trim()) return null;
  const lines = new Set();
  lines.removed = []; // the code lines the diff took out
  let newLine = 0;
  for (const line of git(['diff', '-U0', base, '--', file]).split('\n')) {
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h) { newLine = Number(h[1]); if (h[2] === '0') newLine += 1; continue; }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) { if (!isNoise(line.slice(1))) lines.add(newLine); newLine++; } else if (line.startsWith('-')) {
      if (!isNoise(line.slice(1))) { lines.add(Math.max(newLine, 1)); lines.removed.push(line.slice(1)); }
    }
  }
  return lines;
}

// The names a `const { a, b } = require(...)` line declares, or null.
function importNames(line) {
  const v = line.match(/^(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*require\(/);
  return v ? v[1].replace(/[{}]/g, '').split(',').map((x) => x.split(':').pop().trim()).filter((x) => /^[\w$]+$/.test(x)) : null;
}
const requirePath = (line) => { const m = line.match(/require\(\s*['"]([^'"]+)['"]/); return m ? m[1] : null; };

// Top-level pieces of a file: a handler (its channel) or a declaration (the names
// it declares, destructuring included), each running until the next thing that
// starts at column 0. `module.exports` is its own piece: changing it can't change
// a handler.
function segments(src) {
  const out = [];
  src.split('\n').forEach((line, i) => {
    const h = line.match(/^ipcMain\.(?:handle|on|once)\(\s*['"]([^'"]+)['"]/);
    const fn = line.match(/^(?:async\s+)?function\*?\s+(\w+)|^class\s+(\w+)/);
    const v = line.match(/^(?:const|let|var)\s+(\{[^}]*\}|\[[^\]]*\]|\w+)/);
    let seg = null;
    if (h) seg = { channel: h[1] };
    else if (/^module\.exports\b/.test(line)) seg = { exports: true };
    else if (fn) seg = { names: [fn[1] || fn[2]] };
    else if (v) seg = { names: v[1].replace(/[{}[\]]/g, '').split(',').map((x) => x.split(':').pop().split('=')[0].trim()).filter((x) => /^\w+$/.test(x)) };
    else if (/^\S/.test(line) && !/^[}\])]/.test(line) && !line.startsWith('//')) seg = {};
    if (seg) out.push({ start: i + 1, text: [], ...seg });
    if (out.length) out[out.length - 1].text.push(line);
  });
  return out;
}

const usesName = (text, names) => [...names].some((n) => new RegExp(word(n)).test(text));

// The handlers reached from `names`: ones using a name, or using a declaration
// that (transitively) uses one.
function handlersUsing(segs, names) {
  const tainted = new Set(names);
  for (let grew = true; grew;) {
    grew = false;
    for (const g of segs) {
      // An import line declares names; it doesn't use them, so it passes nothing on.
      if (!g.names || importNames(g.text[0]) || g.names.every((n) => tainted.has(n))) continue;
      if (usesName(g.text.join('\n'), tainted)) { g.names.forEach((n) => tainted.add(n)); grew = true; }
    }
  }
  return segs.filter((g) => g.channel && usesName(g.text.join('\n'), tainted)).map((g) => g.channel);
}

// The channels a change to handler file `file` can reach: handlers whose own lines
// changed, and handlers using a top-level name whose lines changed. null when a
// change can't be placed (a new file, top-level code with no name).
function touchedChannels(file, base) {
  const lines = changedLines(file, base);
  if (!lines) return null;
  const segs = segments(read(file));
  const chans = new Set();
  const names = new Set();
  for (const n of lines) {
    const seg = [...segs].reverse().find((g) => g.start <= n);
    if (!seg) continue; // the file's header
    if (seg.channel) chans.add(seg.channel);
    else if (seg.exports) continue;
    else if (seg.names && seg.names.length) {
      // A changed require line: only the names it added or dropped matter.
      // The removed line it replaced is the one requiring the same path.
      const now = importNames(seg.text[0]);
      const from = requirePath(seg.text[0]);
      const old = now && from && lines.removed.find((l) => requirePath(l) === from);
      const before = old ? importNames(old) : null;
      if (now && before) {
        now.filter((x) => !before.includes(x)).forEach((x) => names.add(x));
        before.filter((x) => !now.includes(x)).forEach((x) => names.add(x));
      } else seg.names.forEach((x) => names.add(x));
    } else return null;
  }
  if (names.size) {
    const users = handlersUsing(segs, names);
    // A changed name no handler here uses (an export other modules call): can't tell.
    if (!users.length) return null;
    users.forEach((c) => chans.add(c));
  }
  return chans;
}

// The channels in handler file `hfile` that use one of the modules in `mods`:
// handlers naming a binding it was required as (or requiring it inline), and
// handlers using a top-level declaration that does. null when the file uses it
// some way this can't follow (a bare require for side effects).
function channelsUsing(hfile, mods) {
  const src = read(hfile);
  const names = new Set();
  for (const r of requireBindings(hfile)) {
    if (!mods.has(r.target)) continue;
    if (r.binding) names.add(r.binding);
    r.names.forEach(([, local]) => names.add(local));
  }
  const segs = segments(src);
  const chans = new Set(handlersUsing(segs, names));
  // An inline require inside a handler, or inside a declaration a handler uses.
  const inlineRequires = (text) => [...text.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)].some((m) => mods.has(resolveRequire(hfile, m[1])));
  const inline = segs.filter((g) => !importNames(g.text[0]) && inlineRequires(g.text.join('\n')));
  for (const g of inline) {
    if (g.channel) chans.add(g.channel);
    else if (g.names) handlersUsing(segs, g.names).forEach((c) => chans.add(c));
  }
  return chans.size ? chans : null;
}

// The top-level names in shared module `file` a change reached: declarations whose
// code changed, and (transitively) the ones using them. null when a change can't
// be placed, or the file is new.
function reachedExports(file, base) {
  const lines = changedLines(file, base);
  if (!lines) return null;
  const segs = segments(read(file));
  const names = new Set();
  for (const n of lines) {
    const seg = [...segs].reverse().find((g) => g.start <= n);
    if (!seg || seg.exports) continue; // header, or the export list (a new export is unused so far)
    if (!seg.names || !seg.names.length) return null;
    seg.names.forEach((x) => names.add(x));
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const g of segs) {
      if (!g.names || importNames(g.text[0]) || g.names.every((n) => names.has(n))) continue;
      if (usesName(g.text.join('\n'), names)) { g.names.forEach((n) => names.add(n)); grew = true; }
    }
  }
  return names;
}

// Handlers in `hfile` using one of `names` from module `mod`: through a
// destructured binding, `binding.name`, or an inline `require(...).name`.
function channelsUsingNames(hfile, mod, names) {
  const src = read(hfile);
  const segs = segments(src);
  const locals = new Set();   // destructured names bound to a reached export
  const dotted = [];          // [binding, name] for `binding.name`
  for (const r of requireBindings(hfile)) {
    if (r.target !== mod) continue;
    if (r.binding) for (const n of names) dotted.push([r.binding, n]);
    for (const [orig, local] of r.names) if (names.has(orig)) locals.add(local);
  }
  const chans = new Set(handlersUsing(segs, locals));
  // Inline: require('./mod').name, or const { name } = require('./mod') inside a body.
  const inlineRe = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)\s*\.\s*([\w$]+)|\{([^}]*)\}\s*=\s*require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  for (const g of segs) {
    if (importNames(g.text[0])) continue;
    const text = g.text.join('\n');
    let hit = dotted.some(([b, n]) => new RegExp(`${word(b)}\\s*\\.\\s*${word(n)}`).test(text));
    for (const m of text.matchAll(inlineRe)) {
      const spec = m[1] || m[4];
      if (resolveRequire(hfile, spec) !== mod) continue;
      const picked = m[2] ? [m[2]] : m[3].split(',').map((x) => x.split(':')[0].trim());
      if (picked.some((x) => names.has(x))) hit = true;
    }
    if (!hit) continue;
    if (g.channel) chans.add(g.channel);
    else if (g.names) handlersUsing(segs, g.names).forEach((c) => chans.add(c));
  }
  return chans;
}

// ---- preload: channel -> window.klaus API path ----------------------------------

function preloadApis() {
  const byChannel = new Map();
  const stack = []; // [{ key, indent }]
  let member = null;
  for (const line of read('preload.js').split('\n')) {
    const indent = line.length - line.trimStart().length;
    // A namespace closes on a `}` line at (or left of) its own indent; braces of
    // object literals inside members sit deeper, so they never match.
    if (stack.length && /^\s*\}/.test(line) && indent <= stack[stack.length - 1].indent) stack.pop();
    const ns = line.match(/^(\s*)(\w+):\s*\{\s*$/);
    if (ns) { stack.push({ key: ns[2], indent: ns[1].length }); continue; }
    const mem = line.match(/^\s*(\w+):\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/);
    if (mem) member = [...stack.map((s) => s.key), mem[1]].join('.');
    for (const m of line.matchAll(/ipcRenderer\.(?:invoke|send|sendSync|on|once)\(\s*['"]([^'"]+)['"]/g)) {
      if (!member) continue;
      if (!byChannel.has(m[1])) byChannel.set(m[1], new Set());
      byChannel.get(m[1]).add(member);
    }
  }
  return byChannel;
}

// ---- renderer: what a file owns --------------------------------------------------

function rendererOwns(file) {
  const src = read(file);
  const tokens = new Set();
  if (file.endsWith('.html')) {
    for (const m of src.matchAll(/\bid="([\w-]+)"/g)) tokens.add(`#${m[1]}`);
    return tokens;
  }
  for (const m of src.matchAll(/getElementById\(\s*['"]([\w-]+)['"]/g)) tokens.add(`#${m[1]}`);
  for (const m of src.matchAll(/querySelector(?:All)?\(\s*['"]#([\w-]+)/g)) tokens.add(`#${m[1]}`);
  for (const m of src.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) tokens.add(`window.${m[1]}`);
  // A file that extends a global it's handed: `})(window.PrReview)` or `root.CopyCommand = ...`.
  for (const m of src.matchAll(/\}\)\(\s*window\.([A-Za-z_$][\w$]*)\s*\)/g)) tokens.add(`window.${m[1]}`);
  for (const m of src.matchAll(/\broot\.([A-Z][\w$]*)\s*=(?!=)/g)) tokens.add(`window.${m[1]}`);
  // And the window.klaus APIs it calls.
  for (const m of src.matchAll(/\bklaus\.([\w$]+(?:\.[\w$]+)+)\s*\(/g)) tokens.add(`api:${m[1]}`);
  return tokens;
}

// ---- specs -----------------------------------------------------------------------

// Whether a spec's text mentions a token: "#id" as a selector or quoted id,
// "window.X" as window.X or X., "api:a.b" as klaus.a.b, "ch:x" as 'x'.
function mentions(text, token) {
  if (token.startsWith('#')) {
    const id = esc(token.slice(1));
    return new RegExp(`#${id}(?![\\w-])|['"\`]${id}['"\`]`).test(text);
  }
  if (token.startsWith('window.')) return new RegExp(`\\b${esc(token.slice(7))}\\.`).test(text);
  if (token.startsWith('api:')) return new RegExp(`klaus\\.${esc(token.slice(4))}\\b`).test(text);
  if (token.startsWith('ch:')) return new RegExp(`['"\`]${esc(token.slice(3))}['"\`]`).test(text);
  return false;
}

function affected(changed, base = 'origin/main') {
  const specs = walk('e2e', (p) => p.endsWith('.spec.js'));
  const reasons = new Map(); // spec -> Set(reason)
  const add = (spec, why) => { if (!reasons.has(spec)) reasons.set(spec, new Set()); reasons.get(spec).add(why); };
  const unreached = [];
  const runAll = [];
  let graph = null;
  let apis = null;
  let rendererFiles = null;
  const specText = new Map(specs.map((s) => [s, read(s)]));

  for (const file of changed) {
    if (NO_E2E.some((r) => r.test(file))) continue;
    if (/^scripts\//.test(file) && !OWN_SPEC[file]) {
      if (scriptMatters(file)) runAll.push(`${file} (the app or a spec loads it)`);
      continue;
    }
    // A deleted app file: whatever used it is broken or changed, and the file isn't
    // there to read, so be safe.
    if (/^(main\/|renderer\/|preload\.js$)/.test(file) && !fs.existsSync(path.join(ROOT, file))) {
      runAll.push(`${file} (deleted)`);
      continue;
    }
    if (file === 'package.json' && !packageJsonMatters(base)) continue;
    if (RUN_ALL.some((r) => r.test(file))) { runAll.push(file); continue; }
    if (OWN_SPEC[file]) { add(OWN_SPEC[file], `${file} changed`); continue; }
    if (/^e2e\/.*\.spec\.js$/.test(file)) { if (fs.existsSync(path.join(ROOT, file))) add(file, 'the spec changed'); continue; }

    const tokens = new Map(); // token -> why
    if (file === 'preload.js') {
      const chans = preloadChangedChannels(base);
      if (!chans) { runAll.push("preload.js (a change that isn't one channel wrapper)"); continue; }
      apis = apis || preloadApis();
      for (const ch of chans) {
        tokens.set(`ch:${ch}`, `IPC ${ch}`);
        for (const api of apis.get(ch) || []) tokens.set(`api:${api}`, `klaus.${api} (${ch})`);
      }
    } else if (/^main\//.test(file) && file.endsWith('.js')) {
      graph = graph || mainGraph();
      apis = apis || preloadApis();
      rendererFiles = rendererFiles || walk('renderer', (p) => /\.(js|html)$/.test(p));
      const up = upward(file, graph.dependents);
      // A handler file: only the handlers the change touched, when that can be told.
      let chans;
      if (isHandlerFile(file)) {
        chans = touchedChannels(file, base) || graph.channels.get(file) || new Set();
      } else {
        // A shared module: the handlers, in the handler files that reach it, that use
        // it. Handler files requiring it directly count only handlers that use one of
        // its names the change reached, when those can be told.
        chans = new Set();
        const reached = reachedExports(file, base);
        const mods = new Set([...up].filter((f) => !isHandlerFile(f)));
        for (const h of [...up].filter(isHandlerFile)) {
          const direct = reached && (graph.dependents.get(file) || new Set()).has(h) ? channelsUsingNames(h, file, reached) : null;
          for (const c of direct || channelsUsing(h, mods) || graph.channels.get(h) || []) chans.add(c);
        }
      }
      for (const ch of chans) {
        tokens.set(`ch:${ch}`, `IPC ${ch}`);
        for (const api of apis.get(ch) || []) {
          tokens.set(`api:${api}`, `klaus.${api} (${ch})`);
          const re = new RegExp(`klaus\\.${esc(api)}(?![\\w$])`);
          for (const rf of rendererFiles) {
            if (!re.test(read(rf))) continue;
            // Its elements and globals; not the other APIs it calls, which this change didn't touch.
            for (const t of rendererOwns(rf)) {
              if (!t.startsWith('api:') && !tokens.has(t)) tokens.set(t, `${t} in ${rf}, which calls klaus.${api}`);
            }
          }
        }
      }
    } else if (/^renderer\//.test(file) && /\.(js|html)$/.test(file)) {
      for (const t of rendererOwns(file)) tokens.set(t, `${t} in ${file}`);
      // A helper with no ids or globals of its own: its users can't be told apart.
      if (!tokens.size) { runAll.push(`${file} (owns no ids or globals to follow)`); continue; }
    } else {
      // Anything else (a new top-level folder, an asset the UI loads): be safe.
      runAll.push(`${file} (not mapped)`);
      continue;
    }

    let hit = false;
    for (const [spec, text] of specText) {
      for (const [t, why] of tokens) {
        if (mentions(text, t)) { add(spec, `${file}: ${why}`); hit = true; break; }
      }
    }
    if (!hit) unreached.push(file);
  }
  return { specs, reasons, unreached, runAll };
}

function main() {
  const argv = process.argv.slice(2);
  const dd = argv.indexOf('--');
  const own = dd === -1 ? argv : argv.slice(0, dd);
  const passthrough = dd === -1 ? [] : argv.slice(dd + 1);
  const baseIdx = own.indexOf('--base');
  const base = baseIdx !== -1 ? own[baseIdx + 1] : 'origin/main';
  const list = own.includes('--list');

  let from;
  try { from = mergeBase(base); } catch (err) { console.error(err.message); return 2; }
  const changed = changedFiles(from);
  const { specs, reasons, unreached, runAll } = affected(changed, from);
  const forced = own.includes('--all');
  const all = forced || runAll.length > 0;
  const chosen = all ? specs : [...reasons.keys()].sort();

  console.log(`${changed.length} changed file(s) since ${base} (merge base ${from.slice(0, 7)}).`);
  if (forced) console.log('Running every spec (--all).');
  else if (runAll.length) console.log(`Running every spec because of:\n  ${runAll.join('\n  ')}`);
  else {
    for (const s of chosen) console.log(`  ${s}\n    ${[...reasons.get(s)].slice(0, 3).join('\n    ')}`);
  }
  if (unreached.length) console.log(`No spec reaches:\n  ${unreached.join('\n  ')}\n  (unit tests are the check for these)`);
  if (!chosen.length) { console.log('No e2e specs to run.'); return 0; }
  console.log(`${chosen.length} of ${specs.length} specs.`);
  if (list) return 0;
  // Playwright's CLI through this Node, not npx (npx.cmd on Windows needs a shell).
  const cli = require.resolve('@playwright/test/cli', { paths: [ROOT] });
  const r = spawnSync(process.execPath, [cli, 'test', ...chosen, ...passthrough], { cwd: ROOT, stdio: 'inherit' });
  return r.status == null ? 1 : r.status;
}

if (require.main === module) process.exit(main());

module.exports = {
  affected, mentions, preloadApis, mainGraph, upward, rendererOwns, segments, handlersUsing, importNames,
  resolveRequire, requireBindings,
};
