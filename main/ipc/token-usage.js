// Token-usage IPC: serves the sidebar leaderboard tile.
//
// `range` returns { today, series:[{day,tokens}], total } for one of the
// preset ranges (7d / 14d / 30d / 6m / 1y / all) or a custom { from, to }
// pair, served from the cache. After each rescan (see startAutoRescan) the
// today total is pushed to every window as `token-usage-updated`.

const { ipcMain } = require('electron');
const tokenUsage = require('../state/token-usage');
const { allWindows } = require('../state/windows');

// Build a list of YYYY-MM-DD strings from `start` (inclusive) up to and
// including `end`, in local time. Both args are Date objects.
function daysBetween(start, end) {
  const out = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cur <= last) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, '0');
    const d = String(cur.getDate()).padStart(2, '0');
    out.push(`${y}-${m}-${d}`);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function rangeBounds(spec) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!spec || spec.kind === 'preset') {
    const preset = spec && spec.preset;
    if (preset === 'all') return { from: null, to: today };
    const days = { '1d': 0, '7d': 6, '14d': 13, '30d': 29, '6m': 182, '1y': 364 }[preset];
    if (days == null) return { from: null, to: today }; // unknown preset → all-time
    const from = new Date(today);
    from.setDate(from.getDate() - days);
    return { from, to: today };
  }
  if (spec.kind === 'custom' && spec.from && spec.to) {
    return { from: new Date(spec.from), to: new Date(spec.to) };
  }
  return { from: null, to: today };
}

// Local YYYY-MM-DD for a Date (matches the keys in the day maps).
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Sum each agent's tokens within [from, to] (all-time if from is null).
// Returns [{ agent, total }] sorted desc, omitting agents with no usage.
function byAgentTotals(byAgent, from, to) {
  const lo = from ? ymd(from) : null;
  const hi = ymd(to);
  const out = [];
  for (const [agent, days] of Object.entries(byAgent || {})) {
    let total = 0;
    for (const [day, tokens] of Object.entries(days)) {
      if (lo && (day < lo || day > hi)) continue;
      total += tokens;
    }
    if (total > 0) out.push({ agent, total });
  }
  out.sort((a, b) => b.total - a.total);
  return out;
}

function buildSeries(days, from, to) {
  if (!from) {
    // All-time: emit the days we actually have, in chronological order.
    const keys = Object.keys(days).sort();
    return keys.map((day) => ({ day, tokens: days[day] }));
  }
  return daysBetween(from, to).map((day) => ({ day, tokens: days[day] || 0 }));
}

ipcMain.handle('token-usage:range', async (_event, spec) => {
  const snap = tokenUsage.snapshot();
  const byAgentSnap = tokenUsage.snapshotByAgent();
  const today = snap[tokenUsage.todayKey()] || 0;

  // 1-day view: bucket today's usage by local hour (24 bars) instead of a
  // single day bar, with the per-agent breakdown scoped to today.
  if (spec && spec.kind === 'preset' && spec.preset === '1d') {
    const { hours, byAgent } = await tokenUsage.todayByHour();
    const series = hours.map((tokens, h) => ({
      day: String(h).padStart(2, '0') + ':00', tokens, hour: h,
    }));
    const total = hours.reduce((a, b) => a + b, 0);
    const byAgentArr = Object.entries(byAgent)
      .filter(([, t]) => t > 0)
      .map(([agent, t]) => ({ agent, total: t }))
      .sort((a, b) => b.total - a.total);
    return { today, series, total, byAgent: byAgentArr, granularity: 'hour' };
  }

  const { from, to } = rangeBounds(spec);
  const series = buildSeries(snap, from, to);
  const total = series.reduce((acc, p) => acc + p.tokens, 0);
  const byAgent = byAgentTotals(byAgentSnap, from, to);
  return { today, series, total, byAgent, granularity: 'day' };
});

function broadcastUpdate() {
  const days = tokenUsage.snapshot();
  const today = days[tokenUsage.todayKey()] || 0;
  for (const win of allWindows) {
    if (!win.isDestroyed()) {
      win.webContents.send('token-usage-updated', { today });
    }
  }
}

// whenReady: the cache writer needs app.getPath.
const { app } = require('electron');
app.whenReady().then(() => tokenUsage.startAutoRescan(broadcastUpdate));
