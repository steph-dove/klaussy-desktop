// File IPC: tree listing, bulk read, search + replace, merge-conflict
// read/write, .env viewer/editor, worktree watch subscriptions, and the
// single-file read/write used by the Monaco viewer.
//
// Every filesystem IPC here goes through pathUnder / pathUnderAnyRoot so an
// XSS in the renderer can't coerce main into reading ~/.ssh/id_rsa.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { ipcMain, shell, clipboard } = require('electron');
const { execFileP, ghExecP } = require('../util/exec');
const { pathUnder, pathUnderAnyRoot } = require('../util/path-gate');
const { worktreeWatchers, startWorktreeWatcher, stopWorktreeWatcher } = require('../state/watcher');
const { allowQaPaths, qaMediaUrl, protocolError } = require('../bootstrap/qa-media-protocol');

// Directories we never descend into during the plain-fs fallback. Mirrors
// the patterns used by the H3 watcher.
const WALK_IGNORE = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.turbo', 'target',
  '.DS_Store', '.venv', 'venv', '.tox', 'coverage',
]);
const WALK_FILE_CAP = 10000;

function walkDirectory(root) {
  const results = [];
  const stack = [''];
  while (stack.length && results.length < WALK_FILE_CAP) {
    const rel = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch { continue; }
    for (const ent of entries) {
      if (WALK_IGNORE.has(ent.name)) continue;
      const childRel = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        stack.push(childRel);
      } else if (ent.isFile()) {
        results.push(childRel);
        if (results.length >= WALK_FILE_CAP) break;
      }
    }
  }
  return results;
}

// Bulk-read many files in one IPC round-trip. Used by the Monaco file
// viewer to hydrate sibling TS/JS models for cross-file IntelliSense.
// Per-file size is capped to avoid shipping giant minified bundles; total
// file count is capped by the caller.
ipcMain.handle('read-files-bulk', async (_event, { worktreePath, relPaths, maxBytesPerFile }) => {
  const cap = maxBytesPerFile || 256 * 1024; // 256KB per file default
  const out = {};
  for (const rel of relPaths) {
    // Reject path traversal AND symlink escapes — every entry must resolve
    // under the real worktree path (a symlink pointing outside is refused).
    const safe = pathUnder(worktreePath, rel);
    if (!safe) continue;
    try {
      const stat = fs.lstatSync(safe);
      if (!stat.isFile() || stat.size > cap) continue;
      out[rel] = fs.readFileSync(safe, 'utf-8');
    } catch {}
  }
  return { files: out };
});

ipcMain.handle('list-files', async (_event, { worktreePath }) => {
  // Surface gitignored files (.env, pr-review.md, *.local, …) so users can
  // edit them from the file tree — matches what every editor does. Heavy
  // generated/dependency dirs are filtered at the git layer via pathspec
  // exclusions instead of `--exclude-standard`, so we don't enumerate
  // node_modules/ just to throw it away. Same WALK_IGNORE set the non-git
  // walker uses below, so the two code paths agree on what's hidden.
  const excludePathspecs = [];
  for (const dir of WALK_IGNORE) {
    excludePathspecs.push(`:(exclude,glob)**/${dir}`);
    excludePathspecs.push(`:(exclude,glob)**/${dir}/**`);
  }
  try {
    const args = ['ls-files', '--cached', '--others', '.', ...excludePathspecs];
    const { stdout } = await execFileP('git', args, {
      cwd: worktreePath, maxBuffer: 5 * 1024 * 1024,
    });
    return { files: stdout.split('\n').filter(Boolean) };
  } catch (err) {
    // Not a git repo (open-folder flow) — walk the directory directly.
    const msg = err.stderr ? err.stderr.toString() : err.message;
    if (/not a git repository/i.test(msg)) {
      try {
        return { files: walkDirectory(worktreePath) };
      } catch (walkErr) {
        return { files: [], error: walkErr.message };
      }
    }
    return { files: [], error: msg };
  }
});

function parseGrepOutput(output) {
  const results = [];
  output.split('\n').filter(Boolean).forEach(function (line) {
    const match = line.match(/^([^:]+):(\d+):(.*)$/);
    if (match) {
      results.push({ file: match[1], line: parseInt(match[2], 10), text: match[3] });
    }
  });
  return results.slice(0, 100);
}

ipcMain.handle('search-files', async (_event, { worktreePath, query, maxPerFile }) => {
  // Literal (fixed-string) search via -F. Matches what the I7 replace path
  // does under the hood (content.split(query)), so preview and replace are
  // guaranteed to see the same hits. If regex search is ever needed, it
  // should land as an explicit opt-in flag rather than the default — the
  // replace path can't honor it safely.
  const cap = '--max-count=' + (typeof maxPerFile === 'number' ? maxPerFile : 5);
  // Try git grep — respects .gitignore and is fast.
  try {
    // `--` is mandatory: without it, a `query` starting with `-` (or a
    // long flag git-grep recognizes) is parsed as an option rather than
    // the search pattern. `-F` alone doesn't fully defend against that.
    const args = ['grep', '-n', '--no-color', '-I', '-r', '-F', cap, '--', query];
    const { stdout: output } = await execFileP('git', args, {
      cwd: worktreePath, maxBuffer: 5 * 1024 * 1024, timeout: 10000,
    });
    return { results: parseGrepOutput(output) };
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString() : err.message;
    if (/not a git repository/i.test(msg)) {
      // fall through to plain-grep fallback
    } else if (err.code === 1) {
      // git grep exits 1 when nothing matched — same convention as plain grep.
      // util.promisify(execFile) exposes the exit code on err.code (not
      // err.status); the previous check never matched, so empty results
      // surfaced as a misleading error to the search panel.
      return { results: [] };
    } else {
      return { results: [], error: msg };
    }
  }
  // Non-git fallback — portable in-process search.
  try {
    const files = walkDirectory(worktreePath);
    const results = [];
    const capVal = typeof maxPerFile === 'number' ? maxPerFile : 5;
    for (const rel of files) {
      const abs = path.join(worktreePath, rel);
      let content;
      try {
        content = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      // Skip binary files (rough check for null byte, mirroring grep -I)
      if (content.includes('\0')) continue;

      const lines = content.split(/\r?\n/);
      let count = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes(query)) {
          results.push({ file: rel, line: i + 1, text: line });
          count++;
          if (count >= capVal) break;
        }
      }
    }
    return { results: results.slice(0, 100) };
  } catch (err) {
    return { results: [], error: err.message };
  }
});

// Replace-in-files (I7). Takes the same worktree + a list of file-relative
// paths plus a (literal) search string and replacement string. For each file
// we read, replaceAll, and write. Returns per-file counts so the caller can
// report "N replacements in M files".
//
// Intentionally literal-only: regex replace opens the door to capture-group
// surprises and destructive mistakes. If needed later we can add a flag.
ipcMain.handle('replace-in-files', async (_event, { worktreePath, relPaths, query, replacement }) => {
  if (!worktreePath || !Array.isArray(relPaths) || !query) {
    return { error: 'Missing required arguments' };
  }
  const perFile = [];
  let totalReplacements = 0;
  for (const rel of relPaths) {
    // pathUnder canonicalizes via realpath on both the root and the file,
    // so a symlink inside the worktree pointing out (e.g. -> /etc/passwd)
    // is refused — not just the lexical `..` traversal.
    const safe = pathUnder(worktreePath, rel);
    if (!safe) {
      perFile.push({ file: rel, error: 'Path escapes worktree' });
      continue;
    }
    try {
      const content = fs.readFileSync(safe, 'utf8');
      // Fast literal count via split; avoids needing to regex-escape the query.
      const parts = content.split(query);
      const count = parts.length - 1;
      if (count === 0) {
        perFile.push({ file: rel, replaced: 0 });
        continue;
      }
      const next = parts.join(replacement);
      fs.writeFileSync(safe, next);
      perFile.push({ file: rel, replaced: count });
      totalReplacements += count;
    } catch (err) {
      perFile.push({ file: rel, error: err.message });
    }
  }
  return { ok: true, totalReplacements, files: perFile };
});

// ---- Merge Conflict Resolution (Feature 1) ----

ipcMain.handle('read-conflict-file', async (_event, { worktreePath, file }) => {
  const safe = pathUnder(worktreePath, file);
  if (!safe) return { error: 'file outside worktree' };
  try {
    const content = fs.readFileSync(safe, 'utf-8');
    return { content };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('write-resolved-file', async (_event, { worktreePath, file, content }) => {
  const safe = pathUnder(worktreePath, file);
  if (!safe) return { error: 'file outside worktree' };
  try {
    fs.writeFileSync(safe, content, 'utf-8');
    // Use the original relative `file` arg for `git add` (git wants a repo-relative path).
    await execFileP('git', ['add', '--', file], { cwd: worktreePath });
    return { ok: true };
  } catch (err) {
    return { error: err.stderr ? err.stderr.toString() : err.message };
  }
});

// ---- .env File Viewer/Editor (Feature 12) ----

ipcMain.handle('list-env-files', async (_event, { worktreePath }) => {
  try {
    const entries = fs.readdirSync(worktreePath);
    const envFiles = entries.filter(f => /^\.env/.test(f) && fs.statSync(path.join(worktreePath, f)).isFile());
    return { files: envFiles };
  } catch (err) {
    return { files: [], error: err.message };
  }
});

ipcMain.handle('read-env-file', async (_event, { worktreePath, filename }) => {
  // Security: prevent path traversal
  if (filename.includes('/') || filename.includes('\\') || !filename.startsWith('.env')) {
    return { error: 'Invalid filename' };
  }
  try {
    const content = fs.readFileSync(path.join(worktreePath, filename), 'utf-8');
    return { content };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('write-env-file', async (_event, { worktreePath, filename, content }) => {
  // Security: prevent path traversal
  if (filename.includes('/') || filename.includes('\\') || !filename.startsWith('.env')) {
    return { error: 'Invalid filename' };
  }
  try {
    fs.writeFileSync(path.join(worktreePath, filename), content, 'utf-8');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Plan tab: locate a markdown doc at the worktree root and return its contents
// in one round-trip. The plan variant mirrors the discovery precedence of the
// ExitPlanMode CLI (main/state/precommit-hook.js → findPlanFile): a root .md
// file whose name contains the keyword. We prefer the conventional names so a
// repo with several matches resolves deterministically, then fall back to the
// shortest matching name. Root-only (the hook uses cwd), so there's no
// recursive walk and no path-traversal surface to gate.
const EXCLUDE_DOCS = new Set([
  'readme.md', 'claude.md', 'agents.md', 'gemini.md',
  'contributing.md', 'license.md', 'changelog.md', 'code_of_conduct.md', 'security.md'
]);

function findRootDoc(worktreePath, keywordRe, preferred, allowAnyNonBoilerplate = false) {
  let entries;
  try {
    entries = fs.readdirSync(worktreePath, { withFileTypes: true });
  } catch (err) {
    return { error: err.message };
  }
  let names = entries
    .filter((e) => e.isFile() && keywordRe.test(e.name) && /\.md$/i.test(e.name))
    .map((e) => e.name);

  if (names.length === 0 && allowAnyNonBoilerplate) {
    names = entries
      .filter((e) => e.isFile() && /\.md$/i.test(e.name) && !EXCLUDE_DOCS.has(e.name.toLowerCase()))
      .map((e) => e.name);
  }

  if (names.length === 0) return { error: 'not found' };
  const lower = names.map((n) => n.toLowerCase());
  let chosen = null;
  for (const p of preferred) {
    const i = lower.indexOf(p.toLowerCase());
    if (i !== -1) { chosen = names[i]; break; }
  }
  // Stable tiebreak when no conventional name matched: shortest, then
  // lexicographic.
  if (!chosen) {
    chosen = names.slice().sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  }
  try {
    const abs = path.join(worktreePath, chosen);
    return { name: chosen, path: abs, content: fs.readFileSync(abs, 'utf-8') };
  } catch (err) {
    return { error: err.message };
  }
}

const { listSessionNotes } = require('../state/session-context');
const { klaussySessionDir } = require('../util/git-repo');

async function findPlanDoc(worktreePath) {
  if (!worktreePath) return { error: 'no worktreePath' };
  let rootRes = findRootDoc(worktreePath, /plan/i, ['implementation_plan.md', 'plan.md']);
  if (!rootRes.error && rootRes.content) return rootRes;

  // Check child directories if worktreePath is a session root folder
  if (fs.existsSync(worktreePath)) {
    try {
      const entries = fs.readdirSync(worktreePath, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory() && !ent.name.startsWith('.') && ent.name !== 'node_modules') {
          const childRes = findRootDoc(path.join(worktreePath, ent.name), /plan/i, ['implementation_plan.md', 'plan.md']);
          if (!childRes.error && childRes.content) return childRes;
        }
      }
    } catch {}
  }

  try {
    const notes = listSessionNotes(worktreePath);
    for (const note of notes) {
      const meta = note.metadata || {};
      const tags = Array.isArray(meta.tags) ? meta.tags : [];
      const isPlan = tags.some((t) => /plan/i.test(t))
        || /plan/i.test(note.id || '')
        || /plan/i.test(note.filePath || '')
        || /plan/i.test(meta.title || '')
        || /^#+\s*(?:Plan|Implementation)/i.test(note.body || '');
      if (isPlan && (note.body || note.content)) {
        return {
          name: (meta.title || note.id || path.basename(note.filePath, '.md') || 'plan') + '.md',
          path: note.filePath,
          content: note.body || note.content || '',
        };
      }
    }
  } catch {}

  return rootRes;
}

const DESIGN_KEYWORD_RE = /(?:design|spec|architecture|rfc|palette|theme|requirement|ui[-_]|prompt|task|notes)/i;
const DESIGN_PREFERRED = [
  'design.md', 'design_doc.md', 'design-doc.md', 'design-spec.md', 'ui-design.md',
  'spec.md', 'specs.md', 'architecture.md', 'rfc.md', 'requirements.md'
];

async function findDesignDoc(worktreePath) {
  if (!worktreePath) return { error: 'no worktreePath' };
  let rootRes = findRootDoc(worktreePath, DESIGN_KEYWORD_RE, DESIGN_PREFERRED, true);
  if (!rootRes.error && rootRes.content) return rootRes;

  // Check child directories if worktreePath is a session root folder
  if (fs.existsSync(worktreePath)) {
    try {
      const entries = fs.readdirSync(worktreePath, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory() && !ent.name.startsWith('.') && ent.name !== 'node_modules') {
          const childRes = findRootDoc(path.join(worktreePath, ent.name), DESIGN_KEYWORD_RE, DESIGN_PREFERRED, true);
          if (!childRes.error && childRes.content) return childRes;
        }
      }
    } catch {}
  }

  try {
    const notes = listSessionNotes(worktreePath);
    for (const note of notes) {
      const meta = note.metadata || {};
      const tags = Array.isArray(meta.tags) ? meta.tags : [];
      const isDesign = tags.some((t) => /^(design|spec|architecture|rfc|task|ui)/i.test(t))
        || DESIGN_KEYWORD_RE.test(note.id || '')
        || DESIGN_KEYWORD_RE.test(note.filePath || '')
        || DESIGN_KEYWORD_RE.test(meta.title || '')
        || /^#+\s*(?:Design|Spec|Architecture)/i.test(note.body || '');
      if (isDesign && (note.body || note.content)) {
        return {
          name: (meta.title || note.id || path.basename(note.filePath, '.md') || 'design') + '.md',
          path: note.filePath,
          content: note.body || note.content || '',
        };
      }
    }
    // If no note specifically matched design tags but session notes exist, use the first non-plan note
    if (notes.length > 0) {
      const firstNote = notes[0];
      return {
        name: (firstNote.metadata?.title || firstNote.id || path.basename(firstNote.filePath, '.md') || 'note') + '.md',
        path: firstNote.filePath,
        content: firstNote.body || firstNote.content || '',
      };
    }
  } catch {}

  return rootRes;
}

ipcMain.handle('find-plan-file', async (_event, { worktreePath }) => findPlanDoc(worktreePath));
ipcMain.handle('find-design-file', async (_event, { worktreePath }) => findDesignDoc(worktreePath));

const QA_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp']);
const QA_VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.mkv']);

const QA_REL_DIRS = [
  'e2e-artifacts',
  'e2e-screenshots',
  'qa-artifacts',
  'qa-screenshots',
  'screenshots',
  'qa',
  'e2e/screenshots',
  'e2e/artifacts',
  'playwright-report/data',
  'playwright-report',
  'test-results',
  'cypress/screenshots',
  'cypress/videos',
  'tmp/screenshots',
  'tmp/qa',
  'tmp/e2e',
  'artifacts',
];

const QA_FILE_NAME_PATTERN = /(?:^|[\\/._-])(?:screenshot|screen-shot|screen_shot|qa[-_]|test[-_]shot|recording|proof)(?:[\\/._-]|$)/i;

const QA_IGNORE_DIRS_IN_WALK = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.turbo', 'target',
  '.DS_Store', '.venv', 'venv', '.tox', 'coverage',
  'src/assets', 'assets', 'public', 'static', 'images', 'img', 'styles', 'icons',
]);

// startsWith counts /repo-old as inside /repo, and Windows (plus a
// case-insensitive macOS volume) can hand back the same path in another case.
function isInside(parent, child) {
  const norm = (p) => {
    const abs = path.resolve(p);
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  };
  const rel = path.relative(norm(parent), norm(child));
  if (!rel || path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith('..' + path.sep);
}


// Where QA media for a worktree can legitimately live: Downloads (under several
// spellings of the branch), a tmp dir, or the repo's own folders. Shared with the
// scheme's authorization so both answer "is this this session's QA media" alike.
async function qaCandidateDirs(worktreePath) {
  const candidateDirs = new Set();

  let branch = '';
  let repoName = path.basename(worktreePath);
  const session = klaussySessionDir(worktreePath);
  if (session && session.name) {
    branch = session.name;
    if (session.repo) repoName = session.repo;
  }

  try {
    const { stdout: branchOut } = await execFileP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktreePath, maxBuffer: 1024 * 1024,
    });
    if (branchOut.trim()) branch = branchOut.trim();
  } catch {}

  // If worktree is a session folder without direct git, check child repo branches
  if (!branch && fs.existsSync(worktreePath)) {
    try {
      const entries = fs.readdirSync(worktreePath, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory() && !ent.name.startsWith('.') && ent.name !== 'node_modules') {
          const childPath = path.join(worktreePath, ent.name);
          try {
            const { stdout: childBranch } = await execFileP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
              cwd: childPath, maxBuffer: 1024 * 1024,
            });
            if (childBranch.trim()) {
              branch = childBranch.trim();
              repoName = ent.name;
              break;
            }
          } catch {}
        }
      }
    } catch {}
  }

  try {
    const { stdout: rootOut } = await execFileP('git', ['rev-parse', '--show-toplevel'], {
      cwd: worktreePath, maxBuffer: 1024 * 1024,
    });
    const rootPath = rootOut.trim();
    if (rootPath && (worktreePath === rootPath || worktreePath.startsWith(rootPath + path.sep))) {
      const rootName = path.basename(rootPath);
      if (rootName) repoName = rootName;
    }
  } catch {}

  // Agents save QA media to Downloads/klaussy-qa-<branch>, so probe every branch-name spelling.
  let downloadsDir;
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      downloadsDir = app.getPath('downloads');
    }
  } catch {}
  if (!downloadsDir) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
    downloadsDir = path.join(homeDir, 'Downloads');
  }
  if (fs.existsSync(downloadsDir)) {
    const branchCandidates = new Set();
    if (branch) branchCandidates.add(branch);
    if (session && session.name) branchCandidates.add(session.name);

    for (const bCandidate of branchCandidates) {
      const cleanBranch = bCandidate.replace(/\//g, '-');
      const safeBranch = bCandidate.replace(/[^a-zA-Z0-9._-]/g, '-');
      const strippedBranch = bCandidate.replace(/^(feat|fix|chore|docs|refactor|style|test)\//i, '');
      const cleanStripped = strippedBranch.replace(/\//g, '-');
      const safeStripped = strippedBranch.replace(/[^a-zA-Z0-9._-]/g, '-');

      const branchTokens = [bCandidate, cleanBranch, safeBranch, strippedBranch, cleanStripped, safeStripped];
      for (const b of branchTokens) {
        if (!b) continue;
        candidateDirs.add(path.join(downloadsDir, `klaussy-qa-${b}`));
        candidateDirs.add(path.join(downloadsDir, `klauss-qa-${b}`));
        if (repoName) {
          candidateDirs.add(path.join(downloadsDir, `${repoName}-${b}`));
          candidateDirs.add(path.join(downloadsDir, `klaussy-qa-${repoName}-${b}`));
        }
      }
    }
  }

  const tmpDir = os.tmpdir();
  if (branch && fs.existsSync(tmpDir)) {
    const safeBranch = branch.replace(/[^a-zA-Z0-9._-]/g, '-');
    for (const sDir of [
      path.join(tmpDir, `klaussy-qa-${repoName}-${safeBranch}`),
      path.join(tmpDir, `${repoName}-${safeBranch}-qa`),
    ]) {
      if (fs.existsSync(sDir)) {
        candidateDirs.add(sDir);
      }
    }
  }

  for (const qDir of QA_REL_DIRS) {
    const absQDir = path.join(worktreePath, qDir);
    if (fs.existsSync(absQDir)) {
      candidateDirs.add(absQDir);
    }
  }
  return candidateDirs;
}

async function findQaMediaFiles(worktreePath, meta = {}) {
  if (!worktreePath) return [];

  const foundFiles = new Map();
  const candidateDirs = await qaCandidateDirs(worktreePath);

  // Media in a shared folder like Downloads must also be newer than the branch
  // start, or a re-used branch name resurrects the previous run's screenshots.
  // We use a 12-hour grace period before the branch's first commit so that
  // "before" screenshots taken before the first commit are preserved.
  let branchStartMs = 0;
  for (const baseRef of ['origin/HEAD', 'origin/main', 'main', 'origin/master', 'master']) {
    try {
      // No --max-count: git limits before it reverses, so it would hand back
      // the branch's newest commit instead of its first.
      const { stdout } = await execFileP(
        'git',
        ['log', '--reverse', '--format=%ct', `${baseRef}..HEAD`],
        { cwd: worktreePath, maxBuffer: 1024 * 1024 },
      );
      const secs = parseInt(stdout.trim().split('\n')[0], 10);
      if (secs) {
        branchStartMs = Math.max(0, (secs * 1000) - (12 * 60 * 60 * 1000));
        break;
      }
    } catch {}
  }
  // A branch with no commits of its own yet still has a session behind it.
  if (!branchStartMs) {
    try {
      const birth = fs.statSync(worktreePath).birthtimeMs || 0;
      if (birth) branchStartMs = Math.max(0, birth - (12 * 60 * 60 * 1000));
    } catch {}
  }
  meta.branchStartUnknown = !branchStartMs;

  function scanDirectory(dirPath, maxDepth = 3) {
    if (!fs.existsSync(dirPath)) return;
    const stack = [{ p: dirPath, depth: 0 }];
    while (stack.length) {
      const item = stack.pop();
      const curDir = item.p;
      const depth = item.depth;
      let entries;
      try {
        entries = fs.readdirSync(curDir, { withFileTypes: true });
      } catch { continue; }

      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        const absChild = path.join(curDir, ent.name);
        if (ent.isDirectory()) {
          if (depth < maxDepth && !QA_IGNORE_DIRS_IN_WALK.has(ent.name)) {
            stack.push({ p: absChild, depth: depth + 1 });
          }
        } else if (ent.isFile()) {
          const ext = path.extname(ent.name).toLowerCase();
          let type = null;
          if (QA_VIDEO_EXTS.has(ext)) type = 'video';
          else if (QA_IMAGE_EXTS.has(ext)) type = 'image';

          if (type) {
            try {
              const stat = fs.statSync(absChild);
              const inWorktree = isInside(worktreePath, absChild);
              if (!inWorktree && branchStartMs && stat.mtimeMs < branchStartMs) continue;
              const rel = inWorktree
                ? path.relative(worktreePath, absChild)
                : path.relative(dirPath, absChild);
              foundFiles.set(absChild, {
                name: ent.name,
                path: absChild,
                relPath: rel,
                type: type,
                mtimeMs: stat.mtimeMs,
                size: stat.size,
              });
            } catch {}
          }
        }
      }
    }
  }

  for (const cDir of candidateDirs) {
    scanDirectory(cDir);
  }

  // Loose shots in the worktree root: name pattern only, so repo artwork isn't picked up.
  try {
    const rootEntries = fs.readdirSync(worktreePath, { withFileTypes: true });
    for (const ent of rootEntries) {
      if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        let type = null;
        if (QA_VIDEO_EXTS.has(ext)) type = 'video';
        else if (QA_IMAGE_EXTS.has(ext)) type = 'image';

        if (type && QA_FILE_NAME_PATTERN.test(ent.name)) {
          const absChild = path.join(worktreePath, ent.name);
          try {
            const stat = fs.statSync(absChild);
            foundFiles.set(absChild, {
              name: ent.name,
              path: absChild,
              relPath: ent.name,
              type: type,
              mtimeMs: stat.mtimeMs,
              size: stat.size,
            });
          } catch {}
        }
      }
    }
  } catch {}

  const results = Array.from(foundFiles.values());
  results.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  return results;
}

// Phase 3 (local review) and Phase 6 (re-review) leave nothing on disk, so the
// floor steps over them; the terminal parser fills those in.
function phaseFromEvidence(ev) {
  let phase = 1;
  const atLeast = (n) => { if (n > phase) phase = n; };

  if (ev.hasPlan) atLeast(2);
  if (ev.commits > 0) atLeast(2);
  if (ev.qaMedia > 0) atLeast(4);
  if (ev.prNumber) atLeast(6);
  if (ev.checksTotal > 0) atLeast(7);
  if (ev.reviewThreads > 0) atLeast(8);
  if (ev.checksTotal > 0 && ev.checksPassed === ev.checksTotal) atLeast(9);

  return phase;
}

async function devLoopEvidence(worktreePath) {
  const ev = {
    hasPlan: false, commits: 0, qaMedia: 0,
    prNumber: null, prUrl: null,
    checksTotal: 0, checksPassed: 0, checksFailed: 0,
    reviewThreads: 0,
    qaMediaError: null, prError: null, commitsError: null,
  };
  if (!worktreePath) return ev;

  for (const name of ['plan.md', 'docs/plan.md', 'design.md', 'docs/design.md']) {
    if (fs.existsSync(path.join(worktreePath, name))) { ev.hasPlan = true; break; }
  }

  // If no base ref resolves we cannot tell "no commits yet" from "cannot read
  // this repo", and the floor would sit at Phase 1 either way.
  let baseRefFound = false;
  let lastBaseErr = '';
  for (const baseRef of ['origin/HEAD', 'origin/main', 'main', 'origin/master', 'master']) {
    try {
      const { stdout } = await execFileP('git', ['rev-list', '--count', `${baseRef}..HEAD`], {
        cwd: worktreePath, maxBuffer: 1024 * 1024,
      });
      const n = parseInt(stdout.trim(), 10);
      if (Number.isFinite(n)) { ev.commits = n; baseRefFound = true; break; }
    } catch (err) {
      lastBaseErr = String((err && err.stderr) || (err && err.message) || '').trim().split('\n')[0];
    }
  }
  if (!baseRefFound) {
    ev.commitsError = lastBaseErr || 'could not determine a base branch';
  }

  // A failed scan and an empty one both leave qaMedia at 0, so say which.
  try {
    ev.qaMedia = (await findQaMediaFiles(worktreePath)).length;
  } catch (err) {
    ev.qaMediaError = err.message;
  }

  // "No PR yet" is the normal early state; anything else (auth drift, network,
  // timeout) would otherwise pin the HUD below Phase 6 with nothing said.
  try {
    const { stdout } = await ghExecP(
      ['pr', 'view', '--json', 'number,url,statusCheckRollup,reviews'],
      { cwd: worktreePath, timeout: 10000 },
    );
    const pr = JSON.parse(stdout);
    if (pr && pr.number) {
      ev.prNumber = pr.number;
      ev.prUrl = pr.url || null;
      const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
      ev.checksTotal = checks.length;
      ev.checksPassed = checks.filter((c) => c.conclusion === 'SUCCESS').length;
      ev.checksFailed = checks.filter((c) => c.conclusion === 'FAILURE' || c.conclusion === 'TIMED_OUT').length;
      ev.reviewThreads = Array.isArray(pr.reviews) ? pr.reviews.length : 0;
    }
  } catch (err) {
    const stderr = String((err && err.stderr) || (err && err.message) || '');
    if (!/no (?:open )?pull requests? found/i.test(stderr)) {
      ev.prError = stderr.trim().split('\n')[0] || 'gh pr view failed';
    }
  }

  return ev;
}

ipcMain.handle('dev-loop-evidence', async (_event, { worktreePath }) => {
  try {
    const evidence = await devLoopEvidence(worktreePath);
    return { evidence, phase: phaseFromEvidence(evidence) };
  } catch (err) {
    return { evidence: null, phase: 0, error: err.message };
  }
});

// An agent names its screenshots however it likes in its output, often bare or
// relative, so a candidate is tried against each place its media can live.
function resolveUnderRoots(candidate, roots) {
  const absolute = path.isAbsolute(candidate);
  for (const root of roots) {
    const abs = absolute ? path.resolve(candidate) : path.resolve(root, candidate);
    if (!isInside(root, abs)) continue;
    try {
      if (fs.statSync(abs).isFile()) return abs;
    } catch { /* not here */ }
  }
  return null;
}

// Vetted here because an allow-list the renderer can write would hand a
// renderer-side XSS arbitrary local file reads.
ipcMain.handle('authorize-qa-media', async (_event, { worktreePath, paths } = {}) => {
  if (!worktreePath || !Array.isArray(paths) || !paths.length) return { urls: {} };
  try {
    const roots = [worktreePath, ...(await qaCandidateDirs(worktreePath))];
    const urls = {};
    for (const candidate of paths) {
      if (typeof candidate !== 'string' || !candidate) continue;
      const ext = path.extname(candidate).toLowerCase();
      if (!QA_IMAGE_EXTS.has(ext) && !QA_VIDEO_EXTS.has(ext)) continue;
      const abs = resolveUnderRoots(candidate, roots);
      if (!abs) continue;
      allowQaPaths([abs]);
      urls[candidate] = qaMediaUrl(abs);
    }
    return { urls };
  } catch (err) {
    return { urls: {}, error: err.message };
  }
});

ipcMain.handle('find-qa-media', async (_event, { worktreePath }) => {
  if (!worktreePath) return { media: [] };
  try {
    const meta = {};
    const media = await findQaMediaFiles(worktreePath, meta);
    allowQaPaths(media.map((m) => m.path));
    for (const m of media) m.url = qaMediaUrl(m.path);
    const protoErr = protocolError();
    if (protoErr) return { media, error: 'QA media cannot be displayed: ' + protoErr };
    if (meta.branchStartUnknown) {
      return { media, warning: 'This list may include older runs: the branch start could not be determined.' };
    }
    return { media };
  } catch (err) {
    return { media: [], error: err.message };
  }
});

// ---- H3: Worktree file watcher for instant diff refresh ----

ipcMain.handle('watch-worktree', (event, { worktreePath }) => {
  if (!worktreePath) return { error: 'no worktreePath' };
  const state = startWorktreeWatcher(worktreePath);
  if (!state) return { error: 'watcher failed to start' };
  const count = state.subscribers.get(event.sender) || 0;
  state.subscribers.set(event.sender, count + 1);
  // Auto-cleanup when the renderer is destroyed (window closed, reload, etc.).
  // Only registered on the first subscription from this sender — refcount
  // increments don't re-register the destroyed listener.
  if (count === 0) {
    const cleanup = () => {
      const s = worktreeWatchers.get(worktreePath);
      if (!s) return;
      s.subscribers.delete(event.sender);
      if (s.subscribers.size === 0) stopWorktreeWatcher(worktreePath);
    };
    event.sender.once('destroyed', cleanup);
  }
  return { ok: true };
});

ipcMain.handle('unwatch-worktree', (event, { worktreePath }) => {
  if (!worktreePath) return { ok: true };
  const state = worktreeWatchers.get(worktreePath);
  if (!state) return { ok: true };
  const count = state.subscribers.get(event.sender) || 0;
  if (count <= 1) state.subscribers.delete(event.sender);
  else state.subscribers.set(event.sender, count - 1);
  if (state.subscribers.size === 0) stopWorktreeWatcher(worktreePath);
  return { ok: true };
});

// ---- Phase 7: File Viewer ----

ipcMain.handle('read-file', async (_event, { filePath }) => {
  const safe = pathUnderAnyRoot(filePath);
  if (!safe) return { error: 'path not under an allowed project root' };
  try {
    const content = fs.readFileSync(safe, 'utf-8');
    // mtimeMs lets the renderer stamp the buffer for external-mod detection
    // without a follow-up stat call.
    let mtimeMs = null;
    try { mtimeMs = fs.statSync(safe).mtimeMs; } catch {}
    return { content, ext: path.extname(safe).slice(1), mtimeMs };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('write-file', async (_event, { filePath, content }) => {
  const safe = pathUnderAnyRoot(filePath);
  if (!safe) return { error: 'path not under an allowed project root' };
  try {
    fs.writeFileSync(safe, content, 'utf-8');
    let mtimeMs = null;
    try { mtimeMs = fs.statSync(safe).mtimeMs; } catch {}
    return { ok: true, mtimeMs };
  } catch (err) {
    return { error: err.message };
  }
});

// ---- File tree mutations: create / rename / delete / stat / reveal / copy ----
//
// Every mutating handler resolves the target through pathUnder so the renderer
// can't escape the worktree. Create/rename also gate the *destination* parent
// dir, so a malicious payload can't pass `..` segments to land outside the
// worktree even if the basename looks innocent.

// Stat is read-only but deliberately separate from read-file because the
// caller (external-mod detection) only needs mtime + size, not the content.
ipcMain.handle('stat-file', async (_event, { filePath }) => {
  const safe = pathUnderAnyRoot(filePath);
  if (!safe) return { error: 'path not under an allowed project root' };
  try {
    const st = fs.statSync(safe);
    return { ok: true, mtimeMs: st.mtimeMs, size: st.size, isFile: st.isFile(), isDirectory: st.isDirectory() };
  } catch (err) {
    return { error: err.message };
  }
});

// Create a new empty file. Refuses to overwrite. The renderer is expected to
// handle "name already exists" by re-prompting; we don't want a silent clobber.
ipcMain.handle('create-file', async (_event, { worktreePath, relPath }) => {
  if (!worktreePath || !relPath) return { error: 'missing args' };
  const safe = pathUnder(worktreePath, relPath);
  if (!safe) return { error: 'path escapes worktree' };
  try {
    if (fs.existsSync(safe)) return { error: 'a file or folder with that name already exists' };
    fs.mkdirSync(path.dirname(safe), { recursive: true });
    fs.writeFileSync(safe, '', { flag: 'wx' });
    return { ok: true, path: safe };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('create-dir', async (_event, { worktreePath, relPath }) => {
  if (!worktreePath || !relPath) return { error: 'missing args' };
  const safe = pathUnder(worktreePath, relPath);
  if (!safe) return { error: 'path escapes worktree' };
  try {
    if (fs.existsSync(safe)) return { error: 'a file or folder with that name already exists' };
    fs.mkdirSync(safe, { recursive: false });
    return { ok: true, path: safe };
  } catch (err) {
    return { error: err.message };
  }
});

// Rename / move within a worktree. fromRel and toRel are both worktree-relative.
// Used by both the rename action and drag-and-drop move (move is just a rename
// with a different parent dir).
ipcMain.handle('rename-path', async (_event, { worktreePath, fromRel, toRel }) => {
  if (!worktreePath || !fromRel || !toRel) return { error: 'missing args' };
  const fromSafe = pathUnder(worktreePath, fromRel);
  const toSafe = pathUnder(worktreePath, toRel);
  if (!fromSafe || !toSafe) return { error: 'path escapes worktree' };
  if (fromSafe === toSafe) return { ok: true, path: toSafe };
  try {
    if (!fs.existsSync(fromSafe)) return { error: 'source does not exist' };
    if (fs.existsSync(toSafe)) return { error: 'destination already exists' };
    fs.mkdirSync(path.dirname(toSafe), { recursive: true });
    fs.renameSync(fromSafe, toSafe);
    return { ok: true, path: toSafe };
  } catch (err) {
    return { error: err.message };
  }
});

// Delete file or directory. Routes through shell.trashItem so the user can
// recover from Finder's Trash — `rm -rf` from a UI button is unforgiving.
// Falls back to fs.rmSync only if trashItem fails (e.g. on a volume Finder
// can't trash to), and only after explicit caller opt-in via `permanent: true`.
ipcMain.handle('delete-path', async (_event, { worktreePath, relPath, permanent }) => {
  if (!worktreePath || !relPath) return { error: 'missing args' };
  const safe = pathUnder(worktreePath, relPath);
  if (!safe) return { error: 'path escapes worktree' };
  // Refuse to delete the worktree root itself — almost certainly a bug, and
  // the consequences (blowing away the user's repo) are catastrophic.
  try {
    const rootReal = fs.realpathSync(worktreePath);
    if (safe === rootReal) return { error: 'refusing to delete worktree root' };
  } catch {}
  try {
    if (!fs.existsSync(safe)) return { error: 'path does not exist' };
    if (permanent) {
      fs.rmSync(safe, { recursive: true, force: true });
    } else {
      await shell.trashItem(safe);
    }
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Reveal in Finder. shell.showItemInFolder selects the item in its containing
// folder window — matches macOS users' expectations for "Reveal in Finder".
ipcMain.handle('reveal-in-folder', async (_event, { filePath }) => {
  const safe = pathUnderAnyRoot(filePath);
  if (!safe) return { error: 'path not under an allowed project root' };
  try {
    shell.showItemInFolder(safe);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Copy text to the system clipboard from main. The renderer has
// navigator.clipboard for ad-hoc cases, but routing path copies through main
// keeps the tree's right-click menu uniform with the rest of the IPC surface
// and avoids any focus-related clipboard quirks in nested DOM events.
ipcMain.handle('clipboard-write-text', async (_event, { text }) => {
  try {
    clipboard.writeText(String(text == null ? '' : text));
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

module.exports = {
  findQaMediaFiles,
  qaCandidateDirs,
  resolveUnderRoots,
  isInside,
  devLoopEvidence,
  phaseFromEvidence,
  findRootDoc,
  findPlanDoc,
  findDesignDoc,
};


