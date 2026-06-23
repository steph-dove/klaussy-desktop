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
const { execFileSync, spawn } = require('child_process');
const { claudeProjectDir } = require('../util/claude-paths');
const { getProvider, binFor, displayNameFor } = require('./ai-providers');
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
  return new Promise((resolve) => {
    const config = loadConfig();
    const candidates = ['claude', incomingMode].filter((id, i, a) => id && a.indexOf(id) === i);
    let prov = null;
    for (const id of candidates) {
      const p = getProvider(id);
      // skip gated agents as summarizers (they'd prompt for folder trust)
      if (p && typeof p.buildHeadlessRun === 'function' && (id === 'claude' || !p.worktreeConsent)) {
        prov = p;
        break;
      }
    }
    if (!prov) return resolve('');
    const bin = binFor(prov.id, config);
    let run;
    try {
      run = prov.buildHeadlessRun(bin, { prompt: summaryPrompt(material), mode: 'text', model: '' });
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
      proc = spawn(bin, run.args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve('');
    }
    const timer = setTimeout(() => finish(''), SUMMARY_TIMEOUT_MS);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => { clearTimeout(timer); finish(''); });
    proc.on('exit', () => { clearTimeout(timer); finish(out.trim()); });
  });
}

// Build the seed prompt handed to the incoming agent. Always resolves to a
// non-empty string so the caller can spawn with it unconditionally.
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

module.exports = { buildHandoffSeed };
