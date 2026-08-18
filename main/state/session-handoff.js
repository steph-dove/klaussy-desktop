// Cross-agent session handoff. When a session started by one agent is resumed
// with a DIFFERENT agent, native resume is impossible (each agent only
// understands its own transcripts), so we distill the prior session into a
// plain-text "handoff brief" and seed the incoming agent with it as its first
// prompt (see util/agent-prompt + spawnInWorktree).
//
// Source material, in priority order:
//   1. the outgoing agent's transcript — only Claude exposes a readable
//      per-session .jsonl today; other agents contribute nothing here.
//   2. a git brief (branch, commits, diffstat, uncommitted changes) — always
//      available and agent-agnostic.
// The material is condensed by a headless `-p` call (preferring Claude, which
// has no folder-trust gate and reliable text output). If no summarizer is
// available or it fails/times out, we fall back to handing over the raw
// material verbatim — the user chose "summary + git fallback".
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { claudeProjectDir } = require('../util/claude-paths');
const { spawnHeadlessAgent, promptGoesOnStdin } = require('../util/agent-spawn');
const { whichBinSync } = require('../util/platform');
const { getProvider, binFor, displayNameFor, PROVIDER_IDS } = require('./ai-providers');
const { loadConfig } = require('../util/config');

const MAX_TRANSCRIPT_CHARS = 24000; // keep the most-recent tail when longer
const SUMMARY_TIMEOUT_MS = 60000;

// Flatten the outgoing Claude session transcript to "role: text" lines. Returns
// '' for any other agent (no readable transcript) or on any read error.
function readClaudeTranscript(worktreePath, sessionId) {
  try {
    const dir = claudeProjectDir(worktreePath);
    if (!dir || !fs.existsSync(dir)) return '';
    let file = sessionId ? path.join(dir, `${sessionId}.jsonl`) : null;
    if (!file || !fs.existsSync(file)) {
      const jsonls = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      if (!jsonls.length) return '';
      file = path.join(dir, jsonls[0].f);
    }
    const out = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const msg = obj && obj.message;
      if (!msg || !msg.role) continue;
      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter((c) => c && c.type === 'text' && c.text)
          .map((c) => c.text)
          .join('\n');
      }
      text = (text || '').trim();
      if (text) out.push(`${msg.role}: ${text}`);
    }
    const joined = out.join('\n\n');
    return joined.length > MAX_TRANSCRIPT_CHARS ? joined.slice(-MAX_TRANSCRIPT_CHARS) : joined;
  } catch {
    return '';
  }
}

// Agent-agnostic snapshot of the work on this branch. Always available.
function gitBrief(worktreePath) {
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: worktreePath, stdio: 'pipe', timeout: 10000 }).toString().trim();
    } catch {
      return '';
    }
  };
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  // Resolve a base to diff against: merge-base with origin/HEAD, then common
  // default branches; fall back to the last 10 commits if nothing resolves.
  let base = '';
  const originHead = git(['rev-parse', '--abbrev-ref', 'origin/HEAD']);
  if (originHead) base = git(['merge-base', 'HEAD', originHead]);
  if (!base) {
    for (const b of ['origin/main', 'origin/master', 'main', 'master']) {
      const mb = git(['merge-base', 'HEAD', b]);
      if (mb) { base = mb; break; }
    }
  }
  const range = base ? `${base}..HEAD` : '';
  const log = range ? git(['log', range, '--oneline', '--no-decorate']) : git(['log', '-10', '--oneline', '--no-decorate']);
  const stat = range ? git(['diff', '--stat', range]) : '';
  const status = git(['status', '--short']);
  const parts = [];
  if (branch) parts.push(`Branch: ${branch}`);
  if (log) parts.push(`Commits on this branch:\n${log}`);
  if (stat) parts.push(`Files changed vs base:\n${stat}`);
  if (status) parts.push(`Uncommitted changes:\n${status}`);
  return parts.join('\n\n');
}

function summaryPrompt(material) {
  return `You are about to take over an in-progress software task from another AI coding agent. Read the prior session material below and write a concise handoff brief for the agent picking it up, with these sections:
- Goal: what the user is trying to accomplish
- Done so far: key changes and decisions already made
- Current state: what works, what doesn't, anything in flight
- Next steps: the immediate things to do next
Keep it tight and factual. Do not invent details that aren't in the material.

=== PRIOR SESSION MATERIAL ===
${material}`;
}

// Condense `material` via a headless agent run. Prefers Claude (no folder-trust
// gate, reliable -p text), then the incoming agent if it has no trust gate
// (gated agents like Gemini/Antigravity would block on consent in -p). Resolves
// to '' on any failure/timeout so the caller falls back to the raw material.
function summarize(material, incomingMode) {
  return runHeadless(summaryPrompt(material), incomingMode);
}

// Installed as well as suitable: the registry describes claude whether or not
// it is on the machine, so choosing it blindly left Codex/Kimi users with none.
function pickSummarizer(preferredMode, config) {
  const order = ['claude', preferredMode, ...PROVIDER_IDS]
    .filter((id, i, arr) => id && arr.indexOf(id) === i);
  for (const id of order) {
    const p = getProvider(id);
    if (!p || p.remoteBackend || p.worktreeConsent) continue;
    // 'ollama' here is aider, which edits files; the models are reached over HTTP below.
    if (id === 'ollama') continue;
    if (typeof p.buildHeadlessRun !== 'function') continue;
    const bin = binFor(id, config);
    if (!bin) continue;
    const found = /[\\/]/.test(bin) ? fs.existsSync(bin) : !!whichBinSync(bin);
    if (found) return { prov: p, bin };
  }
  return null;
}

// Summaries go to the local model first so this routine work stays free and on
// the machine; an installed agent covers a stopped or base-only Ollama, and
// `summarizeLocally: false` inverts the order.
async function runHeadless(prompt, preferredMode) {
  const localFirst = loadConfig().summarizeLocally !== false;
  if (localFirst) {
    const local = await require('./ollama').generateText(prompt).catch(() => '');
    if (local) return local;
  }
  const viaCli = await runViaCli(prompt, preferredMode);
  if (viaCli || localFirst) return viaCli;
  return require('./ollama').generateText(prompt).catch(() => '');
}

// Runs one prompt through a non-gated agent; resolves '' on any failure or timeout.
function runViaCli(prompt, preferredMode) {
  return new Promise((resolve) => {
    const picked = pickSummarizer(preferredMode, loadConfig());
    if (!picked) return resolve('');
    const { prov, bin } = picked;
    // Windows agent CLIs are .cmd shims: spawn() can't run them, so summaries came
    // back empty until spawnHeadlessAgent's shell + stdin path.
    const onStdin = promptGoesOnStdin(bin);
    let run;
    try {
      run = prov.buildHeadlessRun(bin, { prompt, mode: 'text', model: '', promptOnStdin: onStdin });
    } catch {
      return resolve('');
    }
    let proc;
    let out = '';
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      try { proc && proc.kill(); } catch { /* already gone */ }
      resolve(val);
    };
    try {
      proc = spawnHeadlessAgent(
        bin, run.args,
        { stdio: [onStdin ? 'pipe' : 'ignore', 'pipe', 'ignore'] },
        run.stdinInput,
      );
    } catch {
      return resolve('');
    }
    const timer = setTimeout(() => finish(''), SUMMARY_TIMEOUT_MS);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => { clearTimeout(timer); finish(''); });
    // A CLI that fails while still printing to stdout ("Not logged in · Please
    // run /login") would otherwise have its error written to the notes channel
    // as the summary.
    proc.on('exit', (code) => { clearTimeout(timer); finish(code === 0 ? out.trim() : ''); });
  });
}

// Always resolves to a non-empty string so the caller can spawn with it
// unconditionally. Notes are left out — this gets condensed, and
// spawnInWorktree prepends them verbatim.
async function buildHandoffSeed({ worktreePath, originalMode, sessionId }) {
  const transcript = originalMode === 'claude' ? readClaudeTranscript(worktreePath, sessionId) : '';
  const brief = gitBrief(worktreePath);
  const material = [
    transcript && `Prior conversation (most recent turns):\n${transcript}`,
    brief && `Repository state:\n${brief}`,
  ].filter(Boolean).join('\n\n');
  const fromName = displayNameFor(originalMode) || originalMode || 'another agent';

  if (!material) {
    return `You are continuing a coding session in this worktree that was previously handled by ${fromName}. No prior transcript or git history was available to summarize — review the working tree and ask what I'd like to continue.`;
  }

  const summary = await summarize(material, originalMode);
  const body = summary || material;
  const head = summary
    ? `You are continuing a coding session previously handled by ${fromName}. Here is a handoff summary of the work so far:`
    : `You are continuing a coding session previously handled by ${fromName}. A summary couldn't be generated, so here is the raw prior context:`;
  return `${head}\n\n${body}\n\nPlease continue the work. If anything is ambiguous, ask before making large changes.`;
}

module.exports = { buildHandoffSeed, runHeadless };
