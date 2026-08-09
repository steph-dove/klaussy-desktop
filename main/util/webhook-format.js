// Pure formatters: normalized Nemesis8 lifecycle event -> Slack / Discord
// webhook payloads. No electron, no network, no config — just data in, JSON
// body out — so the shapes are cheap to unit-test and the gateway
// (util/notification-gateway.js) only has to POST what these return.

const { EVENT_TYPES } = require('./nemesis-events');
const { cleanExcerpt } = require('./terminal-excerpt');
const md = require('./chat-markdown');

// Slack blocks and Discord embed descriptions both have hard size limits;
// agent log tails can be huge. Keep the last slice (the tail is where a crash
// reason or the pending prompt lives) and mark the truncation.
function truncateLogs(logs, max = 1200) {
  const s = cleanExcerpt(logs);
  if (s.length <= max) return s;
  // Cut at a line boundary — slicing mid-word left fragments like "ght for 5s)".
  const cut = s.slice(-max);
  const nl = cut.indexOf('\n');
  return '…(truncated)\n' + (nl > 0 && nl < 200 ? cut.slice(nl + 1) : cut);
}

// Break any triple-backtick run in log text so it can't close the code fence
// we wrap it in (a zero-width space keeps it looking the same to a reader).
function fenceSafe(s) {
  return String(s || '').replace(/```/g, '`​`​`');
}

// Head titles have hard caps — Slack rejects a header block over 150 chars and
// Discord an embed title over 256 — so a long agent name never nukes the whole
// message. Trim from the end since the lead ("<agent> …") is the important part.
function cap(str, max) {
  const s = String(str || '');
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function presentation(event) {
  switch (event.type) {
    case EVENT_TYPES.COMPLETED:
      return { emoji: '✅', verb: 'completed', color: 0x2eb67d };
    case EVENT_TYPES.FAILED:
      return { emoji: '❌', verb: 'failed', color: 0xe01e5a };
    case EVENT_TYPES.APPROVAL_REQUIRED:
      return { emoji: '⏸️', verb: 'needs approval', color: 0xecb22e };
    case EVENT_TYPES.STALE:
      return { emoji: '💤', verb: 'has gone quiet', color: 0x8e9aaf };
    default:
      return { emoji: '🔔', verb: event.type, color: 0x1d9bd1 };
  }
}

function agentLabel(event) {
  const agent = event.agentName || 'Agent';
  return event.sessionName ? `${agent} on “${event.sessionName}”` : agent;
}

// What of the terminal is worth showing: a framebuffer of box drawing and
// half-typed words tells the reader nothing.
function screenExcerpt(event) {
  if (ended(event) || event.promptQuestion) return '';
  const cleaned = truncateLogs(event.logsTail);
  if (!cleaned) return '';
  const lines = cleaned.split('\n').filter((l) => l.trim());
  // Prose, not chrome: a screen of rules and stubs has almost no real words.
  const wordy = lines.filter((l) => (l.match(/[A-Za-z]{3,}/g) || []).length >= 3);
  if (wordy.length < 2) return '';
  return wordy.slice(-12).join('\n');
}

function ended(event) {
  return event.type === EVENT_TYPES.COMPLETED || event.type === EVENT_TYPES.FAILED;
}

// Only for an ended session: on an approval the agent is still waiting, so
// restart steps would misrepresent it.
function restartSteps(event) {
  if (!ended(event) || !event.resumeCommand) return '';
  const lines = [];
  if (event.workspacePath) lines.push(`cd ${event.workspacePath}`);
  lines.push(event.resumeCommand);
  return lines.join('\n');
}

function quietFor(event) {
  const ms = Number(event.quietMs);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  // Gate on the raw value: rounding first turns 45s into "1m".
  if (ms < 60000) return ` — no output for ${Math.round(ms / 1000)}s`;
  return ` — no output for ${Math.round(ms / 60000)}m`;
}

function headline(event, p) {
  if (event.type === EVENT_TYPES.APPROVAL_REQUIRED) {
    // The specific tool goes in the fields (it can be a long command line and
    // would blow the header length cap); the title stays short and stable.
    return `${agentLabel(event)} is paused — waiting for approval`;
  }
  if (event.type === EVENT_TYPES.FAILED) {
    const code = event.exitCode != null ? ` (exit ${event.exitCode})` : '';
    return `${agentLabel(event)} ${p.verb}${code}`;
  }
  if (event.type === EVENT_TYPES.STALE) {
    return `${agentLabel(event)} ${p.verb}${quietFor(event)}`;
  }
  return `${agentLabel(event)} ${p.verb}`;
}

function formatSlack(event) {
  // A mirrored turn is the agent talking, not an alert about it.
  if (event.type === EVENT_TYPES.MESSAGE) {
    // Not fenced: the agent wrote markdown, and a fence shows its source.
    const body = md.forSlack(event.body);
    return {
      text: `${event.agentName || 'Agent'}: ${body.replace(/[*_`]/g, '').slice(0, 120)}`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: body } }],
    };
  }
  const p = presentation(event);
  const title = cap(`${p.emoji} ${headline(event, p)}`, 150);

  const fields = [];
  if (event.workspacePath) fields.push({ type: 'mrkdwn', text: `*Workspace:*\n\`${event.workspacePath}\`` });
  if (event.containerId) fields.push({ type: 'mrkdwn', text: `*Container:*\n\`${event.containerId}\`` });
  if (event.sessionId) fields.push({ type: 'mrkdwn', text: `*Agent session:*\n\`${event.sessionId}\`` });
  if (event.type === EVENT_TYPES.APPROVAL_REQUIRED && (event.tool || event.step)) {
    fields.push({ type: 'mrkdwn', text: `*Awaiting approval:*\n\`${event.tool || event.step}\`` });
  }

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: title, emoji: true } },
  ];
  if (fields.length) blocks.push({ type: 'section', fields });

  if (event.type === EVENT_TYPES.APPROVAL_REQUIRED) {
    if (event.approvalToken && event.options && event.options.length) {
      // One button per menu option, so choices beyond yes/no are reachable.
      blocks.push({
        type: 'actions',
        block_id: 'klaussy_approval',
        elements: event.options.map((o, i) => ({
          type: 'button',
          action_id: 'klaussy_choice_' + o.key,
          ...(i === 0 ? { style: 'primary' } : {}),
          text: { type: 'plain_text', text: `${o.key}. ${o.label}`.slice(0, 75) },
          value: `${event.approvalToken}:${o.key}`,
        })),
      });
      if (event.optionsTruncated) {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: '_More options exist — answer in Klaussy to see them all._' }],
        });
      }
    } else if (event.approvalToken && !event.menuPrompt) {
      blocks.push({
        type: 'actions',
        block_id: 'klaussy_approval',
        elements: [
          {
            type: 'button', action_id: 'klaussy_approve', style: 'primary',
            text: { type: 'plain_text', text: 'Approve' },
            value: event.approvalToken,
          },
          {
            type: 'button', action_id: 'klaussy_reject', style: 'danger',
            text: { type: 'plain_text', text: 'Reject' },
            value: event.approvalToken,
          },
        ],
      });
    } else {
      blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: 'Respond in Klaussy to *Approve* or *Reject* this step.' }],
      });
    }
  }

  if (event.promptQuestion) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: fenceSafe(event.promptQuestion) } });
  }
  const logs = screenExcerpt(event);
  if (logs) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '```' + fenceSafe(logs) + '```' } });

  const steps = restartSteps(event);
  if (steps) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: (event.resumeExact ? '*Pick it back up:*\n' : '*Start it again:*\n')
          + '```' + fenceSafe(steps) + '```',
      },
    });
  }

  // `text` is the notification fallback Slack shows in the sidebar / on mobile.
  return { text: title, blocks };
}

function formatDiscord(event) {
  if (event.type === EVENT_TYPES.MESSAGE) {
    return { content: md.forDiscord(event.body) };
  }
  const p = presentation(event);
  const title = cap(`${p.emoji} ${headline(event, p)}`, 256);

  const fields = [];
  if (event.workspacePath) fields.push({ name: 'Workspace', value: '`' + event.workspacePath + '`' });
  if (event.containerId) fields.push({ name: 'Container', value: '`' + event.containerId + '`' });
  if (event.sessionId) fields.push({ name: 'Agent session', value: '`' + event.sessionId + '`' });
  if (event.type === EVENT_TYPES.APPROVAL_REQUIRED && (event.tool || event.step)) {
    fields.push({ name: 'Awaiting approval', value: '`' + (event.tool || event.step) + '`' });
  }

  const parts = [];
  const interactive = event.type === EVENT_TYPES.APPROVAL_REQUIRED && event.approvalToken;
  if (event.type === EVENT_TYPES.APPROVAL_REQUIRED && !interactive) {
    parts.push('Respond in Klaussy to **Approve** or **Reject** this step.');
  }
  if (event.promptQuestion) parts.push(fenceSafe(event.promptQuestion));
  const logs = screenExcerpt(event);
  if (logs) parts.push('```\n' + fenceSafe(logs) + '\n```');

  const steps = restartSteps(event);
  if (steps) {
    parts.push((event.resumeExact ? '**Pick it back up:**' : '**Start it again:**')
      + '\n```\n' + fenceSafe(steps) + '\n```');
  }

  const embed = { title, color: p.color };
  if (parts.length) embed.description = parts.join('\n');
  if (fields.length) embed.fields = fields;

  const payload = { embeds: [embed] };
  if (interactive) {
    // custom_id is the only state Discord hands back on a click, so the token
    // and the chosen key ride in it. Style 1 = blurple, 3 = green, 4 = red.
    const buttons = (event.options && event.options.length)
      ? event.options.map((o, i) => ({
        type: 2,
        style: i === 0 ? 3 : 1,
        label: `${o.key}. ${o.label}`.slice(0, 80),
        custom_id: `klaussy_choice:${event.approvalToken}:${o.key}`,
      }))
      : (event.menuPrompt ? [] : [
        { type: 2, style: 3, label: 'Approve', custom_id: 'klaussy_approve:' + event.approvalToken },
        { type: 2, style: 4, label: 'Reject', custom_id: 'klaussy_reject:' + event.approvalToken },
      ]);
    if (buttons.length) payload.components = [{ type: 1, components: buttons }];
  }
  return payload;
}

module.exports = { formatSlack, formatDiscord, truncateLogs };
