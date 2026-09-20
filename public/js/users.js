let currentUser = null;

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let allUsers = [];

async function loadUsers() {
  const { users } = await api('/api/users');
  allUsers = users;
  document.getElementById('usersBody').innerHTML = users
    .map(
      (u) => `
      <tr>
        <td>${escapeHtml(u.name)}${u.id === currentUser.id ? ' <span class="muted-note">(you)</span>' : ''}</td>
        <td>${escapeHtml(u.email)}</td>
        <td>${u.role}</td>
        <td>${u.active ? 'Active' : 'Deactivated'}</td>
        <td>${u.must_change_password ? '<span class="badge Lead">Must change</span>' : '<span class="muted-note">Set</span>'}</td>
        <td style="text-align:right; white-space:nowrap;">
          <button class="btn small secondary" data-action="edit" data-id="${u.id}">Edit</button>
          ${
            u.id === currentUser.id
              ? ''
              : `<button class="btn small danger" data-action="delete" data-id="${u.id}">Delete</button>`
          }
        </td>
      </tr>`
    )
    .join('');

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
  if (!currentUser.canManageUsers) {
    window.location.href = '/index.html';
    return;
  }
  renderTopbar('users', currentUser);
  await loadUsers();
  await loadSettings();

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
    alert('Settings saved.');
  });

})();
