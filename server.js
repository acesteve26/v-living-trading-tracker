const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { db, defaultProbabilities } = require('./db');

const app = express();
const PORT = config.port;
const OPEN_STAGES = ['Lead', 'Qualified', 'Proposal Sent', 'Negotiation'];

// behind Render's HTTPS proxy, trust the forwarded protocol so secure cookies work
if (config.isProduction) app.set('trust proxy', 1);

app.use(express.json());
app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 12, // 12 hours
      httpOnly: true,
      sameSite: 'lax',
      secure: config.secureCookies
    }
  })
);

// ---------- auth helpers ----------
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role, active: u.active };
}

// ---------- auth routes ----------
app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email.toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  req.session.user = publicUser(user);
  res.json({ user: req.session.user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({ user: req.session.user || null });
});

app.post('/api/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!bcrypt.compareSync(currentPassword || '', user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  res.json({ ok: true });
});

// ---------- user management (admin only) ----------
app.get('/api/users', requireAuth, (req, res) => {
  const users = db.prepare('SELECT id, name, email, role, active, created_at FROM users ORDER BY name').all();
  res.json({ users });
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = db
      .prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(name.trim(), email.toLowerCase().trim(), hash, role === 'admin' ? 'admin' : 'sales');
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'A user with that email already exists' });
    res.status(500).json({ error: 'Could not create user' });
  }
});

app.patch('/api/users/:id', requireAdmin, (req, res) => {
  const { role, active, name } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET role = ?, active = ?, name = ? WHERE id = ?').run(
    role === 'admin' ? 'admin' : 'sales',
    active === false || active === 0 ? 0 : 1,
    name || user.name,
    req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  if (Number(req.params.id) === req.session.user.id) {
    return res.status(400).json({ error: "You can't delete your own account" });
  }
  db.prepare('UPDATE deals SET owner_id = NULL WHERE owner_id = ?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- settings ----------
app.get('/api/settings', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach((r) => (settings[r.key] = r.value));
  res.json({ settings, stageProbabilities: defaultProbabilities });
});

app.patch('/api/settings', requireAdmin, (req, res) => {
  const { currency, company_name } = req.body || {};
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  if (currency) upsert.run('currency', currency);
  if (company_name) upsert.run('company_name', company_name);
  res.json({ ok: true });
});

// ---------- deals ----------
function loadDeal(id) {
  return db
    .prepare(
      `SELECT d.*, u.name AS owner_name FROM deals d LEFT JOIN users u ON u.id = d.owner_id WHERE d.id = ?`
    )
    .get(id);
}

app.get('/api/deals', requireAuth, (req, res) => {
  const { stage, category, search, ownerId } = req.query;
  let sql = `SELECT d.*, u.name AS owner_name FROM deals d LEFT JOIN users u ON u.id = d.owner_id WHERE 1=1`;
  const params = [];

  if (stage) {
    sql += ' AND d.stage = ?';
    params.push(stage);
  }
  if (category) {
    sql += ' AND d.product_category = ?';
    params.push(category);
  }
  if (ownerId) {
    sql += ' AND d.owner_id = ?';
    params.push(ownerId);
  }
  if (search) {
    sql += ' AND (d.customer_name LIKE ? OR d.contact_name LIKE ? OR d.description LIKE ?)';
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  sql += ' ORDER BY d.updated_at DESC';

  const deals = db.prepare(sql).all(...params);
  res.json({ deals });
});

app.get('/api/deals/:id', requireAuth, (req, res) => {
  const deal = loadDeal(req.params.id);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });
  res.json({ deal });
});

// cost is optional; null means "not captured yet" so GP is reported as unknown rather than 100%
function parseCost(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return isNaN(n) ? null : n;
}

function validateDealBody(body) {
  const errors = [];
  if (!body.customer_name || !body.customer_name.trim()) errors.push('Customer name is required');
  if (body.value === undefined || isNaN(Number(body.value)) || Number(body.value) < 0) errors.push('Value must be a positive number');
  if (body.cost !== undefined && body.cost !== null && body.cost !== '') {
    const c = Number(body.cost);
    if (isNaN(c) || c < 0) errors.push('Cost must be a positive number');
  }
  if (!['Tiles', 'Sanitaryware', 'Both', 'Other'].includes(body.product_category)) errors.push('Invalid product category');
  if (!['Lead', 'Qualified', 'Proposal Sent', 'Negotiation', 'Won', 'Lost'].includes(body.stage)) errors.push('Invalid stage');
  return errors;
}

app.post('/api/deals', requireAuth, (req, res) => {
  const b = req.body || {};
  const errors = validateDealBody(b);
  if (errors.length) return res.status(400).json({ error: errors.join(', ') });

  const wonLostDate = ['Won', 'Lost'].includes(b.stage) ? b.won_lost_date || new Date().toISOString().slice(0, 10) : null;
  const probability = b.probability !== undefined && b.probability !== '' ? Number(b.probability) : defaultProbabilities[b.stage];

  const info = db
    .prepare(
      `INSERT INTO deals
      (customer_name, contact_name, contact_email, contact_phone, product_category, description, value, cost, stage, probability, expected_close_date, won_lost_date, owner_id, notes)
      VALUES (@customer_name, @contact_name, @contact_email, @contact_phone, @product_category, @description, @value, @cost, @stage, @probability, @expected_close_date, @won_lost_date, @owner_id, @notes)`
    )
    .run({
      customer_name: b.customer_name.trim(),
      contact_name: b.contact_name || null,
      contact_email: b.contact_email || null,
      contact_phone: b.contact_phone || null,
      product_category: b.product_category,
      description: b.description || null,
      value: Number(b.value),
      cost: parseCost(b.cost),
      stage: b.stage,
      probability,
      expected_close_date: b.expected_close_date || null,
      won_lost_date: wonLostDate,
      owner_id: b.owner_id || req.session.user.id,
      notes: b.notes || null
    });

  res.json({ deal: loadDeal(info.lastInsertRowid) });
});

app.put('/api/deals/:id', requireAuth, (req, res) => {
  const existing = loadDeal(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Deal not found' });

  const b = req.body || {};
  const errors = validateDealBody(b);
  if (errors.length) return res.status(400).json({ error: errors.join(', ') });

  let wonLostDate = existing.won_lost_date;
  if (['Won', 'Lost'].includes(b.stage)) {
    wonLostDate = b.won_lost_date || existing.won_lost_date || new Date().toISOString().slice(0, 10);
  } else {
    wonLostDate = null;
  }
  const probability = b.probability !== undefined && b.probability !== '' ? Number(b.probability) : defaultProbabilities[b.stage];

  db.prepare(
    `UPDATE deals SET
      customer_name = @customer_name,
      contact_name = @contact_name,
      contact_email = @contact_email,
      contact_phone = @contact_phone,
      product_category = @product_category,
      description = @description,
      value = @value,
      cost = @cost,
      stage = @stage,
      probability = @probability,
      expected_close_date = @expected_close_date,
      won_lost_date = @won_lost_date,
      owner_id = @owner_id,
      notes = @notes,
      updated_at = datetime('now')
    WHERE id = @id`
  ).run({
    id: req.params.id,
    customer_name: b.customer_name.trim(),
    contact_name: b.contact_name || null,
    contact_email: b.contact_email || null,
    contact_phone: b.contact_phone || null,
    product_category: b.product_category,
    description: b.description || null,
    value: Number(b.value),
    cost: parseCost(b.cost),
    stage: b.stage,
    probability,
    expected_close_date: b.expected_close_date || null,
    won_lost_date: wonLostDate,
    owner_id: b.owner_id || existing.owner_id,
    notes: b.notes || null
  });

  res.json({ deal: loadDeal(req.params.id) });
});

app.delete('/api/deals/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM deals WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- dashboard ----------
function computeRange(range, fromQ, toQ) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  if (range === 'custom' && fromQ && toQ) return { from: fromQ, to: toQ, label: `${fromQ} to ${toQ}` };

  if (range === 'this_month') {
    const from = new Date(y, m, 1);
    const to = new Date(y, m + 1, 0);
    return { from: fmt(from), to: fmt(to), label: from.toLocaleString('en-US', { month: 'long', year: 'numeric' }) };
  }

  if (range === 'ytd') {
    const from = new Date(y, 0, 1);
    return { from: fmt(from), to: fmt(now), label: `Year to Date ${y}` };
  }

  const yearMatch = /^year:(\d{4})$/.exec(range);
  if (yearMatch) {
    const yr = Number(yearMatch[1]);
    return { from: `${yr}-01-01`, to: `${yr}-12-31`, label: `Full Year ${yr}` };
  }

  // default: this month
  const from = new Date(y, m, 1);
  const to = new Date(y, m + 1, 0);
  return { from: fmt(from), to: fmt(to), label: from.toLocaleString('en-US', { month: 'long', year: 'numeric' }) };
}

app.get('/api/dashboard', requireAuth, (req, res) => {
  const { range, from: fromQ, to: toQ } = req.query;
  const { from, to, label } = computeRange(range, fromQ, toQ);

  const openPlaceholders = OPEN_STAGES.map(() => '?').join(',');

  const openDeals = db
    .prepare(
      `SELECT * FROM deals WHERE stage IN (${openPlaceholders}) AND expected_close_date IS NOT NULL AND expected_close_date BETWEEN ? AND ?`
    )
    .all(...OPEN_STAGES, from, to);

  const openDealsNoDate = db
    .prepare(`SELECT * FROM deals WHERE stage IN (${openPlaceholders}) AND expected_close_date IS NULL`)
    .all(...OPEN_STAGES);

  const wonDeals = db
    .prepare(`SELECT * FROM deals WHERE stage = 'Won' AND won_lost_date BETWEEN ? AND ?`)
    .all(from, to);

  const lostDeals = db
    .prepare(`SELECT * FROM deals WHERE stage = 'Lost' AND won_lost_date BETWEEN ? AND ?`)
    .all(from, to);

  const totalOpenValue = openDeals.reduce((s, d) => s + d.value, 0);
  const weightedOpenValue = openDeals.reduce((s, d) => s + (d.value * d.probability) / 100, 0);
  const wonValue = wonDeals.reduce((s, d) => s + d.value, 0);
  const lostValue = lostDeals.reduce((s, d) => s + d.value, 0);
  const winRate = wonDeals.length + lostDeals.length > 0 ? (wonDeals.length / (wonDeals.length + lostDeals.length)) * 100 : null;

  // Gross profit only counts deals that actually have a cost captured, so a missing
  // cost never inflates GP. The counts let the UI say how much of the set is covered.
  function grossProfit(deals) {
    const priced = deals.filter((d) => d.cost !== null && d.cost !== undefined);
    const value = priced.reduce((s, d) => s + d.value, 0);
    const gp = priced.reduce((s, d) => s + (d.value - d.cost), 0);
    return {
      gp,
      marginPct: value > 0 ? (gp / value) * 100 : null,
      pricedCount: priced.length,
      totalCount: deals.length
    };
  }

  const openGp = grossProfit(openDeals);
  const wonGp = grossProfit(wonDeals);

  const byStage = {};
  OPEN_STAGES.forEach((s) => (byStage[s] = { count: 0, value: 0 }));
  openDeals.forEach((d) => {
    byStage[d.stage].count += 1;
    byStage[d.stage].value += d.value;
  });

  const byCategory = {};
  ['Tiles', 'Sanitaryware', 'Both', 'Other'].forEach((c) => (byCategory[c] = { count: 0, value: 0 }));
  openDeals.forEach((d) => {
    byCategory[d.product_category].count += 1;
    byCategory[d.product_category].value += d.value;
  });

  // monthly trend across the selected range
  const start = new Date(from);
  const end = new Date(to);
  const months = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cursor <= end) {
    months.push({ y: cursor.getFullYear(), m: cursor.getMonth() });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  const monthLabel = (y, m) => new Date(y, m, 1).toLocaleString('en-US', { month: 'short', year: '2-digit' });
  const monthly = months.map(({ y, m }) => {
    const monthStart = `${y}-${String(m + 1).padStart(2, '0')}-01`;
    const monthEndDate = new Date(y, m + 1, 0);
    const monthEnd = `${y}-${String(m + 1).padStart(2, '0')}-${String(monthEndDate.getDate()).padStart(2, '0')}`;
    const pipeline = openDeals
      .filter((d) => d.expected_close_date >= monthStart && d.expected_close_date <= monthEnd)
      .reduce((s, d) => s + d.value, 0);
    const won = wonDeals
      .filter((d) => d.won_lost_date >= monthStart && d.won_lost_date <= monthEnd)
      .reduce((s, d) => s + d.value, 0);
    return { label: monthLabel(y, m), pipeline, won };
  });

  const topOpenDeals = [...openDeals, ...openDealsNoDate]
    .sort((a, b) => b.value - a.value)
    .slice(0, 8)
    .map((d) => ({ id: d.id, customer_name: d.customer_name, value: d.value, stage: d.stage, expected_close_date: d.expected_close_date }));

  const recentWon = wonDeals
    .sort((a, b) => (b.won_lost_date || '').localeCompare(a.won_lost_date || ''))
    .slice(0, 8)
    .map((d) => ({ id: d.id, customer_name: d.customer_name, value: d.value, won_lost_date: d.won_lost_date }));

  res.json({
    range: { from, to, label },
    kpis: {
      totalOpenValue,
      weightedOpenValue,
      wonValue,
      lostValue,
      winRate,
      openCount: openDeals.length + openDealsNoDate.length,
      wonCount: wonDeals.length,
      lostCount: lostDeals.length,
      openGp,
      wonGp
    },
    byStage,
    byCategory,
    monthly,
    topOpenDeals,
    recentWon,
    unscheduledOpenCount: openDealsNoDate.length,
    unscheduledOpenValue: openDealsNoDate.reduce((s, d) => s + d.value, 0)
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`NVF Trading Tracker running at http://localhost:${PORT}`);
});
