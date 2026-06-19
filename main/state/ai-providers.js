// AI CLI provider registry — the single source of truth for the per-tool
// differences between the coding agents Klaussy can drive (Claude Code,
// OpenAI Codex, Gemini CLI, GitHub Copilot CLI).
//
// Every place that used to hardcode `config.claudePath || 'claude'` and the
// `claude --resume <id>` / `claude -p` shapes now asks this registry instead.
// A task/instance's `mode` is the provider id ('claude' | 'codex' | 'gemini' |
// 'copilot') or the sentinel 'shell' for a plain login shell. Use
// `isAgentMode(mode)` rather than `=== 'claude'` to mean "this is an AI agent".
//
// Phase 1 scope (interactive terminals + resume + selection):
//   - buildInteractiveCmd / buildHeadlessRun / binFor / display metadata are
//     live and exercised by the spawn + detection paths.
//   - Only Claude does exact session-id tracking (its per-worktree .jsonl model
//     in main/state/instances.js). The other tools store sessions globally or
//     under an opaque project hash, so Phase 1 resume uses each tool's native
//     "continue the most recent session in this directory" form via the
//     `resumeLatest` flag instead of threading an exact id around.
//   - parseStreamLine / usageFromSessionLine encode each tool's documented
//     stream-JSON / transcript schema for the headless surfaces (Phase 2+).
//     Claude's is verified (it mirrors the existing parsers); the other three
//     are documented-but-unverified — marked `VERIFY:` — and MUST be checked
//     against a real `--output-format`/`--json` capture before being trusted.
//     Nothing in Phase 1 calls them, so they are dormant until then.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { claudeProjectDir } = require('../util/claude-paths');

function home() {
  return process.env.HOME || os.homedir();
}

// List *.jsonl files under `dir` (recursively if `recursive`), each with
// nanosecond ctime + mtime for stable ordering. Used by the implement-PTY
// session detection. Missing dirs yield [].
function listJsonlFiles(dir, recursive) {
  if (!dir) return [];
  const out = [];
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (recursive) walk(full); }
      else if (e.name.endsWith('.jsonl')) {
        try {
          const st = fs.statSync(full, { bigint: true });
          out.push({ path: full, mtimeMs: Number(st.mtimeMs), ctimeNs: st.ctimeNs });
        } catch { /* file vanished mid-scan */ }
      }
    }
  };
  walk(dir);
  return out;
}

// Resolve a path through symlinks for comparison (macOS /tmp → /private/tmp).
// Falls back to the input if the path can't be resolved.
function realPath(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

// Read a Codex rollout file's launch cwd from its session_meta first line
// without a full JSON.parse — that line embeds the entire system prompt and can
// be hundreds of KB, but `cwd` sits near the front, so a regex over the head
// is both correct and cheap.
function readCodexSessionCwd(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    const m = buf.toString('utf8', 0, n).match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

// ---- Claude stream/usage parsers (verified — mirror instances.js /
// pr-implement-pty.js / token-usage.js, which read the same .jsonl) ----

// Extract a file path from a codex apply_patch body (`*** Add File: x`).
function codexPatchHint(input) {
  const m = String(input || '').match(/\*\*\* (?:Add|Update|Delete) File:\s*(.+)/);
  return m ? m[1].trim() : '';
}

function claudeUsage(u) {
  if (!u) return null;
  return {
    inputTokens: u.input_tokens || 0,
    cacheCreationInputTokens: u.cache_creation_input_tokens || 0,
    cacheReadInputTokens: u.cache_read_input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    totalTokens:
      (u.input_tokens || 0) +
      (u.cache_creation_input_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.output_tokens || 0),
  };
}

// All adapters return the same normalized event shape so the renderer's
// progress UI (tool chips, usage, end_turn) is provider-agnostic:
//   { kind: 'usage', usage, requestId? }
//   { kind: 'tool',  name, hint }
//   { kind: 'text',  text }
//   { kind: 'end_turn' }
// parseStreamLine(obj) returns an array of those (possibly empty).

const PROVIDERS = {
  claude: {
    id: 'claude',
    displayName: 'Claude Code',
    // Native memory file this agent reads on startup, used to seed multi-repo
    // session context (sibling repos + shared branch). CLAUDE.local.md is
    // Claude's gitignored-by-convention local memory.
    memoryFile: 'CLAUDE.local.md',
    shortLabel: 'cc',
    defaultBin: 'claude',
    configPathKey: 'claudePath',
    versionArgs: ['--version'],
    // Per-worktree .jsonl under ~/.claude/projects/<dashed-cwd>/; exact ids
    // are tracked in instances.js, so this is the one tool with real resume.
    perWorktreeSessions: true,
    supportsExactResume: true,

    buildInteractiveCmd(bin, { resumeSessionId, model } = {}) {
      let base = resumeSessionId ? `${bin} --resume ${resumeSessionId}` : bin;
      if (model) base += ` --model ${model}`; // alias (opus/sonnet/haiku) or full id
      return base;
    },
    // Headless one-shot. mode 'text' → caller wants the clean final answer on
    // stdout; mode 'stream' → structured stream-json events. outputMode tells
    // spawnAgentStream how to read stdout: 'passthrough' (stdout IS the
    // payload) or 'json-text' (stdout is JSONL; extract agent text events).
    buildHeadlessRun(_bin, { prompt, mode, model /*, allowEdits */ } = {}) {
      // Claude's headless `-p` already edits within cwd on the autonomous
      // surfaces today, so allowEdits needs no extra flag here.
      const m = model ? ['--model', model] : [];
      return mode === 'stream'
        ? { args: [...m, '-p', prompt, '--output-format', 'stream-json', '--verbose'], outputMode: 'passthrough' }
        : { args: [...m, '-p', prompt], outputMode: 'passthrough' };
    },
    sessionDir(worktreePath) {
      if (!worktreePath) return null;
      // Claude replaces every non-alphanumeric char with '-' (not just '/') —
      // see util/claude-paths. A '/'-only encoding misses PR-checkout
      // worktrees under "Application Support" (space), so the implement-PTY
      // tail never finds the session file and the run never marks "done".
      return claudeProjectDir(worktreePath);
    },

    parseStreamLine(obj) {
      const events = [];
      const msg = obj && obj.message;
      if (!msg) return events;
      if (msg.usage) {
        events.push({ kind: 'usage', usage: claudeUsage(msg.usage), requestId: obj.requestId });
      }
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (!block) continue;
          if (block.type === 'tool_use' && block.name) {
            const inp = block.input || {};
            const hint = inp.file_path || inp.command || inp.pattern || '';
            events.push({ kind: 'tool', name: block.name, hint: typeof hint === 'string' ? hint : '' });
          } else if (block.type === 'text' && block.text) {
            events.push({ kind: 'text', text: block.text });
          }
        }
      }
      const stopReason = msg.stop_reason || obj.stop_reason;
      if (stopReason === 'end_turn') events.push({ kind: 'end_turn' });
      return events;
    },
    usageFromSessionLine(obj) {
      const u = obj && obj.message && obj.message.usage;
      if (!u) return null;
      return {
        requestId: obj.requestId || obj.uuid || null,
        timestamp: obj.timestamp || null,
        usage: claudeUsage(u),
      };
    },
    // Implement-PTY JSONL tail: Claude's session lines share the stream-json
    // message shape, so this mirrors parseStreamLine.
    sessionLineToEvents(obj) {
      return this.parseStreamLine(obj);
    },
    // Session detection for the implement PTY. Claude writes one .jsonl per
    // session into the per-worktree project dir, so we snapshot the dir before
    // spawn and pick the newest file that wasn't there.
    snapshotSessions(worktreePath) {
      return new Set(listJsonlFiles(this.sessionDir(worktreePath), false).map(f => f.path));
    },
    findNewSession(worktreePath, snapshot) {
      const files = listJsonlFiles(this.sessionDir(worktreePath), false)
        .filter(f => !snapshot.has(f.path))
        .sort((a, b) => (a.ctimeNs < b.ctimeNs ? -1 : a.ctimeNs > b.ctimeNs ? 1 : 0));
      if (!files.length) return null;
      return { filePath: files[0].path, sessionId: path.basename(files[0].path).replace(/\.jsonl$/, '') };
    },
  },

  codex: {
    id: 'codex',
    displayName: 'OpenAI Codex',
    memoryFile: 'AGENTS.md', // Codex reads the cross-tool AGENTS.md standard
    shortLabel: 'cx',
    defaultBin: 'codex',
    configPathKey: 'codexPath',
    versionArgs: ['--version'],
    // Sessions are global by date (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl),
    // not keyed by cwd — so no per-worktree exact-id tracking in Phase 1.
    perWorktreeSessions: false,
    supportsExactResume: false,
    // Codex signs in with single-use rotating OAuth refresh tokens: two Codex
    // processes refreshing at once invalidate each other (refresh_token_reused),
    // forcing a re-login. agent-concurrency.js warns before a second concurrent
    // Codex session starts. Claude/Gemini don't set this.
    concurrentAuthUnsafe: true,
    // The interactive TUI pre-fills the positional prompt but waits for an
    // Enter to submit it (Claude auto-runs its positional prompt). The implement
    // PTY sends Enter once the TUI is up. VERIFIED: codex-cli 0.135.0.
    needsEnterToSubmit: true,

    buildInteractiveCmd(bin, { resumeSessionId, resumeLatest, model } = {}) {
      // `-m` is a top-level flag, so it goes before the `resume` subcommand.
      const m = model ? ` -m ${model}` : '';
      if (resumeSessionId) return `${bin}${m} resume ${resumeSessionId}`;
      if (resumeLatest) return `${bin}${m} resume --last`;
      return `${bin}${m}`;
    },
    buildHeadlessRun(_bin, { prompt, mode, allowEdits, model } = {}) {
      // `codex exec --json` always emits JSONL (no clean-text plain mode). For
      // text surfaces we extract the agent_message text ('json-text'); for
      // stream surfaces we translate Codex events into Claude-shaped
      // stream-json so the PR-review renderer parses one format ('json-translate').
      // `--skip-git-repo-check` lets it run in a file-only (non-git) folder
      // (verified: only `codex exec` accepts this flag, not the interactive TUI).
      const args = ['exec', '--skip-git-repo-check'];
      if (model) args.push('-m', model); // pin a codex model/version when chosen
      // Autonomous-edit surfaces (pr-fix-check): Codex defaults to a read-only
      // sandbox, so grant scoped workspace writes. `codex exec` is already
      // non-interactive (no `--ask-for-approval` flag — verified), and this is
      // NOT the dangerous full bypass (`--yolo` / `--dangerously-bypass-...`):
      // the sandbox still blocks escaping the workspace and network access.
      if (allowEdits) args.push('--sandbox', 'workspace-write');
      args.push('--json', prompt);
      return { args, outputMode: mode === 'stream' ? 'json-translate' : 'json-text' };
    },
    sessionDir() {
      // Global, date-bucketed; not resolvable from a worktree path.
      return path.join(home(), '.codex', 'sessions');
    },

    // VERIFIED against codex-cli 0.135.0 `codex exec --json` (2026-05-28):
    // {type:'thread.started',thread_id}, {type:'turn.started'},
    // {type:'item.completed',item:{type:'agent_message',text}}, and
    // {type:'turn.completed',usage:{input_tokens,cached_input_tokens,
    // output_tokens,reasoning_output_tokens}} (input_tokens is the full input;
    // cached_input_tokens is a subset of it — don't add it to the total).
    // The tool-event subtypes (command_execution / file_change / patch) are
    // still inferred — confirm with a tool-using run before fully trusting.
    parseStreamLine(obj) {
      const events = [];
      if (!obj || !obj.type) return events;
      if (obj.type === 'turn.completed') {
        const u = obj.usage;
        if (u) {
          events.push({
            kind: 'usage',
            usage: {
              inputTokens: u.input_tokens || 0,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: u.cached_input_tokens || 0,
              outputTokens: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0),
              totalTokens:
                (u.input_tokens || 0) + (u.output_tokens || 0) + (u.reasoning_output_tokens || 0),
            },
          });
        }
        events.push({ kind: 'end_turn' }); // turn.completed is the "turn done" signal
      } else if (obj.type === 'item.completed' && obj.item) {
        const it = obj.item;
        if (it.type === 'command_execution' && it.command) {
          events.push({ kind: 'tool', name: 'Bash', hint: String(it.command) });
        } else if (it.type === 'file_change' || it.type === 'patch') {
          events.push({ kind: 'tool', name: 'Edit', hint: it.path || '' });
        } else if (it.type === 'agent_message' && it.text) {
          events.push({ kind: 'text', text: it.text });
        }
      } else if (obj.type === 'turn.failed' || obj.type === 'error') {
        events.push({ kind: 'end_turn' });
      }
      return events;
    },
    usageFromSessionLine(obj) {
      // VERIFIED against codex-cli 0.135.0 rollout-*.jsonl (2026-05-31): the
      // session file records usage as an `event_msg`/`token_count` line whose
      // `info.last_token_usage` is THIS turn and `info.total_token_usage` is
      // cumulative. For per-turn aggregation (Phase 4) use last_token_usage to
      // avoid double-counting the running total. Codex's own `total_tokens`
      // (= input + output, excludes reasoning) is authoritative when present.
      if (obj && obj.type === 'event_msg' && obj.payload && obj.payload.type === 'token_count') {
        const info = obj.payload.info || {};
        const u = info.last_token_usage || info.total_token_usage;
        if (!u) return null;
        return {
          requestId: null,
          timestamp: obj.timestamp || null,
          usage: {
            inputTokens: u.input_tokens || 0,
            cacheReadInputTokens: u.cached_input_tokens || 0,
            cacheCreationInputTokens: 0,
            outputTokens: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0),
            totalTokens: u.total_tokens || ((u.input_tokens || 0) + (u.output_tokens || 0)),
          },
        };
      }
      return null;
    },
    // Implement-PTY JSONL tail. VERIFIED against codex-cli 0.135.0 rollout-*.jsonl
    // (tool-using session, 2026-05-31): the session file uses {type,payload}
    // where event_msg:agent_message carries `message` text, event_msg:token_count
    // carries usage, event_msg:task_complete ends the turn, and
    // response_item:custom_tool_call is a tool (name 'apply_patch'→Edit with the
    // patched file as hint, 'shell'→Bash with the command as hint).
    sessionLineToEvents(obj) {
      const events = [];
      if (!obj) return events;
      const p = obj.payload || {};
      if (obj.type === 'event_msg') {
        if (p.type === 'agent_message' && p.message) {
          events.push({ kind: 'text', text: p.message });
        } else if (p.type === 'token_count' && p.info) {
          const u = p.info.last_token_usage || p.info.total_token_usage;
          if (u) events.push({
            kind: 'usage',
            usage: {
              inputTokens: u.input_tokens || 0,
              cacheReadInputTokens: u.cached_input_tokens || 0,
              cacheCreationInputTokens: 0,
              outputTokens: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0),
              totalTokens: u.total_tokens || ((u.input_tokens || 0) + (u.output_tokens || 0)),
            },
          });
        } else if (p.type === 'task_complete') {
          events.push({ kind: 'end_turn' });
        }
      } else if (obj.type === 'response_item' && p.type === 'custom_tool_call' && p.name) {
        const name = p.name === 'apply_patch' ? 'Edit' : (p.name === 'shell' ? 'Bash' : p.name);
        const hint = p.name === 'apply_patch' ? codexPatchHint(p.input) : String(p.input || '').slice(0, 60);
        events.push({ kind: 'tool', name, hint });
      }
      return events;
    },
    // Session detection for the implement PTY. Codex sessions are global,
    // bucketed by date (not per-worktree), so we snapshot the whole tree before
    // spawn and pick the newest new file whose recorded launch cwd matches this
    // worktree (disambiguates concurrent Codex runs in other dirs).
    snapshotSessions() {
      return new Set(listJsonlFiles(this.sessionDir(), true).map(f => f.path));
    },
    findNewSession(worktreePath, snapshot) {
      // Codex records the resolved realpath as cwd, so compare resolved paths
      // (macOS /tmp vs /private/tmp; PR worktrees can also sit behind symlinks).
      const target = realPath(worktreePath);
      const files = listJsonlFiles(this.sessionDir(), true)
        .filter(f => !snapshot.has(f.path))
        .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
      for (const f of files) {
        const cwd = readCodexSessionCwd(f.path);
        if (cwd && realPath(cwd) === target) {
          // rollout-<ts>-<uuid>.jsonl → sessionId is the trailing uuid.
          const base = path.basename(f.path).replace(/\.jsonl$/, '');
          const m = base.match(/([0-9a-f-]{36})$/i);
          return { filePath: f.path, sessionId: m ? m[1] : base };
        }
      }
      return null;
    },
  },

  gemini: {
    id: 'gemini',
    displayName: 'Gemini CLI',
    memoryFile: 'GEMINI.md', // Gemini CLI reads GEMINI.md
    shortLabel: 'gm',
    defaultBin: 'gemini',
    configPathKey: 'geminiPath',
    versionArgs: ['--version'],
    // Sessions live under ~/.gemini/tmp/<project_hash>/chats/; the hash
    // algorithm is undocumented, so Phase 1 uses `-r` (resume latest) rather
    // than locating exact files.
    perWorktreeSessions: false,
    supportsExactResume: false,

    // VERIFIED flags (gemini-cli 0.44.1 --help): `--resume <latest|index>` needs
    // a value; the implement flow passes the prompt via `-i` (execute + stay
    // interactive), so the positional bare-prompt form isn't used.
    interactivePromptFlag: '-i',
    // Gemini's "trusted folders" gate refuses to run in a directory it hasn't
    // been told to trust. We surface this as a per-(worktree, agent) consent
    // prompt (see util/agent-consent.js); only when the user allows do we pass
    // `--skip-trust` (trust the folder) + `--approval-mode auto_edit` (the
    // read/write the user granted). Without consent the agent isn't spawned.
    worktreeConsent: {
      prompt: 'Gemini needs to trust this folder and read/write its files to work here.',
      allowLabel: 'Allow read & write',
    },
    buildInteractiveCmd(bin, { resumeSessionId, resumeLatest, trust, model } = {}) {
      var base = bin;
      if (trust) base += ' --skip-trust --approval-mode auto_edit';
      if (model) base += ` -m ${model}`; // pin a specific Gemini model/version
      if (resumeSessionId) return `${base} --resume ${resumeSessionId}`;
      if (resumeLatest) return `${base} --resume latest`;
      return base;
    },
    buildHeadlessRun(_bin, { prompt, mode, allowEdits, trust, model } = {}) {
      // VERIFIED (gemini-cli 0.44.1): `-p` = non-interactive; `-o stream-json`
      // = NDJSON we translate into Claude-shaped events; `--approval-mode
      // auto_edit` auto-approves edit tools. `--skip-trust` clears the
      // trusted-folders gate (only applied once the user has consented).
      // `-m <model>` pins a version (e.g. gemini-2.5-flash) when chosen.
      const args = [];
      if (trust) args.push('--skip-trust');
      if (model) args.push('-m', model);
      args.push('-p', prompt);
      if (mode === 'stream') args.push('--output-format', 'stream-json');
      if (allowEdits) args.push('--approval-mode', 'auto_edit');
      return { args, outputMode: mode === 'stream' ? 'json-translate' : 'passthrough' };
    },
    sessionDir() {
      return path.join(home(), '.gemini', 'tmp');
    },

    // VERIFIED against gemini-cli 0.44.1 `-o stream-json` (2026-06-02):
    //   {type:'init', session_id, model}
    //   {type:'message', role:'user', content}        ← the echoed prompt; IGNORE
    //   {type:'message', role:'assistant', content, delta:true}  ← streamed deltas
    //   {type:'result', status, stats:{total_tokens,input_tokens,output_tokens,cached,...}}
    // Only assistant messages are output; they arrive as deltas (delta:true), so
    // the json-translate layer ACCUMULATES them. tool calls land as tool_use
    // events (shape still unverified — left best-effort).
    parseStreamLine(obj) {
      const events = [];
      if (!obj || !obj.type) return events;
      if (obj.type === 'message' && obj.role === 'assistant' && typeof obj.content === 'string') {
        events.push({ kind: 'text', text: obj.content, delta: !!obj.delta });
      } else if (obj.type === 'tool_use' && obj.tool_name) {
        // VERIFIED shape: {type:'tool_use', tool_name, tool_id, parameters:{...}}.
        const p = obj.parameters || {};
        const hint = p.file_path || p.path || p.dir_path || p.pattern || p.command || p.title || '';
        events.push({ kind: 'tool', name: obj.tool_name, hint: typeof hint === 'string' ? hint : '' });
      } else if (obj.type === 'result') {
        const s = obj.stats || {};
        events.push({
          kind: 'usage',
          usage: {
            inputTokens: s.input_tokens || s.input || 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: s.cached || 0,
            outputTokens: s.output_tokens || 0,
            totalTokens: s.total_tokens || 0,
          },
        });
        events.push({ kind: 'end_turn' });
      }
      // init + user messages are intentionally ignored.
      return events;
    },
    usageFromSessionLine() {
      // VERIFY: Gemini session/chat file format is undocumented. Left null
      // until a real file is inspected; token-usage aggregation for Gemini is
      // deferred to Phase 4.
      return null;
    },
    // VERIFY: Gemini session/chat format undocumented. Stubs so the implement
    // PTY degrades gracefully (no tail attached) instead of crashing.
    sessionLineToEvents() { return []; },
    snapshotSessions() { return new Set(); },
    findNewSession() { return null; },
  },

  copilot: {
    id: 'copilot',
    displayName: 'GitHub Copilot',
    memoryFile: 'AGENTS.md', // Copilot CLI reads AGENTS.md
    shortLabel: 'cp',
    defaultBin: 'copilot',
    configPathKey: 'copilotPath',
    versionArgs: ['--version'],
    // Sessions live under ~/.copilot/session-state/<id>/events.jsonl (+ a
    // SQLite session-store.db). Global, not per-cwd. `--continue` resumes the
    // most recent session in the current directory.
    perWorktreeSessions: false,
    supportsExactResume: false,

    buildInteractiveCmd(bin, { resumeSessionId, resumeLatest } = {}) {
      if (resumeSessionId) return `${bin} --resume=${resumeSessionId}`;
      if (resumeLatest) return `${bin} --continue`;
      return bin;
    },
    buildHeadlessRun(_bin, { prompt, mode, allowEdits } = {}) {
      // `copilot -p -s` (silent) prints only the final response. Stream mode
      // uses JSONL we translate into Claude-shaped events. VERIFY on a real install.
      const args = ['-p', prompt];
      if (mode === 'stream') args.push('--output-format', 'json'); else args.push('-s');
      // Allow the write tool for autonomous-edit surfaces. VERIFY exact tool name.
      if (allowEdits) args.push('--allow-tool', 'write');
      return { args, outputMode: mode === 'stream' ? 'json-translate' : 'passthrough' };
    },
    sessionDir() {
      return path.join(home(), '.copilot', 'session-state');
    },

    // VERIFY: Copilot's `--output-format json` is documented as JSONL but the
    // per-line schema is NOT published. This parser is a best-effort guess and
    // MUST be rewritten from a real capture before Phase 2/3 trusts it. Known
    // gotcha (issue #2012): raw U+2028/U+2029 in events.jsonl can break
    // JSON.parse on resume — sanitize when reading session files.
    parseStreamLine(obj) {
      const events = [];
      if (!obj || typeof obj !== 'object') return events;
      // Speculative: mirror common agent shapes until verified.
      if (obj.type === 'tool_use' || obj.tool) {
        const name = obj.name || obj.tool || 'tool';
        events.push({ kind: 'tool', name, hint: obj.hint || obj.path || '' });
      } else if (obj.type === 'assistant' || obj.type === 'message') {
        const t = obj.text || obj.content;
        if (t) events.push({ kind: 'text', text: typeof t === 'string' ? t : '' });
      }
      if (obj.usage) {
        const u = obj.usage;
        events.push({
          kind: 'usage',
          usage: {
            inputTokens: u.input_tokens || u.prompt_tokens || 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            outputTokens: u.output_tokens || u.completion_tokens || 0,
            totalTokens: u.total_tokens || 0,
          },
        });
      }
      return events;
    },
    usageFromSessionLine() {
      return null; // VERIFY: deferred to Phase 4 (schema unknown).
    },
    // VERIFY: Copilot events.jsonl schema undocumented. Stubs so the implement
    // PTY degrades gracefully (no tail attached) instead of crashing.
    sessionLineToEvents() { return []; },
    snapshotSessions() { return new Set(); },
    findNewSession() { return null; },
  },
};

const PROVIDER_IDS = Object.keys(PROVIDERS);

// npm package per provider, used by the Setup Check dialog to show/run a
// one-line install command. Kept here so install guidance has one source.
const NPM_PACKAGES = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  gemini: '@google/gemini-cli',
  copilot: '@github/copilot',
};

// Short, button-friendly names (vs the fuller displayName).
const SHORT_NAMES = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  copilot: 'Copilot',
};

// Model/version selection. `id:''` = the agent's own default (no flag passed).
// Lists are grounded against each CLI, not guessed:
//   claude  — `--model` takes the aliases 'opus'/'sonnet'/'haiku' (claude --help),
//             which always resolve to the latest of each tier.
//   codex   — the list-visible slugs from ~/.codex/models_cache.json (gpt-5.5,
//             gpt-5.4-mini). `-m` is accepted by both the TUI and `codex exec`.
//   gemini  — verified against gemini-cli --help / docs.
//   copilot — Default-only: its `--model` slugs couldn't be verified here (the
//             account's Copilot subscription/policy blocks runs), so we don't
//             ship slugs that might error. Fill in once it can run + verify.
const MODEL_FLAGS = { claude: '--model', codex: '-m', gemini: '-m', copilot: '--model' };
const MODELS = {
  claude: [
    { id: '', label: 'Default' },
    { id: 'opus', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'haiku', label: 'Haiku' },
  ],
  codex: [
    { id: '', label: 'Default' },
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  ],
  gemini: [
    { id: '', label: 'Default (auto)' },
    { id: 'gemini-2.5-flash', label: '2.5 Flash' },
    { id: 'gemini-2.5-pro', label: '2.5 Pro' },
    { id: 'gemini-3-flash-preview', label: '3 Flash (preview)' },
    { id: 'gemini-3-pro-preview', label: '3 Pro (preview)' },
  ],
  copilot: [{ id: '', label: 'Default' }],
};
function modelsFor(id) { return MODELS[id] || [{ id: '', label: 'Default' }]; }
function modelFlagFor(id) { return MODEL_FLAGS[id] || '--model'; }

function installCommandFor(id) {
  return NPM_PACKAGES[id] ? `npm install -g ${NPM_PACKAGES[id]}` : null;
}

// Auth/sign-in probing for the Setup Check. `statusArgs` is a non-interactive
// command that reports login state (parsed against `notAuthedPattern`);
// `loginCommand` is what we tell the user to run to sign in. Only Codex has a
// verified quiet status command today (`codex login status` → "Not logged in"
// / "Logged in", exit 0); the others' status probes are added once verified on
// a real install (statusArgs:null → auth state reported as unknown, not false).
const AUTH_CHECKS = {
  claude:  { statusArgs: null, notAuthedPattern: null, loginCommand: 'claude' },
  codex:   { statusArgs: ['login', 'status'], notAuthedPattern: /not logged in/i, loginCommand: 'codex login' },
  gemini:  { statusArgs: null, notAuthedPattern: null, loginCommand: 'gemini' },
  copilot: { statusArgs: null, notAuthedPattern: null, loginCommand: 'copilot' },
};

function authMetaFor(id) {
  return AUTH_CHECKS[id] || { statusArgs: null, notAuthedPattern: null, loginCommand: id };
}

function getProvider(id) {
  return PROVIDERS[id] || null;
}

// True when `mode` denotes an AI agent (any provider) rather than a plain
// shell. Replaces the old `mode === 'claude'` checks, which conflated
// "is Claude" with "is an agent".
function isAgentMode(mode) {
  return !!PROVIDERS[mode];
}

// Resolve the configured binary for a provider, falling back to the bare
// command name (PATH-resolved). `config` is the loaded config object.
function binFor(providerId, config) {
  const p = PROVIDERS[providerId];
  if (!p) return null;
  const configured = config && config[p.configPathKey];
  return (configured && String(configured).trim()) || p.defaultBin;
}

// Lightweight descriptors for UI (preferences, pickers, sidebar).
function allProviders() {
  return PROVIDER_IDS.map((id) => {
    const p = PROVIDERS[id];
    return {
      id: p.id,
      displayName: p.displayName,
      shortName: SHORT_NAMES[p.id] || p.displayName,
      shortLabel: p.shortLabel,
      defaultBin: p.defaultBin,
      configPathKey: p.configPathKey,
      npmPackage: NPM_PACKAGES[p.id] || null,
      installCommand: installCommandFor(p.id),
      models: modelsFor(p.id),
      modelFlag: modelFlagFor(p.id),
    };
  });
}

// Display helpers used by the sidebar / saved-session list.
function shortLabelFor(mode) {
  if (mode === 'shell') return 'sh';
  const p = PROVIDERS[mode];
  return p ? p.shortLabel : 'cc';
}

function displayNameFor(mode) {
  if (mode === 'shell') return 'Shell';
  const p = PROVIDERS[mode];
  return p ? p.displayName : mode;
}

module.exports = {
  PROVIDER_IDS,
  getProvider,
  isAgentMode,
  binFor,
  allProviders,
  shortLabelFor,
  displayNameFor,
  installCommandFor,
  authMetaFor,
  modelsFor,
  modelFlagFor,
};
