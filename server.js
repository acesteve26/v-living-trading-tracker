const path = require('path');
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
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

// Roles and what they can do. Everyone signed in can view deals and run
// reports; these two capabilities are the only things that differ.
const ROLES = ['admin', 'management', 'accounts', 'sales'];
// Management and accounts are deliberately read-only: they oversee and report,
// they don't work the pipeline.
const CAN_EDIT_DEALS = new Set(['admin', 'sales']);
const CAN_MANAGE_USERS = new Set(['admin']);

function normaliseRole(role, fallback = 'sales') {
  return ROLES.includes(role) ? role : fallback;
}

function requireAdmin(req, res, next) {
  if (!req.session.user || !CAN_MANAGE_USERS.has(req.session.user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function requireDealEditor(req, res, next) {
  if (!req.session.user || !CAN_EDIT_DEALS.has(req.session.user.role)) {
    return res.status(403).json({ error: 'Your role has read-only access to deals' });
  }
  next();
}

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    active: u.active,
    mustChangePassword: u.must_change_password === true,
    canEditDeals: CAN_EDIT_DEALS.has(u.role),
    canManageUsers: CAN_MANAGE_USERS.has(u.role)
  };
}

// While a temporary password is outstanding, the account can do nothing except
// look at itself, change the password, or log out. Enforced here rather than
// only in the UI, so it can't be sidestepped by calling the API directly.
const PASSWORD_CHANGE_EXEMPT = new Set(['/api/session', '/api/change-password', '/api/logout', '/api/login']);

app.use('/api', (req, res, next) => {
  if (!req.session.user || !req.session.user.mustChangePassword) return next();
  const pathWithoutQuery = req.originalUrl.split('?')[0];
  if (PASSWORD_CHANGE_EXEMPT.has(pathWithoutQuery)) return next();
  res.status(403).json({ error: 'Set a new password before continuing.', mustChangePassword: true });
});

// ---------- rate limiting ----------
// The app is on the public internet, so the login is reachable by anyone. Only
// FAILED attempts count, so a busy day of normal use never trips it, while
// password guessing stops after a handful of tries.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many failed sign-in attempts. Please wait 15 minutes and try again.' }
});

// A far looser ceiling on everything else, to blunt scripted abuse without
// getting in the way of someone clicking around quickly.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down and try again shortly.' }
});

app.use('/api', apiLimiter);

// ---------- auth routes ----------
app.post(
  '/api/login',
  loginLimiter,
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

// Re-read the user from the database rather than trusting what the session
// stored at login. Sessions survive deploys, so a stored copy goes stale: it
// misses fields added since, keeps a role that has since been changed, and
// lets a deactivated account keep working until the session expires.
app.get(
  '/api/session',
  route(async (req, res) => {
    if (!req.session.user) return res.json({ user: null });

    const fresh = await db.one('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
    if (!fresh || !fresh.active) {
      return req.session.destroy(() => res.json({ user: null }));
    }

    req.session.user = publicUser(fresh);
    res.json({ user: req.session.user });
  })
);

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
    await db.query(
      'UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2',
      [bcrypt.hashSync(newPassword, 10), user.id]
    );
    // the session carries the flag, so clear it there too or the block persists
    req.session.user.mustChangePassword = false;
    res.json({ ok: true });
  })
);

// ---------- user management ----------
app.get(
  '/api/users',
  requireAuth,
  route(async (req, res) => {
    const users = await db.all(
      'SELECT id, name, email, role, active, must_change_password, created_at FROM users ORDER BY name'
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
      // the admin sets a temporary password here, so the new user must replace it
      const row = await db.one(
        `INSERT INTO users (name, email, password_hash, role, must_change_password)
         VALUES ($1, $2, $3, $4, TRUE) RETURNING id`,
        [name.trim(), email.toLowerCase().trim(), bcrypt.hashSync(password, 10), normaliseRole(role)]
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
    const { role, active, name, email, newPassword } = req.body || {};
    const user = await db.one('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const isSelf = Number(req.params.id) === req.session.user.id;
    const nextRole = role === undefined ? user.role : normaliseRole(role, user.role);
    const nextActive = active === undefined ? user.active : !(active === false || active === 0);

    // An admin editing themselves could otherwise remove their own access and
    // leave nobody able to manage users.
    if (isSelf && nextRole !== 'admin') {
      return res.status(400).json({ error: "You can't remove your own admin role" });
    }
    if (isSelf && !nextActive) {
      return res.status(400).json({ error: "You can't deactivate your own account" });
    }

    if (newPassword !== undefined && newPassword !== '' && newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    try {
      await db.query(
        `UPDATE users SET
           name = $1,
           email = $2,
           role = $3,
           active = $4,
           password_hash = COALESCE($5, password_hash),
           -- a password set by an admin is temporary, so require a change on
           -- next login. Editing anything else leaves the flag alone.
           must_change_password = CASE WHEN $5 IS NULL THEN must_change_password ELSE TRUE END
         WHERE id = $6`,
        [
          (name || user.name).trim(),
          (email || user.email).toLowerCase().trim(),
          nextRole,
          nextActive,
          newPassword ? bcrypt.hashSync(newPassword, 10) : null,
          req.params.id
        ]
      );
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Another user already has that email' });
      throw e;
    }

    // keep the live session in step if the admin edited their own record
    if (isSelf) {
      const updated = await db.one('SELECT * FROM users WHERE id = $1', [req.params.id]);
      req.session.user = publicUser(updated);
    }

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

// ---------- deal history ----------
// Only fields worth reading back in a report or an audit. Free text like notes
// and description is deliberately left out - it would bury the signal.
const TRACKED_FIELDS = {
  customer_name: 'Customer',
  product_category: 'Category',
  value: 'Value',
  cost: 'Cost',
  stage: 'Stage',
  probability: 'Probability',
  expected_close_date: 'Expected close',
  won_lost_date: 'Won/Lost date',
  owner_id: 'Owner',
  next_action: 'Next action',
  next_action_date: 'Next action due'
};

const asComparable = (v) => (v === null || v === undefined || v === '' ? null : String(v));

async function recordHistory(entries) {
  if (!entries.length) return;
  // one multi-row insert rather than a query per field
  const values = [];
  const params = [];
  entries.forEach((e, i) => {
    const o = i * 8;
    values.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8})`);
    params.push(e.deal_id, e.deal_name, e.changed_by, e.changed_by_name, e.action, e.field, e.old_value, e.new_value);
  });
  await db.query(
    `INSERT INTO deal_history (deal_id, deal_name, changed_by, changed_by_name, action, field, old_value, new_value)
     VALUES ${values.join(',')}`,
    params
  );
}

function diffDeal(before, after) {
  const changes = [];
  for (const field of Object.keys(TRACKED_FIELDS)) {
    const from = asComparable(before[field]);
    const to = asComparable(after[field]);
    if (from !== to) changes.push({ field, old_value: from, new_value: to });
  }
  return changes;
}

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
  requireDealEditor,
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
         won_lost_date, owner_id, notes, next_action, next_action_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
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
        b.notes || null,
        b.next_action || null,
        b.next_action_date || null
      ]
    );

    const created = await loadDeal(row.id);
    await recordHistory([
      {
        deal_id: row.id,
        deal_name: created.customer_name,
        changed_by: req.session.user.id,
        changed_by_name: req.session.user.name,
        action: 'created',
        field: null,
        old_value: null,
        new_value: created.customer_name
      }
    ]);

    res.json({ deal: created });
  })
);

app.put(
  '/api/deals/:id',
  requireDealEditor,
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
         owner_id = $13, notes = $14, next_action = $15, next_action_date = $16,
         updated_at = NOW()
       WHERE id = $17`,
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
        b.next_action || null,
        b.next_action_date || null,
        req.params.id
      ]
    );

    const updated = await loadDeal(req.params.id);
    await recordHistory(
      diffDeal(existing, updated).map((c) => ({
        deal_id: Number(req.params.id),
        deal_name: updated.customer_name,
        changed_by: req.session.user.id,
        changed_by_name: req.session.user.name,
        action: 'updated',
        ...c
      }))
    );

    res.json({ deal: updated });
  })
);

app.delete(
  '/api/deals/:id',
  requireDealEditor,
  route(async (req, res) => {
    const existing = await loadDeal(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Deal not found' });

    // recorded before the delete, so the row survives with deal_id nulled
    await recordHistory([
      {
        deal_id: Number(req.params.id),
        deal_name: existing.customer_name,
        changed_by: req.session.user.id,
        changed_by_name: req.session.user.name,
        action: 'deleted',
        field: null,
        old_value: String(existing.value),
        new_value: null
      }
    ]);

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

    // Deliberately NOT filtered by the selected period: this answers "what needs
    // doing now", which has nothing to do with which year you're looking at.
    const STALE_DAYS = 14;
    const attention = await db.all(
      `SELECT d.*, u.name AS owner_name,
              (d.next_action_date IS NOT NULL AND d.next_action_date < CURRENT_DATE) AS action_overdue,
              (d.expected_close_date IS NOT NULL AND d.expected_close_date < CURRENT_DATE) AS close_date_passed,
              (d.updated_at < NOW() - ($1 || ' days')::interval) AS gone_quiet
       FROM deals d
       LEFT JOIN users u ON u.id = d.owner_id
       WHERE d.stage = ANY($2)
         AND (
           (d.next_action_date IS NOT NULL AND d.next_action_date < CURRENT_DATE)
           OR (d.expected_close_date IS NOT NULL AND d.expected_close_date < CURRENT_DATE)
           OR d.updated_at < NOW() - ($1 || ' days')::interval
         )
       ORDER BY COALESCE(d.next_action_date, d.expected_close_date, d.updated_at::date) ASC
       LIMIT 25`,
      [String(STALE_DAYS), OPEN_STAGES]
    );

    const needsAttention = attention.map((d) => {
      const reasons = [];
      if (d.action_overdue) reasons.push({ code: 'action', label: 'Action overdue' });
      if (d.close_date_passed) reasons.push({ code: 'close', label: 'Close date passed' });
      if (d.gone_quiet) reasons.push({ code: 'quiet', label: `No update in ${STALE_DAYS} days` });
      return {
        id: d.id,
        customer_name: d.customer_name,
        value: d.value,
        stage: d.stage,
        owner_name: d.owner_name,
        next_action: d.next_action,
        next_action_date: d.next_action_date,
        expected_close_date: d.expected_close_date,
        reasons
      };
    });

    res.json({
      range: { from, to, label },
      needsAttention,
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

app.get(
  '/api/deals/:id/history',
  requireAuth,
  route(async (req, res) => {
    const history = await db.all(
      `SELECT action, field, old_value, new_value, changed_by_name, changed_at
       FROM deal_history WHERE deal_id = $1 ORDER BY changed_at DESC, id DESC LIMIT 100`,
      [req.params.id]
    );
    res.json({ history, fieldLabels: TRACKED_FIELDS });
  })
);

// ---------- management report ----------
// Everything a period report needs in one request. Anyone signed in can run it.
app.get(
  '/api/report',
  requireAuth,
  route(async (req, res) => {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to dates are required' });

    const dealFields = `d.id, d.customer_name, d.product_category, d.value, d.cost, d.stage,
                        d.probability, d.expected_close_date, d.won_lost_date, d.created_at,
                        d.next_action, d.next_action_date, u.name AS owner_name, d.owner_id`;

    const [won, lost, created, openDeals] = await Promise.all([
      db.all(
        `SELECT ${dealFields} FROM deals d LEFT JOIN users u ON u.id = d.owner_id
         WHERE d.stage = 'Won' AND d.won_lost_date BETWEEN $1 AND $2
         ORDER BY d.value DESC`,
        [from, to]
      ),
      db.all(
        `SELECT ${dealFields} FROM deals d LEFT JOIN users u ON u.id = d.owner_id
         WHERE d.stage = 'Lost' AND d.won_lost_date BETWEEN $1 AND $2
         ORDER BY d.value DESC`,
        [from, to]
      ),
      db.all(
        `SELECT ${dealFields} FROM deals d LEFT JOIN users u ON u.id = d.owner_id
         WHERE d.created_at::date BETWEEN $1 AND $2
         ORDER BY d.value DESC`,
        [from, to]
      ),
      // Open pipeline is a snapshot of where things stand now, not a period
      // slice - "what is still live" doesn't depend on the dates chosen.
      db.all(
        `SELECT ${dealFields} FROM deals d LEFT JOIN users u ON u.id = d.owner_id
         WHERE d.stage = ANY($1) ORDER BY d.value DESC`,
        [OPEN_STAGES]
      )
    ]);

    const sum = (rows, field) => rows.reduce((s, r) => s + (Number(r[field]) || 0), 0);
    const gpOf = (rows) => {
      const priced = rows.filter((r) => r.cost !== null && r.cost !== undefined);
      const value = sum(priced, 'value');
      const gp = priced.reduce((s, r) => s + (r.value - r.cost), 0);
      return { gp, marginPct: value > 0 ? (gp / value) * 100 : null, pricedCount: priced.length, totalCount: rows.length };
    };

    // One row per person who owns anything relevant, so the report shows the
    // whole team rather than only those who closed something.
    const people = new Map();
    const bucket = (name) => {
      const key = name || 'Unassigned';
      if (!people.has(key)) {
        people.set(key, { name: key, wonCount: 0, wonValue: 0, wonGp: 0, wonCostedCount: 0, lostCount: 0, lostValue: 0, newCount: 0, newValue: 0, openCount: 0, openValue: 0 });
      }
      return people.get(key);
    };
    won.forEach((d) => {
      const p = bucket(d.owner_name);
      p.wonCount += 1;
      p.wonValue += d.value;
      // count how many are costed, so partial GP is never read as complete
      if (d.cost !== null && d.cost !== undefined) {
        p.wonGp += d.value - d.cost;
        p.wonCostedCount += 1;
      }
    });
    lost.forEach((d) => {
      const p = bucket(d.owner_name);
      p.lostCount += 1;
      p.lostValue += d.value;
    });
    created.forEach((d) => {
      const p = bucket(d.owner_name);
      p.newCount += 1;
      p.newValue += d.value;
    });
    openDeals.forEach((d) => {
      const p = bucket(d.owner_name);
      p.openCount += 1;
      p.openValue += d.value;
    });

    const bySalesperson = [...people.values()]
      .map((p) => ({ ...p, winRate: p.wonCount + p.lostCount > 0 ? (p.wonCount / (p.wonCount + p.lostCount)) * 100 : null }))
      .sort((a, b) => b.wonValue - a.wonValue || b.openValue - a.openValue);

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

    res.json({
      range: { from, to },
      generatedAt: new Date().toISOString(),
      generatedBy: req.session.user.name,
      summary: {
        wonCount: won.length,
        wonValue: sum(won, 'value'),
        wonGp: gpOf(won),
        lostCount: lost.length,
        lostValue: sum(lost, 'value'),
        newCount: created.length,
        newValue: sum(created, 'value'),
        winRate: won.length + lost.length > 0 ? (won.length / (won.length + lost.length)) * 100 : null,
        openCount: openDeals.length,
        openValue: sum(openDeals, 'value'),
        openGp: gpOf(openDeals),
        weightedOpenValue: openDeals.reduce((s, d) => s + (d.value * d.probability) / 100, 0)
      },
      won,
      lost,
      created,
      openDeals: openDeals.slice(0, 20),
      bySalesperson,
      byStage,
      byCategory
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

// A freshly provisioned database can refuse connections for a minute or so, and
// managed databases briefly disappear during maintenance or failover. Giving up
// on the first error turns a transient blip into a failed deploy, so retry with
// backoff before treating it as fatal.
async function connectWithRetry(attempts = 10) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await db.init();
      if (attempt > 1) console.log(`Database ready after ${attempt} attempts.`);
      return;
    } catch (e) {
      if (attempt === attempts) throw e;
      const waitMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
      console.warn(
        `Database not ready (attempt ${attempt}/${attempts}): ${e.message}. Retrying in ${waitMs / 1000}s...`
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

async function start() {
  try {
    await connectWithRetry();
  } catch (e) {
    console.error(`\n  DATABASE ERROR: could not connect or set up tables.\n  ${e.message}\n`);
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`V Living Trading Tracker running at http://localhost:${PORT}`);
  });
}

start();
