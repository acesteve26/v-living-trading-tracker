function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const money = (n, currency) => {
  const c = currency || (window.__APP_CURRENCY__ || 'AED');
  const value = Number(n || 0);
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(value);
  } catch (e) {
    return `${c} ${value.toLocaleString()}`;
  }
};

const moneyCompact = (n) => {
  const c = window.__APP_CURRENCY__ || 'AED';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: c,
      notation: 'compact',
      maximumFractionDigits: 1
    }).format(Number(n || 0));
  } catch (e) {
    return money(n);
  }
};

async function requireSession() {
  const { user } = await api('/api/session');
  if (!user) {
    window.location.href = '/login.html';
    return null;
  }
  return user;
}

function renderTopbar(activePage, user) {
  const el = document.getElementById('topbar');
  if (!el) return;
  const navItems = [
    { href: '/index.html', label: 'Dashboard', key: 'dashboard' },
    { href: '/deals.html', label: 'Deals', key: 'deals' },
    { href: '/report.html', label: 'Report', key: 'report' }
  ];
  if (user.canManageUsers) navItems.push({ href: '/users.html', label: 'Users', key: 'users' });

  el.innerHTML = `
    <div class="brand">
      <a href="/index.html" class="logo-mark" aria-label="V Living — go to dashboard">V Living</a>
      <span class="divider"></span>
      <span class="app-name">Trading Tracker</span>
    </div>
    <nav>
      ${navItems
        .map((n) => `<a href="${n.href}" class="${n.key === activePage ? 'active' : ''}">${n.label}</a>`)
        .join('')}
    </nav>
    <div class="user-area">
      <span class="who">${escapeHtml(user.name)}</span>
      <span>${escapeHtml(user.role)}</span>
      <button id="btnAccount">Account</button>
      <button id="btnLogout">Log out</button>
    </div>
  `;

  document.getElementById('btnLogout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    window.location.href = '/login.html';
  });
  document.getElementById('btnAccount').addEventListener('click', () => {
    document.getElementById('accountModal').classList.remove('hidden');
  });

  wireAccountModal(Boolean(user.mustChangePassword));
  if (user.mustChangePassword) forcePasswordChange();
}

// One implementation for every page, rather than the same handler copied into
// each page script.
function wireAccountModal(forced) {
  const modal = document.getElementById('accountModal');
  if (!modal) return;

  const closeBtn = document.getElementById('closeAccount');
  if (closeBtn) closeBtn.addEventListener('click', () => modal.classList.add('hidden'));

  const form = document.getElementById('pwForm');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('pwErr');
    errEl.textContent = '';
    try {
      await api('/api/change-password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: document.getElementById('curPw').value,
          newPassword: document.getElementById('newPw').value
        })
      });
      form.reset();
      if (forced) {
        // reload so the rest of the app unlocks with the flag cleared
        window.location.reload();
        return;
      }
      modal.classList.add('hidden');
      alert('Password updated.');
    } catch (err) {
      errEl.textContent = err.message;
    }
  });
}

// A temporary password is outstanding: open the account panel, explain why, and
// remove the way out. The server blocks the rest of the API regardless, so this
// is about making the situation clear rather than being the actual gate.
function forcePasswordChange() {
  const modal = document.getElementById('accountModal');
  if (!modal) return;
  modal.classList.remove('hidden');

  const heading = modal.querySelector('h2');
  if (heading) heading.textContent = 'Choose your password';

  if (!modal.querySelector('.forced-note')) {
    const note = document.createElement('p');
    note.className = 'forced-note';
    note.textContent =
      'You are signing in with a temporary password set by an administrator. Choose your own to continue.';
    heading.insertAdjacentElement('afterend', note);
  }

  const closeBtn = document.getElementById('closeAccount');
  if (closeBtn) closeBtn.classList.add('hidden');
}

async function loadCurrency() {
  try {
    const { settings } = await api('/api/settings');
    window.__APP_CURRENCY__ = settings.currency || 'AED';
    return settings;
  } catch (e) {
    window.__APP_CURRENCY__ = 'AED';
    return {};
  }
}
