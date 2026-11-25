// Copyright 2026 Dovatech LLC. SPDX-License-Identifier: LicenseRef-Sustainable-Use-1.0
// Which Preferences changes need the person's OK (confirm-sensitive.js), and the
// masking that keeps saved tokens out of the page.
//
// A change needs an OK when it makes the app run something new or send data
// somewhere new: an agent binary path, kimi's autonomous bash turned on, a
// webhook, bot token or channel, who may reply through chat, two-way buttons
// turned on, a Nemesis gateway address. Clearing one of these never asks: it
// can only stop something.
//
// Preferences saves every field on each keystroke pause, so changes are held
// until they stop changing (SETTLE_MS), then asked about together, once. A "no"
// is remembered for that exact value, so the next keystroke's save doesn't ask
// again; the window is told to put the saved value back.

const SETTLE_MS = 1500;

const AGENT_PATH_KEYS = [
  'claudePath', 'codexPath', 'antigravityPath', 'copilotPath', 'cursorPath',
  'clinePath', 'opencodePath', 'kimiPath', 'aiderPath',
];

const GATEWAY_FIELDS = {
  slackWebhookUrl: 'Slack webhook URL',
  discordWebhookUrl: 'Discord webhook URL',
  nemesisUrl: 'Nemesis event URL',
  slackAppToken: 'Slack app token',
  slackBotToken: 'Slack bot token',
  slackChannel: 'Slack channel',
  discordBotToken: 'Discord bot token',
  discordChannel: 'Discord channel',
};
const GATEWAY_TOKENS = new Set(['slackAppToken', 'slackBotToken', 'discordBotToken']);
const GATEWAY_SWITCHES = { slackInteractive: 'Slack approve/reject buttons', discordInteractive: 'Discord approve/reject buttons' };

// ---- masking -------------------------------------------------------------------

const MASK = '•'.repeat(8);
function maskToken(t) {
  const s = typeof t === 'string' ? t : '';
  return s ? MASK + s.slice(-4) : '';
}
// What a token field from the page means: the saved token when it's the saved
// token's mask, otherwise what was typed.
function unmaskToken(incoming, saved) {
  if (typeof incoming !== 'string') return incoming;
  if (saved && incoming === maskToken(saved)) return saved;
  return incoming;
}
const isMasked = (t) => typeof t === 'string' && t.startsWith(MASK);

function maskGateway(ng) {
  const out = { ...ng };
  for (const k of GATEWAY_TOKENS) if (out[k]) out[k] = maskToken(out[k]);
  return out;
}
function maskProfiles(profiles) {
  return (profiles || []).map((p) => ({ ...p, token: maskToken(p.token) }));
}

// ---- what needs asking -----------------------------------------------------------

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Changes in `prefs` (what the page sent) against `config` (what's saved) that
// need an OK. Each: { key, label, value, shown }. `kimiGranted` is whether
// kimi's autonomous bash is on now. Token fields are unmasked first.
function sensitiveChanges(prefs, config, { kimiGranted = false } = {}) {
  const out = [];
  for (const key of AGENT_PATH_KEYS) {
    if (prefs[key] === undefined) continue;
    const v = str(prefs[key]);
    if (v && v !== str(config[key])) {
      out.push({ key, label: `${key.replace(/Path$/, '')} agent path`, value: v, shown: v });
    }
  }
  if (prefs.kimiAutonomousBash === true && !kimiGranted) {
    out.push({ key: 'kimiAutonomousBash', label: 'Kimi may run shell commands without asking', value: true, shown: 'on' });
  }
  const ng = prefs.notificationGateway;
  if (ng && typeof ng === 'object') {
    const prev = config.notificationGateway || {};
    for (const [k, label] of Object.entries(GATEWAY_FIELDS)) {
      if (ng[k] === undefined) continue;
      const v = str(GATEWAY_TOKENS.has(k) ? unmaskToken(ng[k], prev[k]) : ng[k]);
      // A mask that isn't the saved token's is never a token; withoutChanges drops it.
      if (GATEWAY_TOKENS.has(k) && isMasked(v)) continue;
      if (v && v !== str(prev[k])) {
        out.push({ key: `ng.${k}`, label, value: v, shown: GATEWAY_TOKENS.has(k) ? maskToken(v) : v });
      }
    }
    if (Array.isArray(ng.allowList)) {
      const next = ng.allowList.map(String).map((s) => s.trim()).filter(Boolean);
      const before = Array.isArray(prev.allowList) ? prev.allowList.map(String) : [];
      const added = next.filter((x) => !before.includes(x));
      if (added.length) out.push({ key: 'ng.allowList', label: 'Who may reply through chat', value: next, shown: `adds ${added.join(', ')}` });
    }
    for (const [k, label] of Object.entries(GATEWAY_SWITCHES)) {
      if (ng[k] === true && prev[k] !== true) out.push({ key: `ng.${k}`, label, value: true, shown: 'on' });
    }
  }
  if (Array.isArray(prefs.nemesisProfiles)) {
    const saved = new Map((config.nemesisProfiles || []).map((p) => [p && p.id, p]));
    const legacyRemote = !config.nemesisProfiles ? str(config.nemesisRemote) : '';
    prefs.nemesisProfiles.forEach((p, i) => {
      const id = String((p && p.id) || `n8-${i}`);
      const v = str(p && p.remote);
      const before = saved.has(id) ? str(saved.get(id).remote) : (i === 0 ? legacyRemote : '');
      if (v && v !== before) {
        out.push({ key: `nemesis.${id}.remote`, label: `Nemesis gateway "${str(p && p.name) || id}"`, value: v, shown: v });
      }
    });
  }
  return out;
}

// `prefs` with every change in `changes` put back to its saved value, so the
// rest of set-preferences can save it without them. Tokens are unmasked too, so
// a mask is never stored.
function withoutChanges(prefs, config, changes) {
  const held = new Set(changes.map((c) => c.key));
  const out = { ...prefs };
  for (const key of AGENT_PATH_KEYS) if (held.has(key)) delete out[key];
  if (held.has('kimiAutonomousBash')) delete out.kimiAutonomousBash;
  if (out.notificationGateway && typeof out.notificationGateway === 'object') {
    const prev = config.notificationGateway || {};
    const ng = { ...out.notificationGateway };
    for (const k of GATEWAY_TOKENS) {
      if (ng[k] === undefined) continue;
      ng[k] = unmaskToken(ng[k], prev[k]);
      if (isMasked(ng[k])) { if (prev[k] === undefined) delete ng[k]; else ng[k] = prev[k]; }
    }
    for (const k of [...Object.keys(GATEWAY_FIELDS), ...Object.keys(GATEWAY_SWITCHES), 'allowList']) {
      if (held.has(`ng.${k}`)) {
        if (prev[k] === undefined) delete ng[k]; else ng[k] = prev[k];
      }
    }
    out.notificationGateway = ng;
  }
  if (Array.isArray(out.nemesisProfiles)) {
    const saved = new Map((config.nemesisProfiles || []).map((p) => [p && p.id, p]));
    out.nemesisProfiles = out.nemesisProfiles.map((p, i) => {
      const id = String((p && p.id) || `n8-${i}`);
      const old = saved.get(id) || {};
      let token = unmaskToken(p && p.token, old.token);
      if (isMasked(token)) token = old.token || '';
      const q = { ...p, token };
      if (held.has(`nemesis.${id}.remote`)) q.remote = old.remote || '';
      return q;
    });
  }
  return out;
}

// Writes allowed changes into `config` (kimi's switch is the caller's job).
function applyChanges(config, changes) {
  for (const c of changes) {
    if (AGENT_PATH_KEYS.includes(c.key)) config[c.key] = c.value;
    else if (c.key.startsWith('ng.')) {
      config.notificationGateway = { ...(config.notificationGateway || {}), [c.key.slice(3)]: c.value };
    } else if (c.key.startsWith('nemesis.')) {
      const id = c.key.slice('nemesis.'.length, -'.remote'.length);
      const list = Array.isArray(config.nemesisProfiles) ? config.nemesisProfiles : [];
      const p = list.find((x) => x && x.id === id);
      if (p) p.remote = c.value;
    }
  }
  return config;
}

// ---- holding, asking, remembering -------------------------------------------------

// confirm({title, lines}) -> Promise<boolean>; onDecision(allowed, changes) applies
// or reverts. One instance per app.
class SensitiveGate {
  constructor({ confirm, onDecision, settleMs = SETTLE_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.confirm = confirm;
    this.onDecision = onDecision;
    this.settleMs = settleMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.pending = new Map();  // key -> change, waiting for edits to stop
    this.refused = new Map();  // key -> value the person said no to
    this.timer = null;
    this.asking = false;
  }

  // Takes the changes from one save and the keys that save mentioned at all.
  // Returns { pending: [labels], refused: [labels] } for the window to show.
  offer(changes, mentionedKeys = null) {
    const now = new Map(changes.map((c) => [c.key, c]));
    // A field that went back to its saved value stops waiting.
    for (const key of [...this.pending.keys()]) {
      if (!now.has(key) && (!mentionedKeys || mentionedKeys.has(key))) this.pending.delete(key);
    }
    for (const key of [...this.refused.keys()]) {
      if (!now.has(key) && (!mentionedKeys || mentionedKeys.has(key))) this.refused.delete(key);
    }
    const refusedLabels = [];
    for (const c of changes) {
      if (this.refused.has(c.key) && same(this.refused.get(c.key), c.value)) {
        refusedLabels.push(c.label);
        continue;
      }
      this.refused.delete(c.key);
      this.pending.set(c.key, c);
    }
    if (this.pending.size && !this.asking) {
      if (this.timer) this.clearTimer(this.timer);
      this.timer = this.setTimer(() => this.ask(), this.settleMs);
      this.timer?.unref?.();
    }
    return { pending: [...this.pending.values()].map((c) => c.label), refused: refusedLabels };
  }

  async ask() {
    this.timer = null;
    if (!this.pending.size || this.asking) return;
    const batch = [...this.pending.values()];
    this.pending.clear();
    this.asking = true;
    let allowed = false;
    try {
      allowed = await this.confirm({
        title: batch.length === 1 ? `Allow this change to Maussian’s settings?` : `Allow these ${batch.length} changes to Maussian’s settings?`,
        lines: batch.map((c) => `${c.label}: ${c.shown}`),
      });
    } finally {
      this.asking = false;
    }
    if (!allowed) for (const c of batch) this.refused.set(c.key, c.value);
    try { await this.onDecision(allowed, batch); } catch (err) {
      console.warn('[sensitive-prefs] applying the decision failed:', err && err.message);
    }
    // Edits that came in while the question was up get their own question.
    if (this.pending.size) {
      this.timer = this.setTimer(() => this.ask(), this.settleMs);
      this.timer?.unref?.();
    }
  }
}

// The gate keys a save mentions, so a partial save (agent-split's one field)
// doesn't cancel a pending change to a field it didn't send.
function mentionedKeys(prefs) {
  const keys = new Set();
  for (const k of AGENT_PATH_KEYS) if (prefs[k] !== undefined) keys.add(k);
  if (prefs.kimiAutonomousBash !== undefined) keys.add('kimiAutonomousBash');
  const ng = prefs.notificationGateway;
  if (ng && typeof ng === 'object') {
    for (const k of [...Object.keys(GATEWAY_FIELDS), ...Object.keys(GATEWAY_SWITCHES), 'allowList']) {
      if (ng[k] !== undefined) keys.add(`ng.${k}`);
    }
  }
  if (Array.isArray(prefs.nemesisProfiles)) {
    prefs.nemesisProfiles.forEach((p, i) => keys.add(`nemesis.${String((p && p.id) || `n8-${i}`)}.remote`));
  }
  return keys;
}

module.exports = {
  SETTLE_MS, AGENT_PATH_KEYS, GATEWAY_TOKENS, MASK,
  maskToken, unmaskToken, isMasked, maskGateway, maskProfiles,
  sensitiveChanges, withoutChanges, applyChanges, mentionedKeys, SensitiveGate,
};
