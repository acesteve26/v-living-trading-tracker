let currentUser = null;
let usersList = [];
let stageProbabilities = {};
let openDealIsArchived = false;

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// GP is only meaningful once a cost is captured; a blank cost stays blank rather
// than reading as 100% margin.
const assumedPct = () => window.__APP_ASSUMED_GP_PCT__ || 20;

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

// In progress by default: the working list is the one people open this page
// for, and a year of won deals underneath it is noise most of the time.
let dealStatus = 'open';

function setDealStatus(status) {
  dealStatus = status;
  document.querySelectorAll('#statusFilter .segment').forEach((b) =>
    b.classList.toggle('is-active', b.dataset.status === status)
  );
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
  // The stage dropdown is the finer version of the same choice, so it wins and
  // the split above is left out rather than the two contradicting each other
  // into an empty table.
  if (dealStatus !== 'all' && !stage) params.set('status', dealStatus);

  // The split is a starting position rather than a filter someone set, so it
  // does not by itself light up the Clear button.
  params.delete('status');
  document.getElementById('btnClearFilters').classList.toggle('hidden', ![...params.keys()].length);
  if (dealStatus !== 'all' && !stage) params.set('status', dealStatus);

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
          <td class="num${gp ? ' muted' : ' cost-missing'}">${gp ? money(d.cost) : 'Add cost'}</td>
          <td${gp ? marginCellClass(gp.marginPct) : ' class="num cost-missing"'}>${gp && gp.marginPct !== null ? gp.marginPct.toFixed(1) + '%' : assumedPct() + '%*'}</td>
          <td${gp ? marginCellClass(gp.marginPct) : ' class="num cost-missing"'}>${gp ? money(gp.gp) : money((Number(d.value) || 0) * assumedPct() / 100) + '*'}</td>
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
// The stage the deal was on when the form opened, so moving *into* Won can be
// told apart from editing something that was already won.
let openDealStage = null;

// Marking a deal won settles both of its dates: it closed today, and the
// expected close is no longer a forecast. Filled in here as well as on the
// server so it is visible in the form before saving - and still editable, for
// a deal being logged days after it actually closed.
function applyWonDates(stage) {
  if (stage !== 'Won' || openDealStage === 'Won') return;
  const wonLost = document.getElementById('f_won_lost_date');
  if (!wonLost.value) wonLost.value = businessToday();
  document.getElementById('f_expected_close_date').value = wonLost.value;
}

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
  if (h.action === 'document_added') return `Document attached: ${escapeHtml(h.new_value)}`;
  if (h.action === 'document_removed') return `Document removed: ${escapeHtml(h.old_value)}`;
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

// ---------- known customers ----------
// Typing a customer name offers the ones already on the books and fills in
// their contact details, so the same client is not re-keyed on every deal.
let knownCustomers = [];
// What the last autofill put in each field, so switching to a different
// customer replaces those values while anything typed by hand is left alone.
let autofilled = {};

async function loadCustomers() {
  try {
    const { customers } = await api('/api/customers');
    knownCustomers = customers;
    document.getElementById('customerList').innerHTML = customers
      .map((c) => `<option value="${escapeHtml(c.customer_name)}"></option>`)
      .join('');
  } catch (e) {
    knownCustomers = [];
  }
}

const findCustomer = (name) =>
  knownCustomers.find((c) => c.customer_name.toLowerCase() === String(name || '').trim().toLowerCase());

function applyCustomerDetails() {
  const note = document.getElementById('customerFilled');
  const match = findCustomer(document.getElementById('f_customer_name').value);
  if (!match) {
    note.classList.add('hidden');
    return;
  }

  const fields = {
    f_contact_name: match.contact_name,
    f_contact_email: match.contact_email,
    f_contact_phone: match.contact_phone
  };

  const filled = [];
  for (const [id, value] of Object.entries(fields)) {
    const input = document.getElementById(id);
    // fill what is empty, and replace what a previous autofill put there -
    // never overwrite something typed by hand
    const safeToReplace = input.value === '' || input.value === autofilled[id];
    if (!safeToReplace) continue;
    input.value = value || '';
    autofilled[id] = value || '';
    if (value) filled.push(id.replace('f_contact_', ''));
  }

  note.textContent = filled.length
    ? `Contact ${filled.join(', ')} filled in from the last deal with ${match.customer_name}. Edit if it has changed.`
    : `${match.customer_name} is already on the books.`;
  note.classList.remove('hidden');
}

// ---------- documents ----------
// A deal being added doesn't exist yet, so files dropped on it are held here
// and uploaded the moment the deal is saved.
let pendingFiles = [];
let savedDocuments = [];

function docMaxBytes() {
  return window.__APP_DOC_MAX_BYTES__ || 50 * 1024 * 1024;
}

function allowedExtensions() {
  return window.__APP_DOC_EXTENSIONS__ || [];
}

function extensionOf(name) {
  const dot = String(name || '').lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

function documentsUsedBytes() {
  return (
    savedDocuments.reduce((sum, d) => sum + d.byte_size, 0) +
    pendingFiles.reduce((sum, f) => sum + f.size, 0)
  );
}

// PDFs and ordinary images can be shown here. Everything else - Word, Excel,
// ZIP - has no viewer in the browser, so those stay downloads.
function isPreviewable(doc) {
  return (window.__APP_DOC_PREVIEW_TYPES__ || []).includes(doc.content_type);
}

function openPreview(doc) {
  const modal = document.getElementById('previewModal');
  const body = document.getElementById('previewBody');
  document.getElementById('previewTitle').textContent = doc.filename;
  document.getElementById('previewDownload').href = `/api/documents/${doc.id}`;

  const src = `/api/documents/${doc.id}?inline=1`;
  body.innerHTML = doc.content_type === 'application/pdf'
    ? `<iframe class="preview-frame" src="${src}" title="${escapeHtml(doc.filename)}"></iframe>`
    : `<img class="preview-image" src="${src}" alt="${escapeHtml(doc.filename)}" />`;

  modal.classList.remove('hidden');
}

function closePreview() {
  document.getElementById('previewModal').classList.add('hidden');
  // drop the source so a big PDF isn't left rendering behind the deal form
  document.getElementById('previewBody').innerHTML = '';
}

function renderDocuments() {
  const list = document.getElementById('docList');
  const usage = document.getElementById('docUsage');
  const canEdit = currentUser && currentUser.canEditDeals;

  const rows = [
    ...savedDocuments.map(
      (d) => `<li class="doc-row">
        ${isPreviewable(d)
          ? `<button type="button" class="doc-name as-button" data-preview-id="${d.id}">${escapeHtml(d.filename)}</button>`
          : `<a class="doc-name" href="/api/documents/${d.id}" download>${escapeHtml(d.filename)}</a>`}
        <span class="doc-meta">${fileSize(d.byte_size)} · ${escapeHtml(d.uploaded_by_name || 'Unknown')} · ${new Date(d.uploaded_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
        ${canEdit ? `<button type="button" class="doc-remove" data-doc-id="${d.id}" aria-label="Remove ${escapeHtml(d.filename)}">Remove</button>` : ''}
      </li>`
    ),
    ...pendingFiles.map(
      (f, i) => `<li class="doc-row pending">
        <span class="doc-name">${escapeHtml(f.name)}</span>
        <span class="doc-meta">${fileSize(f.size)} · attaches when you save</span>
        <button type="button" class="doc-remove" data-pending-index="${i}" aria-label="Remove ${escapeHtml(f.name)}">Remove</button>
      </li>`
    )
  ];

  list.innerHTML = rows.length
    ? rows.join('')
    : '<li class="muted-note">No documents attached yet.</li>';

  const used = documentsUsedBytes();
  usage.textContent = `${fileSize(used)} of ${fileSize(docMaxBytes())} used`;
  usage.classList.toggle('near-limit', used > docMaxBytes() * 0.8);
}

async function loadDocuments(dealId) {
  try {
    const data = await api(`/api/deals/${dealId}/documents`);
    savedDocuments = data.documents;
  } catch (e) {
    savedDocuments = [];
    document.getElementById('docErr').textContent = `Could not load documents: ${e.message}`;
  }
  renderDocuments();
}

// Checked here so an obviously wrong file is refused instantly rather than
// after a 40 MB round trip. The server enforces the same rules regardless.
function rejectionReason(file) {
  const ext = extensionOf(file.name);
  const allowed = allowedExtensions();
  if (allowed.length && !allowed.includes(ext)) {
    return `${file.name} can't be attached (${ext || 'no file extension'}). Allowed: ${allowed.join(', ')}`;
  }
  if (file.size === 0) return `${file.name} is empty`;
  if (documentsUsedBytes() + file.size > docMaxBytes()) {
    const left = Math.max(0, docMaxBytes() - documentsUsedBytes());
    return `${file.name} is ${fileSize(file.size)} and only ${fileSize(left)} is left for this deal`;
  }
  return null;
}

async function addFiles(fileList) {
  const errEl = document.getElementById('docErr');
  errEl.textContent = '';
  const dealId = document.getElementById('dealId').value;
  const problems = [];

  for (const file of Array.from(fileList)) {
    const reason = rejectionReason(file);
    if (reason) {
      problems.push(reason);
      continue;
    }
    if (dealId) {
      try {
        const { document: saved } = await apiUpload(`/api/deals/${dealId}/documents`, file);
        savedDocuments.unshift(saved);
      } catch (e) {
        problems.push(`${file.name}: ${e.message}`);
      }
    } else {
      pendingFiles.push(file);
    }
    renderDocuments();
  }

  if (problems.length) errEl.textContent = problems.join(' · ');
}

// Called after a brand-new deal is created, to attach whatever was queued.
async function uploadPendingFiles(dealId) {
  const failures = [];
  for (const file of pendingFiles) {
    try {
      await apiUpload(`/api/deals/${dealId}/documents`, file);
    } catch (e) {
      failures.push(`${file.name}: ${e.message}`);
    }
  }
  pendingFiles = [];
  return failures;
}

function wireDocuments() {
  const zone = document.getElementById('dropzone');
  const input = document.getElementById('fileInput');

  document.getElementById('dropzoneTypes').textContent = allowedExtensions().length
    ? `${allowedExtensions().join(' ')} · up to ${fileSize(docMaxBytes())} per deal`
    : '';

  const choose = () => input.click();
  document.getElementById('btnChooseFiles').addEventListener('click', choose);
  zone.addEventListener('click', (e) => {
    if (e.target === zone || e.target.closest('.dropzone-main, .dropzone-sub, .dropzone-types')) choose();
  });
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose();
    }
  });

  input.addEventListener('change', async () => {
    await addFiles(input.files);
    input.value = ''; // so the same file can be picked again after removing it
  });

  // The whole deal window takes drops, not just the dashed box. The form is
  // taller than the screen, so the box is usually scrolled out of sight while
  // someone is dragging a file in - aiming at it was the first version of this
  // and it silently swallowed anything dropped on the rest of the form.
  const modal = document.getElementById('dealModal');

  // What is being dragged, read from whatever the browser is willing to say
  // mid-drag (file contents are withheld until the drop, but the kinds are
  // not). Files from the desktop show up as 'Files'; Firefox adds its own
  // name; some sources only populate items. A link is what you get when an
  // attachment is dragged straight out of webmail - it is a URL to the file,
  // not the file, and it needs handling differently rather than ignoring.
  const describeDrag = (e) => {
    const dt = e.dataTransfer;
    if (!dt) return { files: false, link: false };
    const types = Array.from(dt.types || []);
    const items = Array.from(dt.items || []);
    return {
      files:
        types.includes('Files') ||
        types.includes('application/x-moz-file') ||
        items.some((i) => i.kind === 'file'),
      link: types.includes('text/uri-list')
    };
  };

  // Anything that is a file or a link to one is claimed by the window, even
  // for someone who can't attach: left to the browser, a dropped file or link
  // navigates the tab away and the half-filled form goes with it. Plain text
  // is left alone so it can still be dragged into a field. Whether a drop is
  // then accepted is decided at the drop.
  const claimable = (e) => {
    const d = describeDrag(e);
    return d.files || d.link;
  };
  const canAttachNow = () => !zone.classList.contains('hidden');

  // dragenter/dragleave fire on every child boundary crossed, and Chrome gives
  // no relatedTarget to tell a real exit from an internal one - a counter does.
  let dragDepth = 0;
  const endDrag = () => {
    dragDepth = 0;
    modal.classList.remove('drop-target');
    zone.classList.remove('dragover');
  };

  modal.addEventListener('dragenter', (e) => {
    if (!claimable(e)) return;
    e.preventDefault();
    dragDepth += 1;
    if (canAttachNow()) {
      modal.classList.add('drop-target');
      zone.classList.add('dragover');
    }
  });

  // Cancelled on every single event: the browser treats any uncancelled
  // dragover as "not a drop target here", and that is the whole failure mode.
  modal.addEventListener('dragover', (e) => {
    if (!claimable(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = canAttachNow() ? 'copy' : 'none';
  });

  modal.addEventListener('dragleave', (e) => {
    if (!claimable(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) endDrag();
  });

  modal.addEventListener('drop', async (e) => {
    const d = describeDrag(e);
    if (!d.files && !d.link) return;
    e.preventDefault();
    endDrag();
    if (!canAttachNow()) return;

    const errEl = document.getElementById('docErr');
    const files = (e.dataTransfer && e.dataTransfer.files) || [];

    // Nothing arriving as a file is the case that used to vanish without a
    // word. Say what came through, and what to do instead.
    if (!files.length) {
      errEl.textContent = d.link
        ? 'That was dragged as a link to a file rather than the file itself - usually an attachment pulled straight out of an email in the browser. Save it to your computer first and drag it from there, or use "choose files".'
        : 'Nothing arrived as a file. Save the document to your computer and drag it from there, or use "choose files".';
      document.getElementById('documentsSection').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }

    await addFiles(files);
    // the list is at the bottom of a long form, so show what just happened
    document.getElementById('documentsSection').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  // A file dropped outside the deal window would otherwise navigate away from
  // the page and lose whatever is half-typed in the form.
  ['dragover', 'drop'].forEach((type) =>
    window.addEventListener(type, (e) => {
      if (claimable(e) && !modal.contains(e.target)) e.preventDefault();
    })
  );

  document.getElementById('closePreview').addEventListener('click', closePreview);
  document.getElementById('previewModal').addEventListener('click', (e) => {
    // clicking the dark surround closes it, the sheet itself does not
    if (e.target.id === 'previewModal') closePreview();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('previewModal').classList.contains('hidden')) {
      closePreview();
    }
  });

  document.getElementById('docList').addEventListener('click', async (e) => {
    const preview = e.target.closest('[data-preview-id]');
    if (preview) {
      const doc = savedDocuments.find((d) => String(d.id) === preview.dataset.previewId);
      if (doc) openPreview(doc);
      return;
    }

    const button = e.target.closest('.doc-remove');
    if (!button) return;

    if (button.dataset.pendingIndex !== undefined) {
      pendingFiles.splice(Number(button.dataset.pendingIndex), 1);
      renderDocuments();
      return;
    }

    const id = button.dataset.docId;
    if (!confirm('Remove this document? This cannot be undone.')) return;
    try {
      await api(`/api/documents/${id}`, { method: 'DELETE' });
      savedDocuments = savedDocuments.filter((d) => String(d.id) !== String(id));
      renderDocuments();
    } catch (err) {
      document.getElementById('docErr').textContent = err.message;
    }
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
  document.getElementById('btnArchiveDeal').classList.add('hidden');
  document.getElementById('btnRestoreDeal').classList.add('hidden');
  openDealIsArchived = false;
  openDealStage = null;
  autofilled = {};
  document.getElementById('customerFilled').classList.add('hidden');
  document.getElementById('dealErr').textContent = '';
  document.getElementById('f_owner_id').value = currentUser.id;
  document.getElementById('f_stage').value = 'Lead';
  document.getElementById('f_probability').value = stageProbabilities.Lead ?? 10;
  document.getElementById('activitySection').classList.add('hidden');
  pendingFiles = [];
  savedDocuments = [];
  document.getElementById('docErr').textContent = '';
  renderDocuments();
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
    openDealStage = deal.stage;
    openDealIsArchived = Boolean(deal.archived_at);
    document.getElementById('btnArchiveDeal').classList.toggle('hidden', openDealIsArchived);
    document.getElementById('btnRestoreDeal').classList.toggle('hidden', !openDealIsArchived);
    loadActivity(id);
    loadDocuments(id);
  }

  // An archived deal is a closed record: its documents stay readable, but
  // nothing new goes on to it until someone restores it.
  const canAttach = currentUser.canEditDeals && !openDealIsArchived;
  document.getElementById('dropzone').classList.toggle('hidden', !canAttach);
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
  wireDocuments();

  // Built from the server's list rather than hardcoded in the markup, so adding
  // a category is a one-line change in constants.js.
  const categories = window.__APP_CATEGORIES__ || [];
  document.getElementById('f_product_category').innerHTML = categories
    .map((c) => `<option>${escapeHtml(c)}</option>`)
    .join('');
  document.getElementById('filterCategory').innerHTML =
    '<option value="">All categories</option>' +
    categories.map((c) => `<option>${escapeHtml(c)}</option>`).join('');
  await loadUsersForOwnerSelect();
  await Promise.all([loadDeals(), loadCustomers()]);

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
  document.querySelectorAll('#statusFilter .segment').forEach((btn) =>
    btn.addEventListener('click', () => {
      setDealStatus(btn.dataset.status);
      loadDeals();
    })
  );

  // Choosing an explicit stage is a narrower answer to the same question, so
  // the split steps aside rather than fighting it.
  document.getElementById('filterStage').addEventListener('change', (e) => {
    if (e.target.value) setDealStatus('all');
  });
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

  document.getElementById('f_customer_name').addEventListener('input', applyCustomerDetails);
  document.getElementById('f_customer_name').addEventListener('change', applyCustomerDetails);

  document.getElementById('f_value').addEventListener('input', updateGpReadout);
  document.getElementById('f_cost').addEventListener('input', updateGpReadout);

  document.getElementById('f_stage').addEventListener('change', (e) => {
    const suggested = stageProbabilities[e.target.value];
    if (suggested !== undefined) document.getElementById('f_probability').value = suggested;
    applyWonDates(e.target.value);
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
        const { deal } = await api('/api/deals', { method: 'POST', body });
        // The deal had no id while it was being typed, so anything dropped on
        // it is attached now that there is something to attach it to.
        const failures = await uploadPendingFiles(deal.id);
        if (failures.length) {
          // The deal itself saved; say what didn't, and leave the form open on
          // it so the files can be tried again.
          await loadDeals();
          document.getElementById('dealId').value = deal.id;
          document.getElementById('dealModalTitle').textContent = 'Edit Deal';
          await loadDocuments(deal.id);
          errEl.textContent = `Deal saved, but some documents did not attach: ${failures.join(' · ')}`;
          return;
        }
      }
      closeDealModal();
      await Promise.all([loadDeals(), loadCustomers()]);
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
