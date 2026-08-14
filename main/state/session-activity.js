// Agents only volunteer session notes for runtime triggers they recognise (ports,
// schemas, env vars), so klaussy writes them itself at the two moments they miss:
// a session changing hands, and two agents live on the same channel.

const { writeSessionNote, ensureSessionNotesDir } = require('./session-context');
const { runHeadless } = require('./session-handoff');
const { displayNameFor } = require('./ai-providers');

const ACTIVITY_INTERVAL_MS = 5 * 60 * 1000;
// Below this an agent has produced nothing worth another agent's context.
const MIN_NEW_OUTPUT_CHARS = 400;
const MAX_MATERIAL_CHARS = 6000;
const NOTHING_MARKER = 'NOTHING';

// instance id -> the output we last summarized, so each pass sees only what is new.
const lastSeen = new Map();
let timer = null;
let capturing = false;

function activityPrompt(name, mode, material) {
  return 'Another AI agent is working in a different terminal of this same session.'
    + ` Below is recent terminal output from ${displayNameFor(mode) || mode} in "${name}".\n\n`
    + 'Write a short note ONLY if it contains something that agent would otherwise'
    + ' discover the hard way: a decision or approach settled on, a file or area now'
    + ' being restructured, a port/schema/env change, or work they would duplicate.'
    + ` If there is nothing of that kind, reply with exactly ${NOTHING_MARKER}.\n\n`
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

function usable(summary) {
  const text = (summary || '').trim();
  if (!text || text.length < 20) return '';
  // The model was told to say NOTHING; accept that verdict however it phrases it.
  if (new RegExp(`^${NOTHING_MARKER}\\b`, 'i').test(text)) return '';
  return text;
}

// The incoming agent already receives the brief as its seed; this note is for the
// other agents in the session, who never see it.
async function noteHandoff({ worktreePath, fromMode, toMode, brief }) {
  if (!worktreePath || !brief) return null;
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

// A lone agent has nobody to tell, so only channels with two or more are worth summarizing.
function agentsWithCompany(agents) {
  const byChannel = new Map();
  for (const a of agents) {
    if (!a || !a.alive || !a.worktreePath || a.mode === 'shell') continue;
    const channel = channelFor(a.worktreePath);
    if (!channel) continue;
    if (!byChannel.has(channel)) byChannel.set(channel, []);
    byChannel.get(channel).push(a);
  }
  return [...byChannel.values()].filter((group) => group.length > 1).flat();
}

function freshOutput(inst) {
  const current = inst.recentOutput || '';
  const seen = lastSeen.get(inst.id) || '';
  // The buffer is a rolling window, so a prefix mismatch means it scrolled and all of it is new.
  const fresh = current.startsWith(seen) ? current.slice(seen.length) : current;
  return fresh.trim();
}

async function captureActivity(agents) {
  if (capturing) return [];
  capturing = true;
  const written = [];
  try {
    for (const inst of agentsWithCompany(agents)) {
      const fresh = freshOutput(inst);
      if (fresh.length < MIN_NEW_OUTPUT_CHARS) continue;
      lastSeen.set(inst.id, inst.recentOutput || '');
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
  start,
  stop,
  forgetInstance,
  ACTIVITY_INTERVAL_MS,
  MIN_NEW_OUTPUT_CHARS,
};
