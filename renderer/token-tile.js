// Sidebar token-spend leaderboard.
//
// Pulls daily totals from the main process via `window.klaus.tokenUsage`,
// renders the live "Today" total, a tiny SVG bar chart over a selectable
// range, and the range total. Listens for `token-usage-updated` broadcasts
// so Today stays current while a session is streaming.

(function () {
  const todayEl = document.getElementById('token-tile-today-value');
  const totalEl = document.getElementById('token-tile-total');
  const rangeLabelEl = document.getElementById('token-tile-range-label');
  const rangeSel = document.getElementById('token-tile-range');
  const customWrap = document.getElementById('token-tile-custom');
  const fromInput = document.getElementById('token-tile-from');
  const toInput = document.getElementById('token-tile-to');
  const chart = document.getElementById('token-tile-chart');
  const agentsEl = document.getElementById('token-tile-agents');
  if (!todayEl || !rangeSel || !chart || !window.klaus || !window.klaus.tokenUsage) return;

  // Per-agent dot colors. Names come from the provider registry via AppUtils.
  const AGENT_COLORS = {
    claude: '#d97757', codex: '#10a37f', gemini: '#4285f4', copilot: '#8957e5',
  };
  function agentName(id) {
    return (window.AppUtils && AppUtils.modeDisplayName)
      ? AppUtils.modeDisplayName(id)
      : (id.charAt(0).toUpperCase() + id.slice(1));
  }
  function escHtml(s) {
    return (window.AppUtils && AppUtils.escHtml) ? AppUtils.escHtml(s) : String(s);
  }

  // Compact list of "● Agent  total" rows for the selected range. Hidden when
  // there's no usage to attribute.
  function renderAgents(byAgent) {
    if (!agentsEl) return;
    if (!byAgent || !byAgent.length) { agentsEl.innerHTML = ''; return; }
    agentsEl.innerHTML = byAgent.map(function (a) {
      var color = AGENT_COLORS[a.agent] || 'var(--accent)';
      return '<div class="token-agent-row">'
        + '<span class="token-agent-dot" style="background:' + color + '"></span>'
        + '<span class="token-agent-name">' + escHtml(agentName(a.agent)) + '</span>'
        + '<span class="token-agent-val">' + fmt(a.total) + '</span>'
      + '</div>';
    }).join('');
  }

  function fmt(n) {
    if (n == null || isNaN(n)) return '—';
    if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return String(n);
  }

  // SVG bar chart over a `series` of {day, tokens}. Uses viewBox coords
  // (200x60) so CSS scales it freely; bars share a fixed gap and grow to
  // fill the available height relative to the max value in the series.
  function renderChart(series) {
    while (chart.firstChild) chart.removeChild(chart.firstChild);
    if (!series.length) return;
    const W = 200, H = 60, PAD_TOP = 4, PAD_BOTTOM = 2;
    const max = series.reduce((m, p) => Math.max(m, p.tokens), 0) || 1;
    const usableH = H - PAD_TOP - PAD_BOTTOM;
    const slot = W / series.length;
    const barW = Math.max(0.5, slot * 0.78);
    const todayStr = todayKey();
    const nowHour = new Date().getHours();
    const ns = 'http://www.w3.org/2000/svg';
    for (let i = 0; i < series.length; i++) {
      const p = series[i];
      const h = (p.tokens / max) * usableH;
      const x = i * slot + (slot - barW) / 2;
      const y = PAD_TOP + (usableH - h);
      const r = document.createElementNS(ns, 'rect');
      r.setAttribute('x', x.toFixed(2));
      r.setAttribute('y', y.toFixed(2));
      r.setAttribute('width', barW.toFixed(2));
      r.setAttribute('height', Math.max(0.5, h).toFixed(2));
      r.setAttribute('rx', '0.5');
      // Hourly series highlight the current hour; daily series highlight today.
      const highlight = (p.hour != null) ? (p.hour === nowHour) : (p.day === todayStr);
      r.setAttribute('class', highlight ? 'token-tile-bar is-today' : 'token-tile-bar');
      const title = document.createElementNS(ns, 'title');
      title.textContent = `${p.day}: ${fmt(p.tokens)} tokens`;
      r.appendChild(title);
      chart.appendChild(r);
    }
  }

  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function currentSpec() {
    const v = rangeSel.value;
    if (v === 'custom') {
      const from = fromInput.value;
      const to = toInput.value;
      if (!from || !to) return null;
      return { kind: 'custom', from, to };
    }
    return { kind: 'preset', preset: v };
  }

  let inFlight = null;
  async function refresh() {
    const spec = currentSpec();
    if (!spec) return;
    const req = window.klaus.tokenUsage.range(spec);
    inFlight = req;
    let data;
    try { data = await req; } catch { return; }
    // A later refresh may have started while this one was waiting; drop the
    // stale result rather than flicker the chart back to old data.
    if (inFlight !== req) return;
    todayEl.textContent = fmt(data.today);
    totalEl.textContent = `${fmt(data.total)} total`;
    rangeLabelEl.textContent = spec.kind === 'custom'
      ? `${spec.from} → ${spec.to}`
      : ({ '1d': 'today', '7d': '7 days', '14d': '14 days', '30d': '30 days', '6m': '6 months', '1y': '1 year', 'all': 'all time' }[spec.preset] || '');
    renderChart(data.series || []);
    renderAgents(data.byAgent || []);
  }

  rangeSel.addEventListener('change', () => {
    const custom = rangeSel.value === 'custom';
    customWrap.style.display = custom ? '' : 'none';
    if (custom && !fromInput.value && !toInput.value) {
      const today = new Date();
      const monthAgo = new Date(today);
      monthAgo.setDate(monthAgo.getDate() - 29);
      const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      fromInput.value = iso(monthAgo);
      toInput.value = iso(today);
    }
    refresh();
  });
  fromInput.addEventListener('change', refresh);
  toInput.addEventListener('change', refresh);

  // Live updates: the main process pushes a fresh "today" number every
  // few seconds (and after IPC-driven rescans). We only update the Today
  // cell here — re-rendering the whole chart on every tick would feel
  // jumpy.
  window.klaus.tokenUsage.onUpdate(({ today }) => {
    todayEl.textContent = fmt(today);
  });

  // Initial pull. Wait a tick so the rest of the renderer has wired up;
  // the IPC rescan is async and we don't want to block first paint.
  setTimeout(refresh, 0);
})();
