// Opt-in Bash grant for kimi's autonomous surfaces. It approves Write/Edit in a
// worktree itself but never Bash, and offers no project config, no `-p`-compatible
// flag and no env var — so the only lever is the global ~/.kimi-code/config.toml.

// Marker-fenced so we only ever add or remove our own block, never a user rule.
// Shape follows kimi 0.29.1's PermissionRuleSchema, read off the shipped bundle:
// it validates this section lazily at first tool call, so it can't be run-checked.
const fs = require('fs');
const path = require('path');
const { getProvider } = require('./ai-providers');
const { atomicWrite, tomlString } = require('../util/mcp-config');

const BEGIN = '# >>> klaussy-managed — toggle in Klaussy Preferences, or delete this block';
const END = '# <<< klaussy-managed';

const RULE_LINES = [
  '[[permission.rules]]',
  `decision = ${tomlString('allow')}`,
  `scope = ${tomlString('user')}`,
  `pattern = ${tomlString('Bash')}`,
  `reason = ${tomlString('Klaussy autonomous runs (CI fix-check)')}`,
];

function configPath(home) {
  return path.join(home || getProvider('kimi').sessionDir(), 'config.toml');
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

// [start, end] line indices of our fenced block, or null when absent.
function blockRange(lines) {
  const start = lines.indexOf(BEGIN);
  if (start === -1) return null;
  const end = lines.indexOf(END, start + 1);
  return end === -1 ? null : { start, end };
}

function isGranted(home) {
  return blockRange(readText(configPath(home)).split('\n')) !== null;
}

function grant(home) {
  const file = configPath(home);
  const text = readText(file);
  if (blockRange(text.split('\n'))) return { ok: true, changed: false };
  const block = [BEGIN, ...RULE_LINES, END].join('\n') + '\n';
  const sep = text === '' || text.endsWith('\n\n') ? '' : (text.endsWith('\n') ? '\n' : '\n\n');
  try {
    atomicWrite(file, text + sep + block);
    return { ok: true, changed: true };
  } catch (err) {
    return { error: err.message };
  }
}

function revoke(home) {
  const file = configPath(home);
  const lines = readText(file).split('\n');
  const range = blockRange(lines);
  if (!range) return { ok: true, changed: false };
  const out = lines.slice(0, range.start).concat(lines.slice(range.end + 1));
  // Collapse the doubled blank line left behind by the splice.
  while (out.length > 1 && out[range.start - 1] === '' && out[range.start] === '') {
    out.splice(range.start, 1);
  }
  try {
    atomicWrite(file, out.join('\n'));
    return { ok: true, changed: true };
  } catch (err) {
    return { error: err.message };
  }
}

function setGranted(granted, home) {
  return granted ? grant(home) : revoke(home);
}

module.exports = { isGranted, grant, revoke, setGranted, configPath };
