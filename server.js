const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const config = require('./config');
const db = require('./db');

const app = express();
const PORT = config.port;
const OPEN_STAGES = ['Lead', 'Qualified', 'Proposal Sent', 'Negotiation'];

// behind Render's HTTPS proxy, trust the forwarded protocol so secure cookies work
if (config.isProduction) app.set('trust proxy', 1);

app.use(express.json());

// Sessions live in Postgres, not memory: Render restarts the container on every
// deploy, and an in-memory store would sign everyone out each time.
const PgSession = require('connect-pg-simple')(session);
app.use(
  session({
    store: new PgSession({ pool: db.pool, tableName: 'user_sessions', createTableIfMissing: true }),
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

// Wraps an async route so a rejected promise becomes a normal error response
// instead of an unhandled rejection that takes the process down.
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

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
app.post(
  '/api/login',
  route(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await db.one('SELECT * FROM users WHERE email = $1 AND active = TRUE', [
      email.toLowerCase().trim()
    ]);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    req.session.user = publicUser(user);
    res.json({ user: req.session.user });
  })
);

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({ user: req.session.user || null });
});

app.post(
  '/api/change-password',
  requireAuth,
  route(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }
    const user = await db.one('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
    if (!bcrypt.compareSync(currentPassword || '', user.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      bcrypt.hashSync(newPassword, 10),
      user.id
    ]);
    res.json({ ok: true });
  })
);

// ---------- user management ----------
app.get(
  '/api/users',
  requireAuth,
  route(async (req, res) => {
    const users = await db.all(
      'SELECT id, name, email, role, active, created_at FROM users ORDER BY name'
    );
    res.json({ users });
  })
);

app.post(
  '/api/users',
  requireAdmin,
  route(async (req, res) => {
    const { name, email, password, role } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    try {
      const row = await db.one(
        'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
        [name.trim(), email.toLowerCase().trim(), bcrypt.hashSync(password, 10), role === 'admin' ? 'admin' : 'sales']
      );
      res.json({ id: row.id });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'A user with that email already exists' });
      throw e;
    }
  })
);

app.patch(
  '/api/users/:id',
  requireAdmin,
  route(async (req, res) => {
    const { role, active, name } = req.body || {};
    const user = await db.one('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await db.query('UPDATE users SET role = $1, active = $2, name = $3 WHERE id = $4', [
      role === 'admin' ? 'admin' : 'sales',
      !(active === false || active === 0),
      name || user.name,
      req.params.id
    ]);
    res.json({ ok: true });
  })
);

app.delete(
  '/api/users/:id',
  requireAdmin,
  route(async (req, res) => {
    if (Number(req.params.id) === req.session.user.id) {
      return res.status(400).json({ error: "You can't delete your own account" });
    }
    // deals keep their history; the foreign key nulls the owner automatically
    await db.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  })
);

// ---------- settings ----------
app.get(
  '/api/settings',
  requireAuth,
  route(async (req, res) => {
    const rows = await db.all('SELECT key, value FROM settings');
    const settings = {};
    rows.forEach((r) => (settings[r.key] = r.value));
    res.json({ settings, stageProbabilities: db.defaultProbabilities });
  })
);

app.patch(
  '/api/settings',
  requireAdmin,
  route(async (req, res) => {
    const { currency, company_name } = req.body || {};
    const upsert = `INSERT INTO settings (key, value) VALUES ($1, $2)
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
    if (currency) await db.query(upsert, ['currency', currency]);
    if (company_name) await db.query(upsert, ['company_name', company_name]);
    res.json({ ok: true });
  })
);

// ---------- deals ----------
function loadDeal(id) {
  return db.one(
    `SELECT d.*, u.name AS owner_name
     FROM deals d LEFT JOIN users u ON u.id = d.owner_id
     WHERE d.id = $1`,
    [id]
  );
}

app.get(
  '/api/deals',
  requireAuth,
  route(async (req, res) => {
    const { stage, category, search, ownerId } = req.query;
    let sql = `SELECT d.*, u.name AS owner_name
               FROM deals d LEFT JOIN users u ON u.id = d.owner_id
               WHERE 1=1`;
    const params = [];

    if (stage) {
      params.push(stage);
      sql += ` AND d.stage = $${params.length}`;
    }
    if (category) {
      params.push(category);
      sql += ` AND d.product_category = $${params.length}`;
    }
    if (ownerId) {
      params.push(ownerId);
      sql += ` AND d.owner_id = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      sql += ` AND (d.customer_name ILIKE $${params.length}
                 OR d.contact_name ILIKE $${params.length}
                 OR d.description ILIKE $${params.length})`;
    }
    sql += ' ORDER BY d.updated_at DESC';

    res.json({ deals: await db.all(sql, params) });
  })
);

app.get(
  '/api/deals/:id',
  requireAuth,
  route(async (req, res) => {
    const deal = await loadDeal(req.params.id);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });
    res.json({ deal });
  })
);

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

app.post(
  '/api/deals',
  requireAuth,
  route(async (req, res) => {
    const b = req.body || {};
    const errors = validateDealBody(b);
    if (errors.length) return res.status(400).json({ error: errors.join(', ') });

    const wonLostDate = ['Won', 'Lost'].includes(b.stage)
      ? b.won_lost_date || new Date().toISOString().slice(0, 10)
      : null;
    const probability =
      b.probability !== undefined && b.probability !== '' ? Number(b.probability) : db.defaultProbabilities[b.stage];

    const row = await db.one(
      `INSERT INTO deals
        (customer_name, contact_name, contact_email, contact_phone, product_category,
         description, value, cost, stage, probability, expected_close_date,
         won_lost_date, owner_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [
        b.customer_name.trim(),
        b.contact_name || null,
        b.contact_email || null,
        b.contact_phone || null,
        b.product_category,
        b.description || null,
        Number(b.value),
        parseCost(b.cost),
        b.stage,
        probability,
        b.expected_close_date || null,
        wonLostDate,
        b.owner_id || req.session.user.id,
        b.notes || null
      ]
    );

    res.json({ deal: await loadDeal(row.id) });
  })
);

app.put(
  '/api/deals/:id',
  requireAuth,
  route(async (req, res) => {
    const existing = await loadDeal(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Deal not found' });

    const b = req.body || {};
    const errors = validateDealBody(b);
    if (errors.length) return res.status(400).json({ error: errors.join(', ') });

    const wonLostDate = ['Won', 'Lost'].includes(b.stage)
      ? b.won_lost_date || existing.won_lost_date || new Date().toISOString().slice(0, 10)
      : null;
    const probability =
      b.probability !== undefined && b.probability !== '' ? Number(b.probability) : db.defaultProbabilities[b.stage];

    await db.query(
      `UPDATE deals SET
         customer_name = $1, contact_name = $2, contact_email = $3, contact_phone = $4,
         product_category = $5, description = $6, value = $7, cost = $8, stage = $9,
         probability = $10, expected_close_date = $11, won_lost_date = $12,
         owner_id = $13, notes = $14, updated_at = NOW()
       WHERE id = $15`,
      [
        b.customer_name.trim(),
        b.contact_name || null,
        b.contact_email || null,
        b.contact_phone || null,
        b.product_category,
        b.description || null,
        Number(b.value),
        parseCost(b.cost),
        b.stage,
        probability,
        b.expected_close_date || null,
        wonLostDate,
        b.owner_id || existing.owner_id,
        b.notes || null,
        req.params.id
      ]
    );

    res.json({ deal: await loadDeal(req.params.id) });
  })
);

app.delete(
  '/api/deals/:id',
  requireAuth,
  route(async (req, res) => {
    await db.query('DELETE FROM deals WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  })
);

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

  const from = new Date(y, m, 1);
  const to = new Date(y, m + 1, 0);
  return { from: fmt(from), to: fmt(to), label: from.toLocaleString('en-US', { month: 'long', year: 'numeric' }) };
}

app.get(
  '/api/dashboard',
  requireAuth,
  route(async (req, res) => {
    const { range, from: fromQ, to: toQ } = req.query;
    const { from, to, label } = computeRange(range, fromQ, toQ);

    const openDeals = await db.all(
      `SELECT * FROM deals
       WHERE stage = ANY($1) AND expected_close_date IS NOT NULL
         AND expected_close_date BETWEEN $2 AND $3`,
      [OPEN_STAGES, from, to]
    );

    const openDealsNoDate = await db.all(
      'SELECT * FROM deals WHERE stage = ANY($1) AND expected_close_date IS NULL',
      [OPEN_STAGES]
    );

    const wonDeals = await db.all(
      "SELECT * FROM deals WHERE stage = 'Won' AND won_lost_date BETWEEN $1 AND $2",
      [from, to]
    );

    const lostDeals = await db.all(
      "SELECT * FROM deals WHERE stage = 'Lost' AND won_lost_date BETWEEN $1 AND $2",
      [from, to]
    );

    const totalOpenValue = openDeals.reduce((s, d) => s + d.value, 0);
    const weightedOpenValue = openDeals.reduce((s, d) => s + (d.value * d.probability) / 100, 0);
    const wonValue = wonDeals.reduce((s, d) => s + d.value, 0);
    const lostValue = lostDeals.reduce((s, d) => s + d.value, 0);
    const winRate =
      wonDeals.length + lostDeals.length > 0
        ? (wonDeals.length / (wonDeals.length + lostDeals.length)) * 100
        : null;

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
      .map((d) => ({
        id: d.id,
        customer_name: d.customer_name,
        value: d.value,
        stage: d.stage,
        expected_close_date: d.expected_close_date
      }));

    const recentWon = wonDeals
      .slice()
      .sort((a, b) => (b.won_lost_date || '').localeCompare(a.won_lost_date || ''))
      .slice(0, 8)
      .map((d) => ({
        id: d.id,
        customer_name: d.customer_name,
        value: d.value,
        won_lost_date: d.won_lost_date
      }));

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
        openGp: grossProfit(openDeals),
        wonGp: grossProfit(wonDeals)
      },
      byStage,
      byCategory,
      monthly,
      topOpenDeals,
      recentWon,
      unscheduledOpenCount: openDealsNoDate.length,
      unscheduledOpenValue: openDealsNoDate.reduce((s, d) => s + d.value, 0)
    });
  })
);

app.use(express.static(path.join(__dirname, 'public')));

// Any error thrown in a route lands here rather than crashing the process.
app.use((err, req, res, next) => {
  console.error('Request failed:', req.method, req.path, '-', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

async function start() {
  try {
    await db.init();
  } catch (e) {
    console.error(`\n  DATABASE ERROR: could not connect or set up tables.\n  ${e.message}\n`);
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`V Living Trading Tracker running at http://localhost:${PORT}`);
  });
}

start();
