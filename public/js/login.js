// Kept out of login.html so the page carries no inline script, which lets the
// Content-Security-Policy forbid inline JavaScript outright.
(async () => {
  const { user } = await api('/api/session');
  if (user) window.location.href = '/index.html';
})();

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const errEl = document.getElementById('err');
  errEl.textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    window.location.href = '/index.html';
  } catch (err) {
    errEl.textContent = err.message;
  }
});
