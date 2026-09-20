let currentUser = null;
let usersList = [];
let stageProbabilities = {};
let openDealIsArchived = false;

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

// An overdue next action is the single most useful thing to spot in the list,
// so it is called out rather than shown as a plain date.
function nextActionCell(d) {
  if (!d.next_action && !d.next_action_date) return '<span class="muted-note">—</span>';
  const today = businessToday();
  const overdue = d.next_action_date && d.next_action_date < today;
  const date = d.next_action_date
    ? `<span class="${overdue ? 'overdue' : ''}">${d.next_action_date}${overdue ? ' (overdue)' : ''}</span>`
    : '';
  const what = d.next_action ? `<div class="muted-note">${escapeHtml(d.next_action)}</div>` : '';
  return date + what;
}

function marginCellClass(marginPct) {
  return marginPct !== null && marginPct < 0 ? ' class="num negative"' : ' class="num"';
}

async function loadUsersForOwnerSelect() {
  const { users } = await api('/api/users');
  usersList = users.filter((u) => u.active);
  const sel = document.getElementById('f_owner_id');
  sel.innerHTML = usersList.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');

  const filter = document.getElementById('filterOwner');
  filter.innerHTML =
    '<option value="">All owners</option>' +
    usersList.map((u) => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
}

function currentFilters() {
  const params = new URLSearchParams();
  const search = document.getElementById('searchBox').value.trim();
  const stage = document.getElementById('filterStage').value;
  const category = document.getElementById('filterCategory').value;
  const owner = document.getElementById('filterOwner').value;
  const view = document.getElementById('filterView').value;
  if (search) params.set('search', search);
  if (stage) params.set('stage', stage);
  if (category) params.set('category', category);
  if (owner) params.set('ownerId', owner);
  if (view === 'archived') params.set('archived', 'true');
  else if (view) params.set('view', view);

  document.getElementById('btnClearFilters').classList.toggle('hidden', ![...params.keys()].length);
  return params.toString();
}

function clearFilters() {
  document.getElementById('searchBox').value = '';
  document.getElementById('filterStage').value = '';
  document.getElementById('filterCategory').value = '';
  document.getElementById('filterOwner').value = '';
  document.getElementById('filterView').value = '';
  loadDeals();
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
          <td>${escapeHtml(d.customer_name)}${d.archived_at ? ' <span class="muted-note">(archived)</span>' : ''}</td>
          <td>${d.product_category}</td>
          <td class="num">${money(d.value)}</td>
          <td class="num muted">${d.cost === null || d.cost === undefined ? '—' : money(d.cost)}</td>
          <td${gp ? marginCellClass(gp.marginPct) : ' class="num"'}>${gp && gp.marginPct !== null ? gp.marginPct.toFixed(1) + '%' : '—'}</td>
          <td${gp ? marginCellClass(gp.marginPct) : ' class="num"'}>${gp ? money(gp.gp) : '—'}</td>
          <td><span class="badge ${d.stage.replace(/\s+/g, '-')}">${d.stage}</span></td>
          <td class="num">${d.probability}%</td>
          <td>${d.expected_close_date || '—'}</td>
          <td>${nextActionCell(d)}</td>
          <td>${escapeHtml(d.owner_name || '—')}</td>
          <td><button class="btn small secondary" type="button">Edit</button></td>
        </tr>`;
        })
        .join('')
    : '<tr><td colspan="12" class="empty-state">No deals match your filters</td></tr>';

  document.querySelectorAll('.deal-row').forEach((row) => {
    row.addEventListener('click', () => openDealModal(Number(row.dataset.id)));
  });
}

// The lost reason only makes sense on a lost deal, so it appears with the stage
// rather than sitting empty the rest of the time.
function syncStageFields() {
  const stage = document.getElementById('f_stage').value;
  document.getElementById('lostReasonWrap').classList.toggle('hidden', stage !== 'Lost');
  const choice = document.getElementById('f_lost_reason_choice').value;
  document.getElementById('f_lost_reason_other').classList.toggle('hidden', choice !== '__other');
}

function readLostReason() {
  if (document.getElementById('f_stage').value !== 'Lost') return null;
  const choice = document.getElementById('f_lost_reason_choice').value;
  if (choice === '__other') return document.getElementById('f_lost_reason_other').value.trim() || null;
  return choice || null;
}

function setLostReason(value) {
  const select = document.getElementById('f_lost_reason_choice');
  const other = document.getElementById('f_lost_reason_other');
  const known = [...select.options].some((o) => o.value === value && o.value !== '__other');
  if (value && known) {
    select.value = value;
    other.value = '';
  } else if (value) {
    select.value = '__other';
    other.value = value;
  } else {
    select.value = '';
    other.value = '';
  }
  syncStageFields();
}

function describeChange(h, labels) {
  if (h.action === 'created') return 'Deal created';
  if (h.action === 'deleted') return 'Deal permanently deleted';
  if (h.action === 'archived') return 'Deal archived';
  if (h.action === 'restored') return 'Deal restored from the archive';
  const label = labels[h.field] || h.field;
  const from = h.old_value === null || h.old_value === '' ? 'empty' : h.old_value;
  const to = h.new_value === null || h.new_value === '' ? 'empty' : h.new_value;
  return `${label}: ${escapeHtml(from)} → ${escapeHtml(to)}`;
}

async function loadActivity(dealId) {
  const section = document.getElementById('activitySection');
  const list = document.getElementById('activityList');
  section.classList.remove('hidden');
  list.innerHTML = '<li class="muted-note">Loading…</li>';

  try {
    const { history, fieldLabels } = await api(`/api/deals/${dealId}/history`);
    if (!history.length) {
      list.innerHTML = '<li class="muted-note">No changes recorded yet.</li>';
      return;
    }
    list.innerHTML = history
      .map((h) => {
        const when = new Date(h.changed_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
        return `<li class="activity-item ${h.action}">
          <div class="activity-what">${describeChange(h, fieldLabels)}</div>
          <div class="activity-who">${escapeHtml(h.changed_by_name || 'Unknown')} · ${when}</div>
        </li>`;
      })
      .join('');
  } catch (e) {
    list.innerHTML = `<li class="muted-note">Could not load activity: ${escapeHtml(e.message)}</li>`;
  }
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
  document.getElementById('btnArchiveDeal').classList.add('hidden');
  document.getElementById('btnRestoreDeal').classList.add('hidden');
  openDealIsArchived = false;
  document.getElementById('dealErr').textContent = '';
  document.getElementById('f_owner_id').value = currentUser.id;
  document.getElementById('f_stage').value = 'Lead';
  document.getElementById('f_probability').value = stageProbabilities.Lead ?? 10;
  document.getElementById('activitySection').classList.add('hidden');
  setLostReason(null);
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
    document.getElementById('f_next_action').value = deal.next_action || '';
    document.getElementById('f_next_action_date').value = deal.next_action_date || '';
    setLostReason(deal.lost_reason || null);
    openDealIsArchived = Boolean(deal.archived_at);
    document.getElementById('btnArchiveDeal').classList.toggle('hidden', openDealIsArchived);
    document.getElementById('btnRestoreDeal').classList.toggle('hidden', !openDealIsArchived);
    loadActivity(id);
  }
  syncStageFields();
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
    notes: document.getElementById('f_notes').value,
    next_action: document.getElementById('f_next_action').value,
    next_action_date: document.getElementById('f_next_action_date').value || null,
    lost_reason: readLostReason()
  };
}

(async () => {
  currentUser = await requireSession();
  if (!currentUser) return;
  renderTopbar('deals', currentUser);
  await loadCurrency();
  stageProbabilities = (await api('/api/settings')).stageProbabilities;
  const cur = window.__APP_CURRENCY__;
  document.getElementById('valueLabel').textContent = `Deal value (${cur}) *`;
  document.getElementById('costLabel').textContent = `Cost (${cur})`;
  document.getElementById('gpHeader').textContent = `GP (${cur})`;
  await loadUsersForOwnerSelect();
  await loadDeals();

  // dashboard links arrive as /deals.html?deal=123
  const wanted = new URLSearchParams(location.search).get('deal');
  if (wanted) openDealModal(Number(wanted));

  // read-only roles can browse and report, but not change the pipeline
  if (!currentUser.canEditDeals) {
    document.getElementById('btnAddDeal').classList.add('hidden');
  }
  document.getElementById('btnAddDeal').addEventListener('click', () => openDealModal(null));
  document.getElementById('btnCancelDeal').addEventListener('click', closeDealModal);
  document.getElementById('searchBox').addEventListener('input', debounce(loadDeals, 250));
  document.getElementById('filterStage').addEventListener('change', loadDeals);
  document.getElementById('filterCategory').addEventListener('change', loadDeals);
  document.getElementById('filterOwner').addEventListener('change', loadDeals);
  document.getElementById('filterView').addEventListener('change', loadDeals);
  document.getElementById('btnClearFilters').addEventListener('click', clearFilters);
  document.getElementById('btnMyDeals').addEventListener('click', () => {
    document.getElementById('filterOwner').value = String(currentUser.id);
    loadDeals();
  });
  document.getElementById('f_lost_reason_choice').addEventListener('change', syncStageFields);

  document.getElementById('f_value').addEventListener('input', updateGpReadout);
  document.getElementById('f_cost').addEventListener('input', updateGpReadout);

  document.getElementById('f_stage').addEventListener('change', (e) => {
    const suggested = stageProbabilities[e.target.value];
    if (suggested !== undefined) document.getElementById('f_probability').value = suggested;
    syncStageFields();
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

  // Archiving hides the deal but keeps the record, so this is recoverable
  // rather than destructive.
  document.getElementById('btnArchiveDeal').addEventListener('click', async () => {
    const id = document.getElementById('dealId').value;
    if (!id) return;
    if (!confirm('Archive this deal? It will be hidden from the pipeline and reports, and can be restored later.')) return;
    await api(`/api/deals/${id}/archive`, { method: 'POST' });
    closeDealModal();
    await loadDeals();
  });

  document.getElementById('btnRestoreDeal').addEventListener('click', async () => {
    const id = document.getElementById('dealId').value;
    if (!id) return;
    await api(`/api/deals/${id}/restore`, { method: 'POST' });
    closeDealModal();
    await loadDeals();
  });

})();

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
