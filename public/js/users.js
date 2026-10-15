let currentUser = null;

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let allUsers = [];

// "3 minutes ago" reads better than a timestamp for the recent end, which is
// the end anyone actually looks at, and falls back to a date further out.
function timeAgo(iso) {
  if (!iso) return 'Never';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 90) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days <= 14) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

async function loadUsers() {
  const { users } = await api('/api/users');
  allUsers = users;
  const canManage = currentUser.canManageUsers;
  const canSeeActivity = currentUser.canViewActivity;

  document.getElementById('usersBody').innerHTML = users
    .map(
      (u) => `
      <tr>
        <td>${escapeHtml(u.name)}${u.id === currentUser.id ? ' <span class="muted-note">(you)</span>' : ''}</td>
        <td>${escapeHtml(u.email)}</td>
        <td>${u.role}</td>
        <td>${u.active ? 'Active' : 'Deactivated'}</td>
        <td>${u.last_seen_at ? timeAgo(u.last_seen_at) : '<span class="muted-note">Never signed in</span>'}</td>
        <td>${u.must_change_password ? '<span class="badge Lead">Must change</span>' : '<span class="muted-note">Set</span>'}</td>
        <td style="text-align:right; white-space:nowrap;">
          ${canSeeActivity ? `<button class="btn small secondary" data-action="activity" data-id="${u.id}">Activity</button>` : ''}
          ${canManage ? `<button class="btn small secondary" data-action="edit" data-id="${u.id}">Edit</button>` : ''}
          ${
            canManage && u.id !== currentUser.id
              ? `<button class="btn small danger" data-action="delete" data-id="${u.id}">Delete</button>`
              : ''
          }
        </td>
      </tr>`
    )
    .join('');

  document.querySelectorAll('[data-action="activity"]').forEach((btn) =>
    btn.addEventListener('click', () => openActivity(Number(btn.dataset.id)))
  );
  document.querySelectorAll('[data-action="edit"]').forEach((btn) =>
    btn.addEventListener('click', () => openUserModal(Number(btn.dataset.id)))
  );
  document.querySelectorAll('[data-action="delete"]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this user? Their deals stay, but become unassigned.')) return;
      await api(`/api/users/${btn.dataset.id}`, { method: 'DELETE' });
      await loadUsers();
    })
  );
}

// ---------- activity log ----------
let activityUserId = null;

// Plain-English names for the recorded actions. Anything unrecognised falls
// back to its own key with the underscores taken out, so a newly recorded
// action shows up readably rather than not at all.
const ACTION_LABELS = {
  created: 'Deal created',
  updated: 'Deal edited',
  deleted: 'Deal deleted',
  archived: 'Deal archived',
  restored: 'Deal restored',
  document_added: 'Document attached',
  document_removed: 'Document removed',
  signed_in: 'Signed in',
  sign_in_failed: 'Failed sign-in',
  signed_out: 'Signed out',
  password_changed: 'Changed their password',
  user_created: 'Created a user',
  user_updated: 'Edited a user',
  user_deactivated: 'Deactivated a user',
  user_reactivated: 'Reactivated a user',
  user_password_reset: 'Reset a password',
  user_deleted: 'Deleted a user',
  report_run: 'Ran a report'
};

const actionLabel = (a) => ACTION_LABELS[a] || a.replace(/_/g, ' ');

function describeEvent(e) {
  const who = activityUserId ? '' : `<span class="event-actor">${escapeHtml(e.actor_name || 'Unknown')}</span> · `;
  let what = actionLabel(e.action);

  if (e.source === 'deal') {
    if (e.action === 'updated' && e.field) {
      const from = e.old_value === null || e.old_value === '' ? 'empty' : e.old_value;
      const to = e.new_value === null || e.new_value === '' ? 'empty' : e.new_value;
      what = `${e.subject ? escapeHtml(e.subject) + ' — ' : ''}${escapeHtml(e.field)}: ${escapeHtml(from)} → ${escapeHtml(to)}`;
    } else {
      const extra = e.action.startsWith('document') ? e.new_value || e.old_value : null;
      what = `${what}${e.subject ? `: ${escapeHtml(e.subject)}` : ''}${extra ? ` (${escapeHtml(extra)})` : ''}`;
    }
  } else if (e.subject) {
    what = `${what}: ${escapeHtml(e.subject)}`;
  }

  const detail = e.detail ? `<div class="event-detail">${escapeHtml(e.detail)}</div>` : '';
  return `${who}${what}${detail}`;
}

async function loadActivity() {
  const list = document.getElementById('activityEvents');
  list.innerHTML = '<li class="muted-note">Loading…</li>';

  const days = document.getElementById('activityDays').value;
  const query = `days=${days}${activityUserId ? `&userId=${activityUserId}` : ''}`;

  try {
    const data = await api(`/api/activity?${query}`);

    document.getElementById('activityTitle').textContent = data.user ? data.user.name : 'System Log';
    document.getElementById('activitySub').textContent = data.user
      ? `${data.user.role} · ${data.user.active ? 'active' : 'deactivated'} · last seen ${timeAgo(data.user.last_seen_at).toLowerCase()}`
      : 'Everything recorded across all users';

    const total = (label, keys) => {
      const rows = data.summary.filter((s) => keys.includes(s.action));
      return {
        label,
        week: rows.reduce((n, r) => n + r.week, 0),
        month: rows.reduce((n, r) => n + r.month, 0)
      };
    };
    const tiles = [
      total('Deals created', ['created']),
      total('Deals edited', ['updated']),
      total('Documents added', ['document_added']),
      total('Sign-ins', ['signed_in']),
      total('Reports run', ['report_run'])
    ];
    document.getElementById('activitySummary').innerHTML = tiles
      .map(
        (t) => `<div class="summary-tile">
          <span class="summary-label">${t.label}</span>
          <span class="summary-value">${t.week}<span class="summary-unit">7d</span></span>
          <span class="summary-month">${t.month} in 30 days</span>
        </div>`
      )
      .join('');

    document.getElementById('activityCount').textContent = `${data.events.length} event${data.events.length === 1 ? '' : 's'}`;

    if (!data.events.length) {
      list.innerHTML = '<li class="muted-note">Nothing recorded in this period.</li>';
    } else {
      list.innerHTML = data.events
        .map((e) => {
          const when = new Date(e.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
          return `<li class="activity-item ${e.action}">
            <div class="activity-what">${describeEvent(e)}</div>
            <div class="activity-who">${when}</div>
          </li>`;
        })
        .join('');
    }

    // Said plainly, because a log that starts partway through looks like an
    // absence of activity rather than an absence of recording.
    document.getElementById('activityFootnote').textContent = data.recordingSince
      ? `Recording began ${new Date(data.recordingSince).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}. Nothing before that date was captured.`
      : '';
  } catch (e) {
    list.innerHTML = `<li class="muted-note">Could not load activity: ${escapeHtml(e.message)}</li>`;
  }
}

function openActivity(userId) {
  activityUserId = userId;
  document.getElementById('activityDrawer').classList.remove('hidden');
  loadActivity();
}

function closeActivity() {
  document.getElementById('activityDrawer').classList.add('hidden');
}

function openUserModal(id) {
  const form = document.getElementById('userForm');
  form.reset();
  document.getElementById('userErr').textContent = '';
  document.getElementById('u_id').value = id || '';

  const editing = Boolean(id);
  document.getElementById('userModalTitle').textContent = editing ? 'Edit User' : 'Add User';
  document.getElementById('userSubmit').textContent = editing ? 'Save Changes' : 'Create User';
  document.getElementById('u_activeWrap').classList.toggle('hidden', !editing);
  document.getElementById('u_password').required = !editing;
  document.getElementById('u_passwordLabel').textContent = editing
    ? 'Reset password (leave blank to keep current)'
    : 'Temporary password *';
  document.getElementById('u_passwordHint').textContent = editing
    ? 'If you set one, they must choose their own the next time they sign in.'
    : "They'll be asked to set their own password when they first sign in.";

  if (editing) {
    const u = allUsers.find((x) => x.id === id);
    document.getElementById('u_name').value = u.name;
    document.getElementById('u_email').value = u.email;
    document.getElementById('u_role').value = u.role;
    document.getElementById('u_active').value = u.active ? '1' : '0';
  }

  document.getElementById('userModal').classList.remove('hidden');
}

async function loadSettings() {
  const { settings } = await api('/api/settings');
  document.getElementById('s_company_name').value = settings.company_name || '';
  document.getElementById('s_currency').value = settings.currency || 'AED';
}

(async () => {
  currentUser = await requireSession();
  if (!currentUser) return;
  // Management reaches this page for the activity log alone: the directory and
  // the log, with nothing on it they can change.
  if (!currentUser.canManageUsers && !currentUser.canViewActivity) {
    window.location.href = '/index.html';
    return;
  }
  renderTopbar('users', currentUser);

  const readOnly = !currentUser.canManageUsers;
  if (readOnly) {
    document.getElementById('btnAddUser').classList.add('hidden');
    document.querySelector('.page-header h1').textContent = 'Users & Activity';
  }
  document.getElementById('btnSystemLog').classList.toggle('hidden', !currentUser.canViewActivity);

  await loadUsers();
  if (!readOnly) await loadSettings();
  else document.getElementById('settingsForm').closest('.card').classList.add('hidden');

  document.getElementById('btnSystemLog').addEventListener('click', () => openActivity(null));
  document.getElementById('closeActivity').addEventListener('click', closeActivity);
  document.getElementById('activityDays').addEventListener('change', loadActivity);
  document.getElementById('activityDrawer').addEventListener('click', (e) => {
    if (e.target.id === 'activityDrawer') closeActivity();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('activityDrawer').classList.contains('hidden')) {
      closeActivity();
    }
  });

  document.getElementById('btnAddUser').addEventListener('click', () => openUserModal(null));
  document.getElementById('cancelUser').addEventListener('click', () => document.getElementById('userModal').classList.add('hidden'));

  document.getElementById('userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('userErr');
    errEl.textContent = '';
    const id = document.getElementById('u_id').value;
    const name = document.getElementById('u_name').value;
    const email = document.getElementById('u_email').value;
    const password = document.getElementById('u_password').value;
    const role = document.getElementById('u_role').value;

    try {
      if (id) {
        await api(`/api/users/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name,
            email,
            role,
            active: document.getElementById('u_active').value === '1',
            newPassword: password || undefined
          })
        });
      } else {
        await api('/api/users', { method: 'POST', body: JSON.stringify({ name, email, password, role }) });
      }
      document.getElementById('userModal').classList.add('hidden');
      await loadUsers();
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  document.getElementById('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({
        company_name: document.getElementById('s_company_name').value,
        currency: document.getElementById('s_currency').value
      })
    });
    showToast('Settings saved.');
  });

})();
