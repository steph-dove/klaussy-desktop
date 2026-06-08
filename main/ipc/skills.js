// Skills, slash commands, CLAUDE.md memory files, MCP servers, and plugins.
// Everything lives under ~/.claude (user scope) or <project>/.claude (project
// scope); list-* reads across both, create-* writes to the chosen scope.

const path = require('path');
const fs = require('fs');
const { ipcMain, shell } = require('electron');
const { loadConfig } = require('../util/config');
const { currentRepoPath } = require('../state/pr-review');
const { pathUnder, pathUnderAnyRoot } = require('../util/path-gate');

// Enumerate installed plugins from ~/.claude/plugins/installed_plugins.json.
// Plugins no longer live at ~/.claude/plugins/<name>/ — Claude Code now keeps
// them under ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/ and
// records the real install path (plus marketplace) in installed_plugins.json.
// Each returned entry carries everything callers need: the install dir, the
// bare plugin name (for `/<plugin>:<cmd>` namespacing the CLI expects) and the
// marketplace it came from.
function listInstalledPlugins() {
  const homedir = require('os').homedir();
  const manifest = path.join(homedir, '.claude', 'plugins', 'installed_plugins.json');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(manifest, 'utf8')); } catch (_) { return []; }
  const out = [];
  const seen = new Set();
  for (const [key, installs] of Object.entries((raw && raw.plugins) || {})) {
    // key is "<plugin>@<marketplace>".
    const at = key.lastIndexOf('@');
    const pluginName = at > 0 ? key.slice(0, at) : key;
    const marketplace = at > 0 ? key.slice(at + 1) : '';
    if (!Array.isArray(installs)) continue;
    for (const inst of installs) {
      const dir = inst && inst.installPath;
      if (!dir || seen.has(dir) || !fs.existsSync(dir)) continue;
      seen.add(dir);
      out.push({
        pluginName,
        marketplace,
        scope: inst.scope || 'user',
        version: inst.version || '',
        dir,
      });
    }
  }
  return out;
}

// List Claude skills + slash commands from disk so users can discover what
// they have installed without leaving Klaussy. Walks user-level skills + a
// source per klausify project (most users keep skills per-repo, so showing
// just the active project would hide most of what they have).
ipcMain.handle('list-skills', async () => {
  const homedir = require('os').homedir();
  const sources = [
    { kind: 'user', label: 'user', skillsDir: path.join(homedir, '.claude', 'skills'), cmdsDir: path.join(homedir, '.claude', 'commands') },
  ];
  const config = loadConfig();
  const projects = config.projects || [];
  for (const p of projects) {
    if (!p || !p.path) continue;
    sources.push({
      kind: 'project',
      label: p.name || path.basename(p.path),
      skillsDir: path.join(p.path, '.claude', 'skills'),
      cmdsDir: path.join(p.path, '.claude', 'commands'),
    });
  }
  // Belt-and-suspenders: include the currently-active repo even if it
  // isn't in config.projects (rare, but happens during transient setup).
  const active = currentRepoPath();
  if (active && !projects.find((p) => p && p.path === active)) {
    sources.push({
      kind: 'project',
      label: path.basename(active),
      skillsDir: path.join(active, '.claude', 'skills'),
      cmdsDir: path.join(active, '.claude', 'commands'),
    });
  }
  // Plugins: this is where most installed skills/commands actually live.
  // `pluginName` is carried through so commands can be namespaced the way the
  // CLI expects them to be typed: `/<plugin>:<command>`.
  for (const pl of listInstalledPlugins()) {
    sources.push({
      kind: 'plugin',
      label: pl.pluginName,
      pluginName: pl.pluginName,
      skillsDir: path.join(pl.dir, 'skills'),
      cmdsDir: path.join(pl.dir, 'commands'),
    });
  }

  function parseFrontmatter(text) {
    if (!text) return { name: '', description: '' };
    const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!m) return { name: '', description: '' };
    const out = {};
    m[1].split('\n').forEach((line) => {
      const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
      if (!kv) return;
      let val = kv[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[kv[1]] = val;
    });
    return out;
  }

  const skills = [];
  const commands = [];

  for (const src of sources) {
    // Skills: each subdirectory of skillsDir is a skill; SKILL.md inside.
    try {
      const entries = fs.readdirSync(src.skillsDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const skillFile = path.join(src.skillsDir, ent.name, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;
        const text = fs.readFileSync(skillFile, 'utf8');
        const fm = parseFrontmatter(text);
        const base = fm.name || ent.name;
        skills.push({
          name: src.pluginName ? src.pluginName + ':' + base : base,
          description: fm.description || '',
          source: src.label,
          kind: src.kind,
          // What the user types to invoke it in a Claude terminal.
          insert: '/' + (src.pluginName ? src.pluginName + ':' + base : base),
          path: skillFile,
        });
      }
    } catch (_) { /* dir doesn't exist — fine */ }

    // Slash commands: <name>.md files in commands dir.
    try {
      const entries = fs.readdirSync(src.cmdsDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
        const file = path.join(src.cmdsDir, ent.name);
        const text = fs.readFileSync(file, 'utf8');
        const fm = parseFrontmatter(text);
        // Body after frontmatter for a fallback description.
        let body = text.replace(/^---[\s\S]*?\n---\s*/, '').trim();
        const cmdBase = ent.name.replace(/\.md$/, '');
        // Plugin commands are namespaced `/<plugin>:<command>` by the CLI;
        // user/project commands are just `/<command>`.
        const slash = '/' + (src.pluginName ? src.pluginName + ':' + cmdBase : cmdBase);
        commands.push({
          name: slash,
          description: fm.description || body.split('\n')[0].slice(0, 160),
          source: src.label,
          kind: src.kind,
          insert: slash,
          path: file,
        });
      }
    } catch (_) {}
  }

  // Sort: user → plugin → project, then alphabetically by source label, then
  // by name within each source.
  const rank = (k) => (k === 'user' ? 0 : k === 'plugin' ? 1 : 2);
  const sorter = (a, b) => {
    const ra = rank(a.kind), rb = rank(b.kind);
    if (ra !== rb) return ra - rb;
    if (a.source !== b.source) return String(a.source).localeCompare(String(b.source));
    return a.name.localeCompare(b.name);
  };
  skills.sort(sorter);
  commands.sort(sorter);
  return { skills, commands };
});

// Skill/command files live under ~/.claude (user + plugin cache) OR under a
// project root (project-scope .claude/skills). Allow either; reject anything
// else so a compromised renderer can't read arbitrary files through here.
function safeSkillPath(filePath) {
  const claudeHome = path.join(require('os').homedir(), '.claude');
  return pathUnder(claudeHome, filePath) || pathUnderAnyRoot(filePath);
}

ipcMain.handle('open-skill-file', (_event, { filePath }) => {
  if (!filePath) return { ok: false };
  const safe = safeSkillPath(filePath);
  if (!safe) return { error: 'path outside ~/.claude or an allowed project root' };
  shell.openPath(safe);
  return { ok: true };
});

ipcMain.handle('read-skill-file', (_event, { filePath }) => {
  if (!filePath) return { error: 'No file path' };
  const safe = safeSkillPath(filePath);
  if (!safe) return { error: 'path outside ~/.claude or an allowed project root' };
  try {
    const content = fs.readFileSync(safe, 'utf8');
    return { content };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('write-skill-file', (_event, { filePath, content }) => {
  if (!filePath) return { error: 'No file path' };
  if (typeof content !== 'string') return { error: 'Content must be a string' };
  const safe = safeSkillPath(filePath);
  if (!safe) return { error: 'path outside ~/.claude or an allowed project root' };
  try {
    fs.writeFileSync(safe, content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// List CLAUDE.md memory files across scopes. Each scope has at most one
// memory file — the dialog uses this to show what's there vs. missing.
ipcMain.handle('list-memory-files', () => {
  const homedir = require('os').homedir();
  const out = [];
  const scopes = [
    { kind: 'user', label: 'user', file: path.join(homedir, '.claude', 'CLAUDE.md') },
  ];
  const config = loadConfig();
  const projects = config.projects || [];
  for (const p of projects) {
    if (!p || !p.path) continue;
    // Project root is the canonical location; fall back to .claude/CLAUDE.md
    // if the user keeps it there instead.
    const rootFile = path.join(p.path, 'CLAUDE.md');
    const dotFile = path.join(p.path, '.claude', 'CLAUDE.md');
    const file = fs.existsSync(rootFile) ? rootFile : (fs.existsSync(dotFile) ? dotFile : rootFile);
    scopes.push({ kind: 'project', label: p.name || path.basename(p.path), file });
  }
  // Include the active repo even if it isn't in config.projects (parity with
  // list-skills) so its CLAUDE.md is reachable during transient setup.
  const activeRepo = currentRepoPath();
  if (activeRepo && !projects.find((p) => p && p.path === activeRepo)) {
    const rootFile = path.join(activeRepo, 'CLAUDE.md');
    const dotFile = path.join(activeRepo, '.claude', 'CLAUDE.md');
    const file = fs.existsSync(rootFile) ? rootFile : (fs.existsSync(dotFile) ? dotFile : rootFile);
    scopes.push({ kind: 'project', label: path.basename(activeRepo), file });
  }
  for (const s of scopes) {
    out.push({
      scope: s.label,
      kind: s.kind,
      path: s.file,
      exists: fs.existsSync(s.file),
    });
  }
  return { entries: out };
});

// MCP server inventory. Reads user + project mcp configs from the canonical
// locations claude looks at. Returns each entry's name, command, args, env
// vars (keys only — never values) so the dialog can render a status table.
ipcMain.handle('list-mcp-servers', () => {
  const homedir = require('os').homedir();
  const sources = [
    { kind: 'user', label: 'user', files: [
      path.join(homedir, '.claude.json'),
      path.join(homedir, '.claude', 'mcp.json'),
    ] },
  ];
  const config = loadConfig();
  const projects = config.projects || [];
  for (const p of projects) {
    if (!p || !p.path) continue;
    sources.push({
      kind: 'project',
      label: p.name || path.basename(p.path),
      files: [
        path.join(p.path, '.mcp.json'),
        path.join(p.path, '.claude', 'mcp.json'),
      ],
    });
  }
  const servers = [];
  for (const src of sources) {
    for (const file of src.files) {
      if (!fs.existsSync(file)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const map = (raw && raw.mcpServers) || {};
        for (const [name, def] of Object.entries(map)) {
          if (!def || typeof def !== 'object') continue;
          servers.push({
            name,
            source: src.label,
            sourceKind: src.kind,
            sourceFile: file,
            command: def.command || '',
            args: Array.isArray(def.args) ? def.args : [],
            envKeys: def.env && typeof def.env === 'object' ? Object.keys(def.env) : [],
            type: def.type || 'stdio',
          });
        }
      } catch (_) { /* malformed config — skip silently */ }
    }
  }
  servers.sort((a, b) => {
    if (a.sourceKind === 'user' && b.sourceKind !== 'user') return -1;
    if (b.sourceKind === 'user' && a.sourceKind !== 'user') return 1;
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    return a.name.localeCompare(b.name);
  });
  return { servers };
});

// Plugin inventory. Plugins live under ~/.claude/plugins/<name>/ — we read
// each plugin's plugin.json (or package.json fallback) to get name +
// description + what it bundles (skills/commands/agents).
ipcMain.handle('list-plugins', () => {
  const out = [];
  for (const pl of listInstalledPlugins()) {
    const pluginDir = pl.dir;
    // The manifest now lives at <plugin>/.claude-plugin/plugin.json; keep the
    // old fallbacks for older / hand-rolled plugins.
    let manifest = {};
    const candidates = [
      path.join(pluginDir, '.claude-plugin', 'plugin.json'),
      path.join(pluginDir, 'plugin.json'),
      path.join(pluginDir, 'package.json'),
      path.join(pluginDir, 'manifest.json'),
    ];
    for (const f of candidates) {
      if (!fs.existsSync(f)) continue;
      try { manifest = JSON.parse(fs.readFileSync(f, 'utf8')); break; } catch (_) {}
    }
    // Rough inventory of what the plugin bundles.
    const bundles = [];
    for (const sub of ['skills', 'commands', 'agents', 'hooks']) {
      const d = path.join(pluginDir, sub);
      try {
        const items = fs.readdirSync(d).filter((f) => !f.startsWith('.'));
        if (items.length > 0) bundles.push(sub + ' (' + items.length + ')');
      } catch (_) {}
    }
    out.push({
      name: manifest.name || pl.pluginName,
      description: manifest.description || '',
      version: manifest.version || pl.version || '',
      marketplace: pl.marketplace || '',
      scope: pl.scope || 'user',
      author: typeof manifest.author === 'string' ? manifest.author : (manifest.author && manifest.author.name) || '',
      path: pluginDir,
      bundles,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { plugins: out };
});

ipcMain.handle('create-memory-file', (_event, { filePath }) => {
  if (!filePath) return { error: 'No file path' };
  // Memory files live either under ~/.claude or under an active project root.
  const claudeHome = path.join(require('os').homedir(), '.claude');
  const safe = pathUnder(claudeHome, filePath) || pathUnderAnyRoot(filePath);
  if (!safe) return { error: 'path not under ~/.claude or an allowed project root' };
  if (fs.existsSync(safe)) return { error: 'File already exists.' };
  const dir = path.dirname(safe);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const starter = '# Project memory\n\n'
      + 'Notes Claude should keep in mind for this scope. Examples:\n\n'
      + '- Coding conventions to follow.\n'
      + '- Files / folders to ignore.\n'
      + '- Domain terminology that may otherwise be ambiguous.\n';
    fs.writeFileSync(safe, starter, 'utf8');
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// Create a new skill or slash-command in the chosen scope. Writes a starter
// file with frontmatter so the user has somewhere to start instead of an
// empty doc; the dialog opens it for editing immediately.
ipcMain.handle('create-skill-file', (_event, { type, scope, name }) => {
  if (type !== 'skill' && type !== 'command') return { error: 'Unknown type: ' + type };
  if (!name || !/^[a-zA-Z0-9_-][a-zA-Z0-9_-]*$/.test(name)) {
    return { error: 'Name must contain only letters, numbers, dashes, and underscores.' };
  }
  // Resolve the scope's .claude root.
  let root;
  if (scope === 'user') {
    root = path.join(require('os').homedir(), '.claude');
  } else {
    // scope is the absolute project path.
    if (!scope || !fs.existsSync(scope)) return { error: 'Invalid project scope: ' + scope };
    root = path.join(scope, '.claude');
  }

  let filePath, starter;
  if (type === 'skill') {
    const skillDir = path.join(root, 'skills', name);
    filePath = path.join(skillDir, 'SKILL.md');
    if (fs.existsSync(filePath)) return { error: 'A skill named "' + name + '" already exists in this scope.' };
    try { fs.mkdirSync(skillDir, { recursive: true }); }
    catch (err) { return { error: 'Could not create skill dir: ' + err.message }; }
    starter = '---\n'
      + 'name: ' + name + '\n'
      + 'description: One-line description used by Claude to decide when to apply this skill.\n'
      + '---\n\n'
      + '# ' + name + '\n\n'
      + 'Describe what this skill does, when to use it, and any guardrails.\n';
  } else {
    const cmdsDir = path.join(root, 'commands');
    filePath = path.join(cmdsDir, name + '.md');
    if (fs.existsSync(filePath)) return { error: 'A slash command named "' + name + '" already exists in this scope.' };
    try { fs.mkdirSync(cmdsDir, { recursive: true }); }
    catch (err) { return { error: 'Could not create commands dir: ' + err.message }; }
    starter = '---\n'
      + 'description: One-line description shown when the user types /\n'
      + '---\n\n'
      + 'Instructions Claude should follow when /' + name + ' is invoked.\n';
  }

  try {
    fs.writeFileSync(filePath, starter, 'utf8');
    return { path: filePath, name: name, type: type };
  } catch (err) {
    return { error: 'Could not write file: ' + err.message };
  }
});
