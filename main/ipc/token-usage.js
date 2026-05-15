// Token-usage IPC: serves the sidebar leaderboard tile.
//
// `range` returns { today, series:[{day,tokens}], total } for one of the
// preset ranges (7d / 14d / 30d / 6m / 1y / all) or a custom { from, to }
// pair. The handler always triggers a rescan first so live sessions appear
// without waiting for the periodic broadcast tick.
//
// The 60s broadcast loop runs a rescan and pushes `token-usage-updated` to
// every window so the today total stays current while the user is in the
// app.

const { ipcMain } = require('electron');
const tokenUsage = require('../state/token-usage');
const { allWindows } = require('../state/windows');

const BROADCAST_INTERVAL_MS = 60_000;

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
    const days = { '7d': 6, '14d': 13, '30d': 29, '6m': 182, '1y': 364 }[preset];
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

function buildSeries(days, from, to) {
  if (!from) {
    // All-time: emit the days we actually have, in chronological order.
    const keys = Object.keys(days).sort();
    return keys.map((day) => ({ day, tokens: days[day] }));
  }
  return daysBetween(from, to).map((day) => ({ day, tokens: days[day] || 0 }));
}

// First scan on big histories (~hundreds of MB of JSONL) can take seconds.
// Return the cached snapshot synchronously and let the rescan finish in the
// background — the broadcast loop will push the updated total when it's
// done. Renderers always get a fast response; freshness is bounded by the
// 60s broadcast cadence and any new range request.
ipcMain.handle('token-usage:range', async (_event, spec) => {
  const snap = tokenUsage.snapshot();
  tokenUsage.rescan().catch((err) => {
    console.error('[token-usage] background rescan failed:', err.message);
  });
  const { from, to } = rangeBounds(spec);
  const series = buildSeries(snap, from, to);
  const today = snap[tokenUsage.todayKey()] || 0;
  const total = series.reduce((acc, p) => acc + p.tokens, 0);
  return { today, series, total };
});

// Background broadcast. Independent of any open handler so the tile stays
// live even when the renderer hasn't requested a range recently.
function broadcastUpdate() {
  const days = tokenUsage.snapshot();
  const today = days[tokenUsage.todayKey()] || 0;
  for (const win of allWindows) {
    if (!win.isDestroyed()) {
      win.webContents.send('token-usage-updated', { today });
    }
  }
}

setInterval(async () => {
  try { await tokenUsage.rescan(); } catch { /* logged in state module */ }
  broadcastUpdate();
}, BROADCAST_INTERVAL_MS).unref();

// Warm the cache at app start so the first IPC call has data to serve.
// Fired through whenReady because the cache writer needs app.getPath. The
// promise is intentionally unawaited; the broadcast loop will pick up the
// result whenever it finishes.
const { app } = require('electron');
app.whenReady().then(() => {
  tokenUsage.rescan().then(broadcastUpdate).catch((err) => {
    console.error('[token-usage] initial scan failed:', err.message);
  });
});
