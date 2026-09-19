let currentUser = null;

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadUsers() {
  const { users } = await api('/api/users');
  document.getElementById('usersBody').innerHTML = users
    .map(
      (u) => `
      <tr>
        <td>${escapeHtml(u.name)}</td>
        <td>${escapeHtml(u.email)}</td>
        <td>${u.role}</td>
        <td>${u.active ? 'Active' : 'Deactivated'}</td>
        <td>
          ${
            u.id === currentUser.id
              ? ''
              : `<button class="btn small secondary" data-action="toggle" data-id="${u.id}" data-active="${u.active ? '1' : '0'}" data-role="${u.role}">${u.active ? 'Deactivate' : 'Activate'}</button>
                 <button class="btn small danger" data-action="delete" data-id="${u.id}">Delete</button>`
          }
        </td>
      </tr>`
    )
    .join('');

  document.querySelectorAll('[data-action="toggle"]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      // role must be sent back unchanged — the endpoint rewrites it, so omitting
      // it would silently demote an admin to sales on every toggle
      await api(`/api/users/${btn.dataset.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: btn.dataset.active !== '1', role: btn.dataset.role })
      });
      await loadUsers();
    })
  );
  document.querySelectorAll('[data-action="delete"]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this user? Their deals will be unassigned, not deleted.')) return;
      await api(`/api/users/${btn.dataset.id}`, { method: 'DELETE' });
      await loadUsers();
    })
  );
}

async function loadSettings() {
  const { settings } = await api('/api/settings');
  document.getElementById('s_company_name').value = settings.company_name || '';
  document.getElementById('s_currency').value = settings.currency || 'AED';
}

(async () => {
  currentUser = await requireSession();
  if (!currentUser) return;
  if (currentUser.role !== 'admin') {
    window.location.href = '/index.html';
    return;
  }
  renderTopbar('users', currentUser);
  await loadUsers();
  await loadSettings();

  document.getElementById('btnAddUser').addEventListener('click', () => document.getElementById('userModal').classList.remove('hidden'));
  document.getElementById('cancelUser').addEventListener('click', () => document.getElementById('userModal').classList.add('hidden'));

  document.getElementById('userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('userErr');
    errEl.textContent = '';
    try {
      await api('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('u_name').value,
          email: document.getElementById('u_email').value,
          password: document.getElementById('u_password').value,
          role: document.getElementById('u_role').value
        })
      });
      document.getElementById('userModal').classList.add('hidden');
      document.getElementById('userForm').reset();
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
