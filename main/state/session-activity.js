// Agents only volunteer session notes for runtime triggers they recognise (ports,
// schemas, env vars), so klaussy writes them itself at the two moments they miss:
// a session changing hands, and two agents live on the same channel.

const { writeSessionNote, ensureSessionNotesDir } = require('./session-context');
const { runHeadless } = require('./session-handoff');
const { displayNameFor } = require('./ai-providers');
const { cleanExcerpt } = require('../util/terminal-excerpt');
const { loadConfig } = require('../util/config');

const ACTIVITY_INTERVAL_MS = 5 * 60 * 1000;
// Below this an agent has produced nothing worth another agent's context.
const MIN_NEW_OUTPUT_CHARS = 400;
const MAX_MATERIAL_CHARS = 6000;
const NOTHING_MARKER = 'NOTHING';

// instance id -> the output we last summarized, so each pass sees only what is new.
const lastSeen = new Map();
let timer = null;
let capturing = false;

// Deliberately a principle, not a list of triggers: when this listed examples,
// the summarizer declined every change that was not literally one of them.
function activityPrompt(name, mode, material) {
  return 'Other AI agents are working right now on related parts of this same system,'
    + ' in other repos and other terminals. They cannot see this terminal.\n\n'
    + `Below is recent output from ${displayNameFor(mode) || mode} in "${name}".`
    + ' Write a short note telling those agents what changed here that they could'
    + ' depend on, contradict, or duplicate — anything shared: an interface or'
    + ' payload shape, a required field or header, the values of an enum, a name,'
    + ' a port, a config or setup step, a decision about how something is done, or'
    + ' an area now being restructured. If you are unsure whether it matters,'
    + ' write the note.\n\n'
    + `If nothing of substance happened — the agent was idle, asked a question,`
    + ' or made a purely local edit nothing else could touch — reply with the'
    + ` single word ${NOTHING_MARKER} and nothing else. Do not explain why; an`
    + ' explanation gets stored as though it were the news.\n\n'
    + 'No preamble. Two or three sentences, written for the other agent.\n\n'
    + `--- output ---\n${material}`;
}

function handoffPrompt(fromMode, brief) {
  return `A coding session in this worktree just changed hands from ${displayNameFor(fromMode) || fromMode}`
    + ' to another agent. Below is the brief describing what the outgoing agent did.\n\n'
    + 'Rewrite it as a short note for OTHER agents working elsewhere in this session:'
    + ' what changed, what is in flight, and what they should not duplicate or contradict.'
    + ' No preamble. Under 120 words.\n\n'
    + `--- brief ---\n${brief}`;
}

// Models often decline in prose instead of the literal NOTHING ("No note
// needed — ... nothing in this repo changed"), and that got stored as the news.
const DECLINE = new RegExp(
  `^(${NOTHING_MARKER}|no(thing| note| update| notable| changes| news)?\\b[^.]{0,60}(needed|to report|to share|of note|changed|happened)|n/a)\\b`,
  'i',
);

function usable(summary) {
  const text = (summary || '').trim();
  if (!text || text.length < 20) return '';
  if (new RegExp(`^${NOTHING_MARKER}\\b`, 'i').test(text)) return '';
  if (DECLINE.test(text)) return '';
  return text;
}

// The incoming agent already receives the brief as its seed; this note is for the
// other agents in the session, who never see it.
async function noteHandoff({ worktreePath, fromMode, toMode, brief }) {
  if (!worktreePath || !brief || !enabled()) return null;
  try {
    const summary = usable(await runHeadless(handoffPrompt(fromMode, brief), toMode))
      || brief.slice(0, 1200);
    return writeSessionNote(worktreePath, {
      // Stable id, so a session handed back and forth replaces its note rather than stacking one per hop.
      id: `handoff-${fromMode}-to-${toMode}`,
      agent: fromMode || 'unknown',
      provider: 'klaussy',
      title: `Session handed off: ${displayNameFor(fromMode) || fromMode} → ${displayNameFor(toMode) || toMode}`,
      content: summary,
      tags: ['handoff'],
    });
  } catch (err) {
    console.warn('[session-activity] handoff note failed:', err && err.message);
    return null;
  }
}

function channelFor(worktreePath) {
  try {
    return ensureSessionNotesDir(worktreePath);
  } catch {
    return null;
  }
}

function liveAgentsByChannel(agents) {
  const byChannel = new Map();
  for (const a of agents || []) {
    if (!a || !a.alive || !a.worktreePath || a.mode === 'shell') continue;
    const channel = channelFor(a.worktreePath);
    if (!channel) continue;
    if (!byChannel.has(channel)) byChannel.set(channel, []);
    byChannel.get(channel).push(a);
  }
  return byChannel;
}

// The timer wants company (no point summarizing for nobody); a manual capture
// passes requireCompany:false, since the note stays for whoever joins later.
function eligibleAgents(agents, { requireCompany = true, worktreePath = null } = {}) {
  const byChannel = liveAgentsByChannel(agents);
  const wanted = worktreePath ? channelFor(worktreePath) : null;
  return [...byChannel.entries()]
    .filter(([channel]) => !wanted || channel === wanted)
    .map(([, group]) => group)
    .filter((group) => (requireCompany ? group.length > 1 : group.length > 0))
    .flat();
}

// Clean before diffing: recentOutput keeps TUI redraws that ANSI-stripping
// leaves behind, and a redraw rewrites lines in place so raw diffs lie.
function freshOutput(inst) {
  const current = cleanExcerpt(inst.recentOutput || '');
  const seen = lastSeen.get(inst.id) || '';
  const fresh = current.startsWith(seen) ? current.slice(seen.length) : current;
  return { fresh: fresh.trim(), current };
}

// Read per pass rather than at startup, so unchecking the pref stops the next
// one instead of needing a restart.
function enabled() {
  try {
    return loadConfig().sessionActivityNotes !== false;
  } catch {
    return true;
  }
}

async function captureActivity(agents, opts) {
  if (!enabled()) return [];
  if (capturing) return [];
  capturing = true;
  const written = [];
  try {
    for (const inst of eligibleAgents(agents, opts)) {
      const { fresh, current } = freshOutput(inst);
      if (fresh.length < MIN_NEW_OUTPUT_CHARS) continue;
      lastSeen.set(inst.id, current);
      const material = fresh.slice(-MAX_MATERIAL_CHARS);
      const summary = usable(await runHeadless(activityPrompt(inst.name, inst.mode, material), inst.mode));
      if (!summary) continue;
      try {
        written.push(writeSessionNote(inst.worktreePath, {
          // One note per terminal, replaced each pass, so a long session cannot flood the channel.
          id: `activity-${inst.id}`,
          agent: inst.mode || 'unknown',
          provider: 'klaussy',
          title: `Working in ${inst.name}`,
          content: summary,
          tags: ['activity'],
        }));
      } catch (err) {
        console.warn('[session-activity] note write failed:', err && err.message);
      }
    }
  } finally {
    capturing = false;
  }
  return written;
}

function start(getAgents) {
  stop();
  timer = setInterval(() => {
    Promise.resolve()
      .then(() => captureActivity(getAgents() || []))
      .catch((err) => console.warn('[session-activity] capture failed:', err && err.message));
  }, ACTIVITY_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

function forgetInstance(id) {
  lastSeen.delete(id);
}

module.exports = {
  noteHandoff,
  captureActivity,
  eligibleAgents,
  liveAgentsByChannel,
  channelFor,
  // Exported so the efficacy harness measures the prompt actually shipped.
  activityPrompt,
  start,
  stop,
  forgetInstance,
  ACTIVITY_INTERVAL_MS,
  MIN_NEW_OUTPUT_CHARS,
};
