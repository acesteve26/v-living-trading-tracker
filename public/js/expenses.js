let currentUser = null;
let currentData = { expenses: [], byCategory: {}, total: 0 };

// The same period vocabulary the dashboard uses, plus quarters, which is what
// expenses are usually looked at by.
function buildRangeOptions() {
  const now = new Date();
  const y = now.getFullYear();
  const q = Math.floor(now.getMonth() / 3) + 1;
  const select = document.getElementById('rangeSelect');
  // Nothing predates 2026, so earlier years are never offered.
  const FIRST_DATA_YEAR = 2026;

  const options = [
    { value: 'this_month', label: `This Month (${now.toLocaleString('en-US', { month: 'long' })} ${y})` },
    { value: 'this_quarter', label: `This Quarter (Q${q} ${y})` },
    ...[1, 2, 3, 4]
      .filter((n) => !(n === q))
      .map((n) => ({ value: `quarter:${y}-${n}`, label: `Q${n} ${y}` })),
    { value: 'ytd', label: `Year to Date (${y})` },
    ...(y - 1 >= FIRST_DATA_YEAR ? [{ value: `year:${y - 1}`, label: `Full Year ${y - 1}` }] : []),
    { value: `year:${y}`, label: `Full Year ${y}` },
    { value: `year:${y + 1}`, label: `Full Year ${y + 1}` },
    { value: 'custom', label: 'Custom Range…' }
  ];

  select.innerHTML = options.map((o) => `<option value="${o.value}">${o.label}</option>`).join('');
  select.value = 'this_month';
}

function buildCategoryOptions() {
  const categories = window.__APP_EXPENSE_CATEGORIES__ || [];
  document.getElementById('filterCategory').innerHTML =
    '<option value="">All categories</option>' + categories.map((c) => `<option>${c}</option>`).join('');
  document.getElementById('f_category').innerHTML = categories.map((c) => `<option>${c}</option>`).join('');
}

const prettyDate = (iso) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

// How many months the chosen period actually covers, so the average is against
// elapsed time rather than a fixed twelve.
function monthsIn(range) {
  const from = new Date(range.from + 'T00:00:00');
  const to = new Date(range.to + 'T00:00:00');
  const months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth()) + 1;
  return Math.max(1, months);
}

function renderSummary(data) {
  document.getElementById('kpiTotal').textContent = money(data.total);
  document.getElementById('kpiCount').textContent = `${data.count} expense${data.count === 1 ? '' : 's'} in this period`;

  const ranked = Object.entries(data.byCategory)
    .filter(([, v]) => v.total > 0)
    .sort((a, b) => b[1].total - a[1].total);

  if (ranked.length) {
    const [name, top] = ranked[0];
    document.getElementById('kpiTopCategory').textContent = name;
    const share = data.total > 0 ? Math.round((top.total / data.total) * 100) : 0;
    document.getElementById('kpiTopCategorySub').textContent = `${money(top.total)} · ${share}% of the total`;
  } else {
    document.getElementById('kpiTopCategory').textContent = '—';
    document.getElementById('kpiTopCategorySub').textContent = 'Nothing recorded yet';
  }

  const months = monthsIn(data.range);
  document.getElementById('kpiMonthly').textContent = months > 1 ? money(data.total / months) : money(data.total);
  document.getElementById('kpiMonthlySub').textContent =
    months > 1 ? `Across ${months} months` : 'Single month';
}

function renderTable(data) {
  const canEdit = currentUser.canEditExpenses;
  const body = document.getElementById('expensesBody');

  body.innerHTML = data.expenses.length
    ? data.expenses
        .map(
          (e) => `<tr>
            <td>${prettyDate(e.expense_date)}</td>
            <td>${escapeHtml(e.description)}</td>
            <td>${escapeHtml(e.category)}</td>
            <td class="num">${money(e.amount)}</td>
            <td>${escapeHtml(e.created_by_name || '—')}</td>
            <td style="text-align:right;">
              ${canEdit ? `<button class="btn small secondary" data-edit="${e.id}">Edit</button>` : ''}
            </td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="6" class="empty-state">No expenses recorded in this period.</td></tr>';

  document.getElementById('footTotal').textContent = money(data.total);
  document.getElementById('resultCount').textContent = `${data.count} expense${data.count === 1 ? '' : 's'} · ${money(data.total)}`;

  document.querySelectorAll('[data-edit]').forEach((btn) =>
    btn.addEventListener('click', () => openExpenseModal(Number(btn.dataset.edit)))
  );

  const ranked = Object.entries(data.byCategory)
    .filter(([, v]) => v.count > 0)
    .sort((a, b) => b[1].total - a[1].total);

  document.getElementById('categoryBody').innerHTML = ranked.length
    ? ranked
        .map(
          ([name, v]) => `<tr>
            <td>${escapeHtml(name)}</td>
            <td class="num">${v.count}</td>
            <td class="num">${money(v.total)}</td>
            <td class="num">${data.total > 0 ? Math.round((v.total / data.total) * 100) : 0}%</td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="4" class="empty-state">Nothing to break down yet.</td></tr>';
}

async function loadExpenses() {
  const range = document.getElementById('rangeSelect').value;
  const customWrap = document.getElementById('customRangeWrap');
  customWrap.classList.toggle('hidden', range !== 'custom');
  if (range === 'custom' && (!document.getElementById('fromDate').value || !document.getElementById('toDate').value)) {
    return; // wait for Apply
  }

  let url = `/api/expenses?range=${encodeURIComponent(range)}`;
  if (range === 'custom') {
    url += `&from=${document.getElementById('fromDate').value}&to=${document.getElementById('toDate').value}`;
  }
  const category = document.getElementById('filterCategory').value;
  if (category) url += `&category=${encodeURIComponent(category)}`;

  const data = await api(url);
  currentData = data;

  document.getElementById('rangeLabel').textContent =
    `${data.range.label} · ${prettyDate(data.range.from)} — ${prettyDate(data.range.to)}`;

  renderSummary(data);
  renderTable(data);
}

function openExpenseModal(id) {
  const form = document.getElementById('expenseForm');
  form.reset();
  document.getElementById('expenseErr').textContent = '';
  document.getElementById('expenseId').value = id || '';
  document.getElementById('btnDeleteExpense').classList.toggle('hidden', !id);

  if (id) {
    const expense = currentData.expenses.find((e) => e.id === id);
    if (!expense) return;
    document.getElementById('expenseModalTitle').textContent = 'Edit Expense';
    document.getElementById('f_expense_date').value = expense.expense_date;
    document.getElementById('f_description').value = expense.description;
    document.getElementById('f_category').value = expense.category;
    document.getElementById('f_amount').value = expense.amount;
  } else {
    document.getElementById('expenseModalTitle').textContent = 'Add Expense';
    // today where the business is, not wherever the browser happens to be
    document.getElementById('f_expense_date').value = businessToday();
  }

  document.getElementById('expenseModal').classList.remove('hidden');
}

const closeExpenseModal = () => document.getElementById('expenseModal').classList.add('hidden');

(async () => {
  currentUser = await requireSession();
  if (!currentUser) return;
  renderTopbar('expenses', currentUser);
  await loadCurrency();

  const cur = window.__APP_CURRENCY__;
  document.getElementById('amountHeader').textContent = `Amount (${cur})`;
  document.getElementById('amountLabel').textContent = `Amount (${cur}) *`;

  buildRangeOptions();
  buildCategoryOptions();

  // Everyone can see expenses; only the finance roles can change them.
  document.getElementById('btnAddExpense').classList.toggle('hidden', !currentUser.canEditExpenses);

  document.getElementById('rangeSelect').addEventListener('change', loadExpenses);
  document.getElementById('filterCategory').addEventListener('change', loadExpenses);
  document.getElementById('applyCustom').addEventListener('click', loadExpenses);
  document.getElementById('btnAddExpense').addEventListener('click', () => openExpenseModal(null));
  document.getElementById('btnCancelExpense').addEventListener('click', closeExpenseModal);

  document.getElementById('expenseForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('expenseErr');
    errEl.textContent = '';
    const id = document.getElementById('expenseId').value;
    const body = JSON.stringify({
      expense_date: document.getElementById('f_expense_date').value,
      description: document.getElementById('f_description').value,
      category: document.getElementById('f_category').value,
      amount: document.getElementById('f_amount').value
    });

    try {
      if (id) await api(`/api/expenses/${id}`, { method: 'PUT', body });
      else await api('/api/expenses', { method: 'POST', body });
      closeExpenseModal();
      await loadExpenses();
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  document.getElementById('btnDeleteExpense').addEventListener('click', async () => {
    const id = document.getElementById('expenseId').value;
    if (!id) return;
    if (!confirm('Delete this expense? This cannot be undone.')) return;
    try {
      await api(`/api/expenses/${id}`, { method: 'DELETE' });
      closeExpenseModal();
      await loadExpenses();
    } catch (err) {
      document.getElementById('expenseErr').textContent = err.message;
    }
  });

  await loadExpenses();
})();
