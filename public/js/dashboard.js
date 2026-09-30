let charts = {};

function buildRangeOptions() {
  const now = new Date();
  const y = now.getFullYear();
  const select = document.getElementById('rangeSelect');
  // Nothing predates 2026, so years before it are never offered.
  const FIRST_DATA_YEAR = 2026;
  const options = [
    { value: 'this_month', label: `This Month (${now.toLocaleString('en-US', { month: 'long' })} ${y})` },
    { value: 'ytd', label: `Year to Date (${y})` },
    ...(y - 1 >= FIRST_DATA_YEAR ? [{ value: `year:${y - 1}`, label: `Full Year ${y - 1}` }] : []),
    { value: `year:${y}`, label: `Full Year ${y}` },
    { value: `year:${y + 1}`, label: `Full Year ${y + 1}` },
    { value: `year:${y + 2}`, label: `Full Year ${y + 2}` },
    { value: 'custom', label: 'Custom Range…' }
  ];
  select.innerHTML = options.map((o) => `<option value="${o.value}">${o.label}</option>`).join('');
  select.value = `year:${y}`;
}

function destroyCharts() {
  Object.values(charts).forEach((c) => c && c.destroy());
  charts = {};
}

function chartColors() {
  const v = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  return {
    deepBrown: v('--deep-brown', '#361C0E'),
    copperBark: v('--copper-bark', '#734423'),
    burntOrange: v('--burnt-orange', '#963F16'),
    cinnabar: v('--cinnabar', '#DD4F0A'),
    mineralSand: v('--mineral-sand', '#C2AF98'),
    beige: v('--beige', '#EFDDC9'),
    text: v('--deep-brown', '#361C0E'),
    grid: 'rgba(194, 175, 152, 0.4)'
  };
}

function chartFontDefaults(colors) {
  Chart.defaults.font.family = "'Jost', 'Segoe UI', sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.color = colors.text;
}

// GP is reported only across deals that have a cost captured — the sub-line says
// how much of the set that covers so a partial figure is never read as the whole.
function renderGpKpi(valueId, subId, gp) {
  const valueEl = document.getElementById(valueId);
  const subEl = document.getElementById(subId);
  if (!gp || gp.pricedCount === 0) {
    valueEl.textContent = '—';
    valueEl.classList.remove('negative');
    subEl.textContent = gp && gp.totalCount ? `No cost captured on ${gp.totalCount} deal${gp.totalCount === 1 ? '' : 's'}` : 'No deals in this period';
    return;
  }
  valueEl.textContent = money(gp.gp);
  valueEl.classList.toggle('negative', gp.gp < 0);
  const margin = gp.marginPct === null ? '—' : `${gp.marginPct.toFixed(1)}% margin`;
  const coverage = gp.pricedCount === gp.totalCount ? `all ${gp.totalCount}` : `${gp.pricedCount} of ${gp.totalCount}`;
  subEl.textContent = `${margin} · ${coverage} deal${gp.totalCount === 1 ? '' : 's'} costed`;
}

function renderNeedsAttention(items) {
  const body = document.getElementById('attentionBody');
  const card = document.getElementById('attentionCard');
  if (!body) return;

  card.classList.toggle('all-clear', items.length === 0);

  if (items.length === 0) {
    body.innerHTML =
      '<tr><td colspan="6" class="empty-state">Nothing overdue or gone quiet — every open deal has been touched recently.</td></tr>';
    return;
  }

  body.innerHTML = items
    .map((d) => {
      const why = d.reasons.map((r) => `<span class="reason ${r.code}">${r.label}</span>`).join(' ');
      const action = d.next_action
        ? `${escapeHtml(d.next_action)}${d.next_action_date ? `<div class="muted-note">due ${d.next_action_date}</div>` : ''}`
        : '<span class="muted-note">No next action set</span>';
      return `<tr>
        <td>${dealLink(d)}</td>
        <td class="num">${money(d.value)}</td>
        <td><span class="badge ${d.stage.replace(/\s+/g, '-')}">${d.stage}</span></td>
        <td>${why}</td>
        <td>${action}</td>
        <td>${escapeHtml(d.owner_name || '—')}</td>
      </tr>`;
    })
    .join('');
}

async function loadDashboard() {
  const select = document.getElementById('rangeSelect');
  const range = select.value;
  const customWrap = document.getElementById('customRangeWrap');
  customWrap.classList.toggle('hidden', range !== 'custom');
  if (range === 'custom' && (!document.getElementById('fromDate').value || !document.getElementById('toDate').value)) {
    return; // wait for Apply
  }

  let url = `/api/dashboard?range=${encodeURIComponent(range)}`;
  if (range === 'custom') {
    url += `&from=${document.getElementById('fromDate').value}&to=${document.getElementById('toDate').value}`;
  }

  const data = await api(url);
  const colors = chartColors();
  chartFontDefaults(colors);

  const pretty = (iso) =>
    new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  document.getElementById('rangeLabel').textContent = `${data.range.label} · ${pretty(data.range.from)} — ${pretty(data.range.to)}`;

  document.getElementById('kpiOpenValue').textContent = money(data.kpis.totalOpenValue);
  // Deals without a close date sit outside every period figure, so they are
  // named here rather than quietly excluded from the number above.
  const unscheduled = data.unscheduledOpenCount || 0;
  const openCountText = `${data.kpis.openCount} open deal${data.kpis.openCount === 1 ? '' : 's'} in this period`;
  document.getElementById('kpiOpenCount').textContent = unscheduled
    ? `${openCountText} · ${unscheduled} more with no close date (${money(data.unscheduledOpenValue)})`
    : openCountText;
  document.getElementById('kpiWeighted').textContent = money(data.kpis.weightedOpenValue);
  document.getElementById('kpiWon').textContent = money(data.kpis.wonValue);
  document.getElementById('kpiWonCount').textContent = `${data.kpis.wonCount} won deal${data.kpis.wonCount === 1 ? '' : 's'}`;

  renderNeedsAttention(data.needsAttention || []);
  renderGpKpi('kpiOpenGp', 'kpiOpenGpSub', data.kpis.openGp);
  renderGpKpi('kpiWonGp', 'kpiWonGpSub', data.kpis.wonGp);
  document.getElementById('kpiWinRate').textContent = data.kpis.winRate === null ? '—' : `${data.kpis.winRate.toFixed(0)}%`;
  document.getElementById('kpiLostSub').textContent = `${data.kpis.lostCount} lost · ${money(data.kpis.lostValue)}`;

  destroyCharts();

  const legend = { position: 'bottom', labels: { color: colors.text, boxWidth: 10, boxHeight: 10, padding: 16, usePointStyle: true, pointStyle: 'rect' } };
  const currencyTick = (value) => moneyCompact(value);

  // Gross profit rather than headline value: what the business keeps is the
  // number worth tracking month to month. Deals with no cost captured are
  // estimated at the house margin and the footnote says how many.
  const assumedPct = data.assumedGpMarginPct;
  const assumedTotal = data.monthly.reduce((n, m) => n + m.pipelineAssumed + m.wonAssumed, 0);
  const one = assumedTotal === 1;
  document.getElementById('chartNote').textContent = assumedTotal
    ? `* ${assumedTotal} deal${one ? '' : 's'} in this period ${one ? 'has' : 'have'} no cost recorded, so ${one ? 'its' : 'their'} gross profit is estimated at ${assumedPct}%.`
    : 'Every deal in this period has a cost recorded, so no gross profit here is estimated.';

  charts.monthly = new Chart(document.getElementById('chartMonthly'), {
    type: 'bar',
    data: {
      labels: data.monthly.map((m) => m.label),
      datasets: [
        { label: 'Pipeline GP', data: data.monthly.map((m) => m.pipelineGp), backgroundColor: colors.mineralSand },
        { label: 'Won GP', data: data.monthly.map((m) => m.wonGp), backgroundColor: colors.burntOrange }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend,
        tooltip: {
          callbacks: {
            label: (c) => {
              const row = data.monthly[c.dataIndex];
              const estimated = c.datasetIndex === 0 ? row.pipelineAssumed : row.wonAssumed;
              const total = c.datasetIndex === 0 ? row.pipeline : row.won;
              const mark = estimated ? ` * ${estimated} estimated at ${assumedPct}%` : '';
              return `${c.dataset.label}: ${money(c.parsed.y)} (on ${money(total)} of value)${mark}`;
            }
          }
        }
      },
      scales: {
        x: { ticks: { color: colors.text }, grid: { display: false }, border: { color: colors.grid } },
        y: { ticks: { color: colors.text, callback: currencyTick }, grid: { color: colors.grid }, border: { display: false } }
      }
    }
  });

  // stage ramp mirrors the badge progression: sand -> cinnabar heat
  const stageLabels = Object.keys(data.byStage);
  const stageRamp = {
    Lead: colors.beige,
    Qualified: colors.mineralSand,
    'Proposal Sent': colors.copperBark,
    Negotiation: colors.burntOrange
  };
  charts.stage = new Chart(document.getElementById('chartStage'), {
    type: 'doughnut',
    data: {
      labels: stageLabels,
      datasets: [{
        data: stageLabels.map((s) => data.byStage[s].value),
        backgroundColor: stageLabels.map((s) => stageRamp[s] || colors.mineralSand),
        borderColor: '#fff',
        borderWidth: 2
      }]
    },
    options: {
      cutout: '58%',
      plugins: { legend, tooltip: { callbacks: { label: (c) => `${c.label}: ${money(c.parsed)}` } } }
    }
  });

  // Enough distinct slices for every category. The last two are opacity tints
  // of palette colours rather than new hues, which the brand guidelines allow.
  const categoryColours = [
    colors.burntOrange,
    colors.copperBark,
    colors.mineralSand,
    colors.deepBrown,
    colors.cinnabar,
    colors.beige,
    'rgba(115, 68, 35, 0.55)',
    'rgba(150, 63, 22, 0.35)'
  ];

  const catLabels = Object.keys(data.byCategory).filter((c) => data.byCategory[c].value > 0);
  charts.category = new Chart(document.getElementById('chartCategory'), {
    type: 'doughnut',
    data: {
      labels: catLabels.length ? catLabels : ['No data'],
      datasets: [{
        data: catLabels.length ? catLabels.map((c) => data.byCategory[c].value) : [1],
        backgroundColor: catLabels.length
          ? catLabels.map((_, i) => categoryColours[i % categoryColours.length])
          : [colors.beige],
        borderColor: '#fff',
        borderWidth: 2
      }]
    },
    options: {
      cutout: '58%',
      plugins: { legend, tooltip: { callbacks: { label: (c) => `${c.label}: ${money(c.parsed)}` } } }
    }
  });

  renderDealTable('topDealsBody', 'topDealsFoot', 'topDealsNote', data.topOpenDeals, assumedPct, {
    empty: 'No open deals in this period',
    lastCell: (d) => `<span class="badge ${d.stage.replace(/\s+/g, '-')}">${d.stage}</span>`
  });

  renderDealTable('wonDealsBody', 'wonDealsFoot', 'wonDealsNote', data.recentWon, assumedPct, {
    empty: 'No confirmed deals in this period',
    lastCell: (d) => d.won_lost_date || '—'
  });
}

// Both deal tables, with margin and GP carried alongside the value. An
// estimated figure is marked at the point it is read rather than only in a
// note at the bottom, so a number is never taken for measured when it isn't.
function renderDealTable(bodyId, footId, noteId, deals, assumedPct, { empty, lastCell }) {
  const body = document.getElementById(bodyId);
  const foot = document.getElementById(footId);
  const note = document.getElementById(noteId);

  if (!deals.length) {
    body.innerHTML = `<tr><td colspan="5" class="empty-state">${empty}</td></tr>`;
    foot.innerHTML = '';
    note.textContent = '';
    return;
  }

  body.innerHTML = deals
    .map((d) => {
      const star = d.gpAssumed ? '<span class="gp-estimated" title="No cost recorded — estimated">*</span>' : '';
      const marginText = d.marginPct === null ? '—' : `${d.marginPct.toFixed(1)}%`;
      // an estimate is tinted as well as asterisked, so it is obvious at a
      // glance which rows still need a cost putting against them
      const tone = d.gpAssumed ? ' gp-is-estimated' : d.gp < 0 ? ' negative' : '';
      return `<tr>
        <td>${dealLink(d)}</td>
        <td class="num">${money(d.value)}</td>
        <td class="num gp-col${tone}">${marginText}${star}</td>
        <td class="num gp-col${tone}">${money(d.gp)}${star}</td>
        <td>${lastCell(d)}</td>
      </tr>`;
    })
    .join('');

  const totalValue = deals.reduce((s, d) => s + Number(d.value), 0);
  const totalGp = deals.reduce((s, d) => s + d.gp, 0);
  const blendedMargin = totalValue > 0 ? (totalGp / totalValue) * 100 : null;

  foot.innerHTML = `
    <td>Total of ${deals.length} shown</td>
    <td class="num">${money(totalValue)}</td>
    <td class="num gp-col">${blendedMargin === null ? '—' : blendedMargin.toFixed(1) + '%'}</td>
    <td class="num gp-col${totalGp < 0 ? ' negative' : ''}">${money(totalGp)}</td>
    <td></td>`;

  const estimated = deals.filter((d) => d.gpAssumed).length;
  note.textContent = estimated
    ? `* ${estimated} of these ${deals.length} ${estimated === 1 ? 'has' : 'have'} no cost recorded — gross profit estimated at ${assumedPct}%.`
    : '';
}

// Real anchors rather than click handlers: keyboard accessible and
// open-in-new-tab, with no extra code.
function dealLink(d) {
  return `<a class="deal-link" href="/deals.html?deal=${d.id}">${escapeHtml(d.customer_name)}</a>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

(async () => {
  const user = await requireSession();
  if (!user) return;
  renderTopbar('dashboard', user);
  await loadCurrency();
  buildRangeOptions();
  document.getElementById('rangeSelect').addEventListener('change', loadDashboard);
  document.getElementById('applyCustom').addEventListener('click', loadDashboard);
  await loadDashboard();
})();
