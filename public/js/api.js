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
  const c = currency || (window.__NVF_CURRENCY__ || 'AED');
  const value = Number(n || 0);
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(value);
  } catch (e) {
    return `${c} ${value.toLocaleString()}`;
  }
};

const moneyCompact = (n) => {
  const c = window.__NVF_CURRENCY__ || 'AED';
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
    { href: '/deals.html', label: 'Deals', key: 'deals' }
  ];
  if (user.role === 'admin') navItems.push({ href: '/users.html', label: 'Users', key: 'users' });

  el.innerHTML = `
    <div class="brand">
      <a href="/index.html" class="logo-mark" aria-label="NVF Lifestyle"></a>
      <span class="divider"></span>
      <span class="app-name">Trading Tracker</span>
    </div>
    <nav>
      ${navItems
        .map((n) => `<a href="${n.href}" class="${n.key === activePage ? 'active' : ''}">${n.label}</a>`)
        .join('')}
    </nav>
    <div class="user-area">
      <span class="who">${user.name}</span>
      <span>${user.role}</span>
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
}

async function loadCurrency() {
  try {
    const { settings } = await api('/api/settings');
    window.__NVF_CURRENCY__ = settings.currency || 'AED';
    return settings;
  } catch (e) {
    window.__NVF_CURRENCY__ = 'AED';
    return {};
  }
}
