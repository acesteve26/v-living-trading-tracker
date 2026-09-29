function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const pretty = (s) =>
  s ? new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

// Weeks run Monday to Sunday, which is how the business reads a week.
function startOfWeek(d) {
  const copy = new Date(d);
  const day = (copy.getDay() + 6) % 7; // Monday = 0
  copy.setDate(copy.getDate() - day);
  return copy;
}

function resolvePeriod(key) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();

  if (key === 'this_week') {
    const from = startOfWeek(now);
    const to = new Date(from);
    to.setDate(to.getDate() + 6);
    return { from: iso(from), to: iso(to), label: 'This Week' };
  }
  if (key === 'last_week') {
    const from = startOfWeek(now);
    from.setDate(from.getDate() - 7);
    const to = new Date(from);
    to.setDate(to.getDate() + 6);
    return { from: iso(from), to: iso(to), label: 'Last Week' };
  }
  if (key === 'this_month') return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)), label: 'This Month' };
  if (key === 'last_month') return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)), label: 'Last Month' };
  if (key === 'this_quarter') {
    const q = Math.floor(m / 3);
    return { from: iso(new Date(y, q * 3, 1)), to: iso(new Date(y, q * 3 + 3, 0)), label: `Q${q + 1} ${y}` };
  }
  if (key === 'this_year') return { from: iso(new Date(y, 0, 1)), to: iso(now), label: `Year to Date ${y}` };
  return null; // custom
}

// Overheads for the same dates, reported on their own terms. No net-of-GP
// figure is shown anywhere: an expense is not a deal cost, and putting the two
// in one number would invite reading it as deal performance.
function renderExpenses(data) {
  const ex = data.expenses || { items: [], total: 0, count: 0, byCategory: {} };

  const ranked = Object.entries(ex.byCategory)
    .filter(([, v]) => v.count > 0)
    .sort((a, b) => b[1].total - a[1].total);

  const biggest = ranked.length ? ranked[0] : null;

  document.getElementById('expenseRow').innerHTML = [
    stat('Total expenses', money(ex.total), `${ex.count} item${ex.count === 1 ? '' : 's'} in period`),
    stat(
      'Largest category',
      biggest ? biggest[0] : '—',
      biggest ? `${money(biggest[1].total)} · ${Math.round((biggest[1].total / ex.total) * 100)}% of the total` : 'Nothing recorded'
    ),
    stat('Categories used', String(ranked.length), `of ${Object.keys(ex.byCategory).length} available`)
  ].join('');

  document.getElementById('expenseCategoryBody').innerHTML = ranked.length
    ? ranked
        .map(
          ([name, v]) => `<tr>
            <td>${escapeHtml(name)}</td>
            <td class="num">${v.count}</td>
            <td class="num">${money(v.total)}</td>
            <td class="num">${ex.total ? Math.round((v.total / ex.total) * 100) + '%' : '—'}</td>
          </tr>`
        )
        .join('') +
      `<tr class="total-row"><td>Total</td><td class="num">${ex.count}</td><td class="num">${money(ex.total)}</td><td class="num">100%</td></tr>`
    : emptyRow(4, 'No expenses recorded in this period');

  document.getElementById('expenseBody').innerHTML = ex.items.length
    ? ex.items
        .map(
          (e) => `<tr>
            <td>${pretty(e.expense_date)}</td>
            <td>${escapeHtml(e.description)}</td>
            <td>${escapeHtml(e.category)}</td>
            <td>${escapeHtml(e.created_by_name || '—')}</td>
            <td class="num">${money(e.amount)}</td>
          </tr>`
        )
        .join('') +
      `<tr class="total-row"><td colspan="4">Total</td><td class="num">${money(ex.total)}</td></tr>`
    : emptyRow(5, 'No expenses recorded in this period');
}

function stat(label, value, sub, tone) {
  return `<div class="stat ${tone || ''}">
    <div class="stat-label">${label}</div>
    <div class="stat-value">${value}</div>
    <div class="stat-sub">${sub || ''}</div>
  </div>`;
}

function gpCells(d) {
  if (d.cost === null || d.cost === undefined) {
    return '<td class="num muted">—</td><td class="num muted">—</td><td class="num muted">—</td>';
  }
  const gp = d.value - d.cost;
  const margin = d.value > 0 ? (gp / d.value) * 100 : null;
  const cls = gp < 0 ? 'num negative' : 'num';
  return `<td class="num muted">${money(d.cost)}</td><td class="${cls}">${money(gp)}</td><td class="${cls}">${margin === null ? '—' : margin.toFixed(1) + '%'}</td>`;
}

const emptyRow = (cols, text) => `<tr><td colspan="${cols}" class="empty-state">${text}</td></tr>`;

async function loadReport() {
  const key = document.getElementById('periodSelect').value;
  document.getElementById('customWrap').classList.toggle('hidden', key !== 'custom');

  let period = resolvePeriod(key);
  if (!period) {
    const from = document.getElementById('fromDate').value;
    const to = document.getElementById('toDate').value;
    if (!from || !to) return;
    period = { from, to, label: 'Custom Range' };
  }

  const data = await api(`/api/report?from=${period.from}&to=${period.to}`);
  const s = data.summary;

  document.getElementById('reportPeriod').textContent = `${period.label} · ${pretty(period.from)} — ${pretty(period.to)}`;
  document.getElementById('footPeriod').textContent = `${pretty(period.from)} — ${pretty(period.to)}`;
  document.getElementById('reportGenerated').textContent =
    `Generated ${new Date(data.generatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} by ${data.generatedBy}`;

  document.getElementById('statRow').innerHTML = [
    stat('Won', money(s.wonValue), `${s.wonCount} deal${s.wonCount === 1 ? '' : 's'}`, 'accent'),
    stat(
      'Gross profit on won',
      s.wonGp.pricedCount ? money(s.wonGp.gp) : '—',
      s.wonGp.pricedCount
        ? `${s.wonGp.marginPct.toFixed(1)}% margin · ${s.wonGp.pricedCount === s.wonGp.totalCount ? 'all' : s.wonGp.pricedCount + ' of ' + s.wonGp.totalCount} costed`
        : 'No costs captured',
      'accent'
    ),
    stat('Lost', money(s.lostValue), `${s.lostCount} deal${s.lostCount === 1 ? '' : 's'}`),
    stat('Win rate', s.winRate === null ? '—' : `${s.winRate.toFixed(0)}%`, 'Of deals closed in period'),
    stat('New deals added', money(s.newValue), `${s.newCount} deal${s.newCount === 1 ? '' : 's'}`)
  ].join('');

  document.getElementById('pipelineRow').innerHTML = [
    stat('Open pipeline', money(s.openValue), `${s.openCount} open deal${s.openCount === 1 ? '' : 's'}`),
    stat('Weighted pipeline', money(s.weightedOpenValue), 'Value × stage probability'),
    stat(
      'Gross profit in pipeline',
      s.openGp.pricedCount ? money(s.openGp.gp) : '—',
      s.openGp.pricedCount ? `${s.openGp.marginPct.toFixed(1)}% margin` : 'No costs captured'
    )
  ].join('');

  const stageTotal = Object.values(data.byStage).reduce((a, b) => a + b.value, 0);
  document.getElementById('stageBody').innerHTML = Object.entries(data.byStage)
    .map(
      ([name, v]) => `<tr>
        <td><span class="badge ${name.replace(/\s+/g, '-')}">${name}</span></td>
        <td class="num">${v.count}</td>
        <td class="num">${money(v.value)}</td>
        <td class="num">${stageTotal ? ((v.value / stageTotal) * 100).toFixed(0) + '%' : '—'}</td>
      </tr>`
    )
    .join('');

  document.getElementById('peopleBody').innerHTML = data.bySalesperson.length
    ? data.bySalesperson
        .map(
          (p) => `<tr>
            <td>${escapeHtml(p.name)}</td>
            <td class="num">${p.wonCount}</td>
            <td class="num">${money(p.wonValue)}</td>
            <td class="num">${p.wonCostedCount ? money(p.wonGp) : '—'}</td>
            <td class="num muted">${p.wonCount ? (p.wonCostedCount === p.wonCount ? 'all costed' : p.wonCostedCount + ' of ' + p.wonCount) : '—'}</td>
            <td class="num">${p.lostCount}</td>
            <td class="num">${p.winRate === null ? '—' : p.winRate.toFixed(0) + '%'}</td>
            <td class="num">${p.newCount}</td>
            <td class="num">${money(p.openValue)}</td>
          </tr>`
        )
        .join('')
    : emptyRow(9, 'No activity in this period');

  document.getElementById('wonBody').innerHTML = data.won.length
    ? data.won
        .map(
          (d) => `<tr>
            <td>${escapeHtml(d.customer_name)}</td>
            <td>${d.product_category}</td>
            <td>${pretty(d.won_lost_date)}</td>
            <td>${escapeHtml(d.owner_name || '—')}</td>
            <td class="num">${money(d.value)}</td>
            ${gpCells(d)}
          </tr>`
        )
        .join('')
    : emptyRow(8, 'No deals won in this period');

  document.getElementById('lostBody').innerHTML = data.lost.length
    ? data.lost
        .map(
          (d) => `<tr>
            <td>${escapeHtml(d.customer_name)}</td>
            <td>${d.product_category}</td>
            <td>${pretty(d.won_lost_date)}</td>
            <td>${escapeHtml(d.owner_name || '—')}</td>
            <td class="num">${money(d.value)}</td>
          </tr>`
        )
        .join('')
    : emptyRow(5, 'No deals lost in this period');

  document.getElementById('newBody').innerHTML = data.created.length
    ? data.created
        .map(
          (d) => `<tr>
            <td>${escapeHtml(d.customer_name)}</td>
            <td>${d.product_category}</td>
            <td>${pretty(String(d.created_at).slice(0, 10))}</td>
            <td>${escapeHtml(d.owner_name || '—')}</td>
            <td><span class="badge ${d.stage.replace(/\s+/g, '-')}">${d.stage}</span></td>
            <td class="num">${money(d.value)}</td>
          </tr>`
        )
        .join('')
    : emptyRow(6, 'No new deals added in this period');

  renderExpenses(data);

  document.getElementById('openBody').innerHTML = data.openDeals.length
    ? data.openDeals
        .map((d) => {
          const gp = d.cost === null || d.cost === undefined ? null : d.value - d.cost;
          return `<tr>
            <td>${escapeHtml(d.customer_name)}</td>
            <td><span class="badge ${d.stage.replace(/\s+/g, '-')}">${d.stage}</span></td>
            <td>${pretty(d.expected_close_date)}</td>
            <td>${escapeHtml(d.owner_name || '—')}</td>
            <td class="num">${money(d.value)}</td>
            <td class="num${gp !== null && gp < 0 ? ' negative' : ''}">${gp === null ? '—' : money(gp)}</td>
          </tr>`;
        })
        .join('')
    : emptyRow(6, 'No open deals');
}

(async () => {
  const user = await requireSession();
  if (!user) return;
  renderTopbar('report', user);
  await loadCurrency();

  document.getElementById('periodSelect').addEventListener('change', loadReport);
  document.getElementById('fromDate').addEventListener('change', loadReport);
  document.getElementById('toDate').addEventListener('change', loadReport);
  document.getElementById('btnPrint').addEventListener('click', () => window.print());

  await loadReport();
})();
