let currentUser = null;
let usersList = [];
let stageProbabilities = {};

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// GP is only meaningful once a cost is captured; a blank cost stays blank rather
// than reading as 100% margin.
function grossProfit(value, cost) {
  if (cost === null || cost === undefined || cost === '') return null;
  const v = Number(value) || 0;
  const c = Number(cost);
  const gp = v - c;
  return { gp, marginPct: v > 0 ? (gp / v) * 100 : null };
}

function marginCellClass(marginPct) {
  return marginPct !== null && marginPct < 0 ? ' class="num negative"' : ' class="num"';
}

async function loadUsersForOwnerSelect() {
  const { users } = await api('/api/users');
  usersList = users.filter((u) => u.active);
  const sel = document.getElementById('f_owner_id');
  sel.innerHTML = usersList.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
}

function currentFilters() {
  const params = new URLSearchParams();
  const search = document.getElementById('searchBox').value.trim();
  const stage = document.getElementById('filterStage').value;
  const category = document.getElementById('filterCategory').value;
  if (search) params.set('search', search);
  if (stage) params.set('stage', stage);
  if (category) params.set('category', category);
  return params.toString();
}

async function loadDeals() {
  const qs = currentFilters();
  const { deals } = await api(`/api/deals${qs ? '?' + qs : ''}`);
  document.getElementById('resultCount').textContent = `${deals.length} deal${deals.length === 1 ? '' : 's'}`;
  document.getElementById('dealsBody').innerHTML = deals.length
    ? deals
        .map((d) => {
          const gp = grossProfit(d.value, d.cost);
          return `
        <tr data-id="${d.id}" class="deal-row" style="cursor:pointer;">
          <td>${escapeHtml(d.customer_name)}</td>
          <td>${d.product_category}</td>
          <td class="num">${money(d.value)}</td>
          <td class="num muted">${d.cost === null || d.cost === undefined ? '—' : money(d.cost)}</td>
          <td${gp ? marginCellClass(gp.marginPct) : ' class="num"'}>${gp && gp.marginPct !== null ? gp.marginPct.toFixed(1) + '%' : '—'}</td>
          <td${gp ? marginCellClass(gp.marginPct) : ' class="num"'}>${gp ? money(gp.gp) : '—'}</td>
          <td><span class="badge ${d.stage.replace(/\s+/g, '-')}">${d.stage}</span></td>
          <td class="num">${d.probability}%</td>
          <td>${d.expected_close_date || '—'}</td>
          <td>${escapeHtml(d.owner_name || '—')}</td>
          <td><button class="btn small secondary" type="button">Edit</button></td>
        </tr>`;
        })
        .join('')
    : '<tr><td colspan="11" class="empty-state">No deals match your filters</td></tr>';

  document.querySelectorAll('.deal-row').forEach((row) => {
    row.addEventListener('click', () => openDealModal(Number(row.dataset.id)));
  });
}

function updateGpReadout() {
  const el = document.getElementById('gpReadoutValue');
  const gp = grossProfit(document.getElementById('f_value').value, document.getElementById('f_cost').value);
  if (!gp) {
    el.textContent = 'Enter a cost to calculate';
    el.className = '';
    return;
  }
  const marginText = gp.marginPct === null ? '—' : `${gp.marginPct.toFixed(1)}% margin`;
  el.textContent = `${money(gp.gp)} · ${marginText}`;
  el.className = gp.gp < 0 ? 'negative' : 'positive';
}

function resetDealForm() {
  document.getElementById('dealForm').reset();
  document.getElementById('dealId').value = '';
  document.getElementById('dealModalTitle').textContent = 'Add Deal';
  document.getElementById('btnDeleteDeal').classList.add('hidden');
  document.getElementById('dealErr').textContent = '';
  document.getElementById('f_owner_id').value = currentUser.id;
  document.getElementById('f_stage').value = 'Lead';
  document.getElementById('f_probability').value = stageProbabilities.Lead ?? 10;
  updateGpReadout();
}

async function openDealModal(id) {
  resetDealForm();
  if (id) {
    const { deal } = await api(`/api/deals/${id}`);
    document.getElementById('dealModalTitle').textContent = 'Edit Deal';
    document.getElementById('dealId').value = deal.id;
    document.getElementById('f_customer_name').value = deal.customer_name;
    document.getElementById('f_contact_name').value = deal.contact_name || '';
    document.getElementById('f_contact_email').value = deal.contact_email || '';
    document.getElementById('f_contact_phone').value = deal.contact_phone || '';
    document.getElementById('f_product_category').value = deal.product_category;
    document.getElementById('f_value').value = deal.value;
    document.getElementById('f_cost').value = deal.cost === null || deal.cost === undefined ? '' : deal.cost;
    document.getElementById('f_stage').value = deal.stage;
    document.getElementById('f_probability').value = deal.probability;
    document.getElementById('f_expected_close_date').value = deal.expected_close_date || '';
    document.getElementById('f_won_lost_date').value = deal.won_lost_date || '';
    document.getElementById('f_owner_id').value = deal.owner_id || '';
    document.getElementById('f_description').value = deal.description || '';
    document.getElementById('f_notes').value = deal.notes || '';
    document.getElementById('btnDeleteDeal').classList.remove('hidden');
  }
  updateGpReadout();
  document.getElementById('dealModal').classList.remove('hidden');
}

function closeDealModal() {
  document.getElementById('dealModal').classList.add('hidden');
}

function collectDealForm() {
  return {
    customer_name: document.getElementById('f_customer_name').value,
    contact_name: document.getElementById('f_contact_name').value,
    contact_email: document.getElementById('f_contact_email').value,
    contact_phone: document.getElementById('f_contact_phone').value,
    product_category: document.getElementById('f_product_category').value,
    value: document.getElementById('f_value').value,
    cost: document.getElementById('f_cost').value === '' ? null : document.getElementById('f_cost').value,
    stage: document.getElementById('f_stage').value,
    probability: document.getElementById('f_probability').value,
    expected_close_date: document.getElementById('f_expected_close_date').value || null,
    won_lost_date: document.getElementById('f_won_lost_date').value || null,
    owner_id: document.getElementById('f_owner_id').value || null,
    description: document.getElementById('f_description').value,
    notes: document.getElementById('f_notes').value
  };
}

(async () => {
  currentUser = await requireSession();
  if (!currentUser) return;
  renderTopbar('deals', currentUser);
  await loadCurrency();
  stageProbabilities = (await api('/api/settings')).stageProbabilities;
  const cur = window.__NVF_CURRENCY__;
  document.getElementById('valueLabel').textContent = `Deal value (${cur}) *`;
  document.getElementById('costLabel').textContent = `Cost (${cur})`;
  document.getElementById('gpHeader').textContent = `GP (${cur})`;
  await loadUsersForOwnerSelect();
  await loadDeals();

  document.getElementById('btnAddDeal').addEventListener('click', () => openDealModal(null));
  document.getElementById('btnCancelDeal').addEventListener('click', closeDealModal);
  document.getElementById('searchBox').addEventListener('input', debounce(loadDeals, 250));
  document.getElementById('filterStage').addEventListener('change', loadDeals);
  document.getElementById('filterCategory').addEventListener('change', loadDeals);

  document.getElementById('f_value').addEventListener('input', updateGpReadout);
  document.getElementById('f_cost').addEventListener('input', updateGpReadout);

  document.getElementById('f_stage').addEventListener('change', (e) => {
    const suggested = stageProbabilities[e.target.value];
    if (suggested !== undefined) document.getElementById('f_probability').value = suggested;
  });

  document.getElementById('dealForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('dealErr');
    errEl.textContent = '';
    const id = document.getElementById('dealId').value;
    const body = JSON.stringify(collectDealForm());
    try {
      if (id) {
        await api(`/api/deals/${id}`, { method: 'PUT', body });
      } else {
        await api('/api/deals', { method: 'POST', body });
      }
      closeDealModal();
      await loadDeals();
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  document.getElementById('btnDeleteDeal').addEventListener('click', async () => {
    const id = document.getElementById('dealId').value;
    if (!id) return;
    if (!confirm('Delete this deal? This cannot be undone.')) return;
    await api(`/api/deals/${id}`, { method: 'DELETE' });
    closeDealModal();
    await loadDeals();
  });

  document.getElementById('closeAccount').addEventListener('click', () => document.getElementById('accountModal').classList.add('hidden'));
  document.getElementById('pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('pwErr');
    errEl.textContent = '';
    try {
      await api('/api/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: document.getElementById('curPw').value, newPassword: document.getElementById('newPw').value })
      });
      document.getElementById('accountModal').classList.add('hidden');
      document.getElementById('pwForm').reset();
      alert('Password updated.');
    } catch (err) {
      errEl.textContent = err.message;
    }
  });
})();

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
