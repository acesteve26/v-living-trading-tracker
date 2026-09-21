const path = require('path');
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const config = require('./config');
const db = require('./db');
const {
  PRODUCT_CATEGORIES,
  STAGES,
  OPEN_STAGES,
  ROLES,
  CAN_EDIT_DEALS: EDIT_DEAL_ROLES,
  CAN_MANAGE_USERS: MANAGE_USER_ROLES,
  DOCUMENT_TYPES,
  PREVIEWABLE_TYPES
} = require('./constants');

const app = express();
const PORT = config.port;


// behind Render's HTTPS proxy, trust the forwarded protocol so secure cookies work
if (config.isProduction) app.set('trust proxy', 1);

// Security headers. Everything the app loads - fonts, Chart.js, logo, styles -
// is served from this origin, so the policy can forbid outside sources entirely.
// Inline scripts are blocked outright, which is why the login page's script
// lives in its own file. Inline *styles* are still allowed: the markup uses
// style attributes in a few places, and blocking them buys little once scripts
// are locked down.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        // only meaningful over HTTPS, so not applied to local development
        ...(config.isProduction ? { upgradeInsecureRequests: [] } : {})
      }
    },
    // one year, and only sent in production where the app is actually on HTTPS
    hsts: config.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'same-origin' },
    crossOriginEmbedderPolicy: false
  })
);

app.use(express.json({ limit: '100kb' }));

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

// ---------- business dates ----------
// "Today" always means today in the business's timezone, never the server's.
// SQL uses BUSINESS_TODAY for the same reason: Postgres CURRENT_DATE on a UTC
// server is the wrong day for four hours of every Dubai day.
const BUSINESS_TODAY = `((NOW() AT TIME ZONE '${config.businessTimezone}')::date)`;

function businessToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.businessTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

// Parts of today's business date, for building period ranges without drifting
// into the server's timezone.
function businessNowParts() {
  const [year, month, day] = businessToday().split('-').map(Number);
  return { year, month: month - 1, day };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value) {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// ---------- session helpers ----------
// A new session id at sign-in, so a session id captured before login (by a
// shared link, a proxy, or an earlier visit) cannot be reused afterwards.
function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

// Ends every signed-in session belonging to a user, so a password reset or a
// deactivation actually removes access rather than waiting for expiry.
// connect-pg-simple stores the session as JSON, so the user id is read out of it.
async function revokeSessionsForUser(userId, exceptSid) {
  const params = [String(userId)];
  let sql = `DELETE FROM user_sessions WHERE (sess::jsonb -> 'user' ->> 'id') = $1`;
  if (exceptSid) {
    params.push(exceptSid);
    sql += ` AND sid <> $2`;
  }
  const result = await db.query(sql, params);
  return result.rowCount;
}

// ---------- auth helpers ----------
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}

// Roles and what they can do. Everyone signed in can view deals and run
// reports; these two capabilities are the only things that differ.
const CAN_EDIT_DEALS = new Set(EDIT_DEAL_ROLES);
const CAN_MANAGE_USERS = new Set(MANAGE_USER_ROLES);

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

// NOTE: registered further down, after the current user is refreshed, so it
// tests the live flag rather than whatever the session stored at sign-in.
function passwordChangeGate(req, res, next) {
  if (!req.session.user || !req.session.user.mustChangePassword) return next();
  const pathWithoutQuery = req.originalUrl.split('?')[0];
  if (PASSWORD_CHANGE_EXEMPT.has(pathWithoutQuery)) return next();
  res.status(403).json({ error: 'Set a new password before continuing.', mustChangePassword: true });
}

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

// Re-read the signed-in user on every API request, so role changes and
// deactivations take effect immediately rather than at the next page load.
// Previously only /api/session refreshed, which left a demoted user editing
// deals until they happened to reload. One indexed lookup per request is
// cheap at this scale; if that ever stops being true, a session_version column
// would let most requests skip the query.
app.use(
  '/api',
  route(async (req, res, next) => {
    if (!req.session.user) return next();

    const fresh = await db.one('SELECT * FROM users WHERE id = $1', [req.session.user.id]);
    if (!fresh || !fresh.active) {
      return req.session.destroy(() => res.status(401).json({ error: 'Your access has been removed. Please sign in again.' }));
    }

    req.session.user = publicUser(fresh);
    next();
  })
);

// runs after the refresh above, so it sees the live must-change flag
app.use('/api', passwordChangeGate);

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

    // new session id at sign-in, then saved before responding so the browser
    // gets the cookie for the session that actually holds the login
    await regenerateSession(req);
    req.session.user = publicUser(user);
    await saveSession(req);

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

    // Changing a password should end any other session using the old one -
    // on a shared or lost device, for instance. The current session is kept so
    // the person isn't signed out of the browser they just used.
    const ended = await revokeSessionsForUser(user.id, req.sessionID);

    req.session.user.mustChangePassword = false;
    res.json({ ok: true, otherSessionsEnded: ended });
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

    // An admin resetting someone's password, or switching them off, should end
    // that person's sessions straight away rather than leaving an open tab
    // working until it expires.
    let sessionsEnded = 0;
    const passwordWasReset = Boolean(newPassword);
    const wasDeactivated = user.active && !nextActive;
    if (passwordWasReset || wasDeactivated) {
      sessionsEnded = await revokeSessionsForUser(req.params.id, isSelf ? req.sessionID : null);
    }

    // keep the live session in step if the admin edited their own record
    if (isSelf) {
      const updated = await db.one('SELECT * FROM users WHERE id = $1', [req.params.id]);
      req.session.user = publicUser(updated);
    }

    res.json({ ok: true, sessionsEnded });
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
    // and any session they still had open stops working immediately
    await revokeSessionsForUser(req.params.id);
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
    res.json({
      settings,
      stageProbabilities: db.defaultProbabilities,
      businessTimezone: config.businessTimezone,
      productCategories: PRODUCT_CATEGORIES,
      stages: STAGES,
      // so the upload area can name what it accepts, and refuse the obvious
      // cases before pushing a file over the wire
      documentExtensions: Object.keys(DOCUMENT_TYPES),
      documentPreviewTypes: PREVIEWABLE_TYPES,
      maxDealDocumentBytes: config.maxDealDocumentBytes
    });
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
function loadDeal(id, exec) {
  return db.one(
    `SELECT d.*, u.name AS owner_name
     FROM deals d LEFT JOIN users u ON u.id = d.owner_id
     WHERE d.id = $1`,
    [id],
    exec
  );
}

app.get(
  '/api/deals',
  requireAuth,
  route(async (req, res) => {
    const { stage, category, search, ownerId, view, archived } = req.query;
    let sql = `SELECT d.*, u.name AS owner_name
               FROM deals d LEFT JOIN users u ON u.id = d.owner_id
               WHERE 1=1`;
    const params = [];

    // Archived deals stay out of the way unless asked for by name.
    sql += archived === 'true' ? ' AND d.archived_at IS NOT NULL' : ' AND d.archived_at IS NULL';

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
    // saved views for the things a salesperson actually looks for. All three are
    // about live work, so each is limited to open stages.
    const VIEWS = ['overdue', 'closing_soon', 'no_next_action', 'no_close_date'];
    if (VIEWS.includes(view)) {
      params.push(OPEN_STAGES);
      sql += ` AND d.stage = ANY($${params.length})`;

      if (view === 'overdue') {
        sql += ` AND d.next_action_date IS NOT NULL AND d.next_action_date < ${BUSINESS_TODAY}`;
      } else if (view === 'closing_soon') {
        sql += ` AND d.expected_close_date BETWEEN ${BUSINESS_TODAY} AND ${BUSINESS_TODAY} + 30`;
      } else if (view === 'no_close_date') {
        sql += ' AND d.expected_close_date IS NULL';
      } else {
        sql += ' AND d.next_action_date IS NULL';
      }
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
  lost_reason: 'Lost reason',
  owner_id: 'Owner',
  next_action: 'Next action',
  next_action_date: 'Next action due'
};

const asComparable = (v) => (v === null || v === undefined || v === '' ? null : String(v));

async function recordHistory(entries, exec) {
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
    params,
    exec
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

const MAX_MONEY = 1e12; // NUMERIC(14,2) tops out here; beyond it Postgres errors
const DATE_FIELDS = ['expected_close_date', 'won_lost_date', 'next_action_date'];

// Everything a bad request could send is checked here, so malformed input comes
// back as a clear 400 rather than reaching Postgres and surfacing as a 500.
async function validateDealBody(body) {
  const errors = [];

  if (!body.customer_name || !body.customer_name.trim()) errors.push('Customer name is required');
  else if (body.customer_name.trim().length > 200) errors.push('Customer name is too long');

  const value = Number(body.value);
  if (body.value === undefined || body.value === '' || isNaN(value) || value < 0) {
    errors.push('Value must be a positive number');
  } else if (value > MAX_MONEY) {
    errors.push('Value is unrealistically large');
  }

  if (body.cost !== undefined && body.cost !== null && body.cost !== '') {
    const c = Number(body.cost);
    if (isNaN(c) || c < 0) errors.push('Cost must be a positive number');
    else if (c > MAX_MONEY) errors.push('Cost is unrealistically large');
  }

  if (!PRODUCT_CATEGORIES.includes(body.product_category)) errors.push('Invalid product category');
  if (!STAGES.includes(body.stage)) errors.push('Invalid stage');

  if (body.probability !== undefined && body.probability !== null && body.probability !== '') {
    const p = Number(body.probability);
    if (!Number.isInteger(p) || p < 0 || p > 100) errors.push('Probability must be a whole number between 0 and 100');
  }

  for (const field of DATE_FIELDS) {
    const v = body[field];
    if (v !== undefined && v !== null && v !== '' && !isValidDate(v)) {
      errors.push(`${field.replace(/_/g, ' ')} must be a valid date`);
    }
  }

  // An owner who has been deleted or deactivated would otherwise fail on the
  // foreign key and surface as a 500.
  if (body.owner_id !== undefined && body.owner_id !== null && body.owner_id !== '') {
    const ownerId = Number(body.owner_id);
    if (!Number.isInteger(ownerId) || ownerId < 1) {
      errors.push('Invalid owner');
    } else {
      const owner = await db.one('SELECT id, active FROM users WHERE id = $1', [ownerId]);
      if (!owner) errors.push('That owner no longer exists');
      else if (!owner.active) errors.push('That owner is deactivated');
    }
  }

  return errors;
}

app.post(
  '/api/deals',
  requireDealEditor,
  route(async (req, res) => {
    const b = req.body || {};
    const errors = await validateDealBody(b);
    if (errors.length) return res.status(400).json({ error: errors.join(', ') });

    const wonLostDate = ['Won', 'Lost'].includes(b.stage)
      ? b.won_lost_date || businessToday()
      : null;
    const probability =
      b.probability !== undefined && b.probability !== '' ? Number(b.probability) : db.defaultProbabilities[b.stage];

    // The deal and its history entry land together or not at all.
    const created = await db.transaction(async (client) => {
      const row = await db.one(
        `INSERT INTO deals
          (customer_name, contact_name, contact_email, contact_phone, product_category,
           description, value, cost, stage, probability, expected_close_date,
           won_lost_date, owner_id, notes, next_action, next_action_date, lost_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
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
          b.next_action_date || null,
          // only meaningful on a lost deal; cleared otherwise so a reopened deal
          // doesn't keep a stale explanation
          b.stage === 'Lost' ? b.lost_reason || null : null
        ],
        client
      );

      const deal = await loadDeal(row.id, client);
      await recordHistory(
        [
          {
            deal_id: row.id,
            deal_name: deal.customer_name,
            changed_by: req.session.user.id,
            changed_by_name: req.session.user.name,
            action: 'created',
            field: null,
            old_value: null,
            new_value: deal.customer_name
          }
        ],
        client
      );
      return deal;
    });

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
    const errors = await validateDealBody(b);
    if (errors.length) return res.status(400).json({ error: errors.join(', ') });

    const wonLostDate = ['Won', 'Lost'].includes(b.stage)
      ? b.won_lost_date || existing.won_lost_date || businessToday()
      : null;
    const probability =
      b.probability !== undefined && b.probability !== '' ? Number(b.probability) : db.defaultProbabilities[b.stage];

    const updated = await db.transaction(async (client) => {
      await db.query(
        `UPDATE deals SET
           customer_name = $1, contact_name = $2, contact_email = $3, contact_phone = $4,
           product_category = $5, description = $6, value = $7, cost = $8, stage = $9,
           probability = $10, expected_close_date = $11, won_lost_date = $12,
           owner_id = $13, notes = $14, next_action = $15, next_action_date = $16,
           lost_reason = $17, updated_at = NOW()
         WHERE id = $18`,
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
          b.stage === 'Lost' ? b.lost_reason || null : null,
          req.params.id
        ],
        client
      );

      const deal = await loadDeal(req.params.id, client);
      await recordHistory(
        diffDeal(existing, deal).map((c) => ({
          deal_id: Number(req.params.id),
          deal_name: deal.customer_name,
          changed_by: req.session.user.id,
          changed_by_name: req.session.user.name,
          action: 'updated',
          ...c
        })),
        client
      );
      return deal;
    });

    res.json({ deal: updated });
  })
);

// Archiving hides a deal from every normal view but keeps the record, so a
// mistake is recoverable. Only an admin can destroy one outright.
app.post(
  '/api/deals/:id/archive',
  requireDealEditor,
  route(async (req, res) => {
    const existing = await loadDeal(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Deal not found' });
    if (existing.archived_at) return res.status(400).json({ error: 'That deal is already archived' });

    await db.transaction(async (client) => {
      await db.query(
        'UPDATE deals SET archived_at = NOW(), archived_by = $1, updated_at = NOW() WHERE id = $2',
        [req.session.user.id, req.params.id],
        client
      );
      await recordHistory(
        [
          {
            deal_id: Number(req.params.id),
            deal_name: existing.customer_name,
            changed_by: req.session.user.id,
            changed_by_name: req.session.user.name,
            action: 'archived',
            field: null,
            old_value: null,
            new_value: null
          }
        ],
        client
      );
    });

    res.json({ ok: true });
  })
);

app.post(
  '/api/deals/:id/restore',
  requireDealEditor,
  route(async (req, res) => {
    const existing = await loadDeal(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Deal not found' });
    if (!existing.archived_at) return res.status(400).json({ error: 'That deal is not archived' });

    await db.transaction(async (client) => {
      await db.query(
        'UPDATE deals SET archived_at = NULL, archived_by = NULL, updated_at = NOW() WHERE id = $1',
        [req.params.id],
        client
      );
      await recordHistory(
        [
          {
            deal_id: Number(req.params.id),
            deal_name: existing.customer_name,
            changed_by: req.session.user.id,
            changed_by_name: req.session.user.name,
            action: 'restored',
            field: null,
            old_value: null,
            new_value: null
          }
        ],
        client
      );
    });

    res.json({ ok: true });
  })
);

// Permanent deletion is reserved for an admin: it destroys a business record
// and cannot be undone.
app.delete(
  '/api/deals/:id',
  requireAdmin,
  route(async (req, res) => {
    const existing = await loadDeal(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Deal not found' });

    // Recorded before the delete so the row survives with deal_id nulled, and
    // inside a transaction so history can't claim a deletion that then failed.
    await db.transaction(async (client) => {
      await recordHistory(
        [
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
        ],
        client
      );
      await db.query('DELETE FROM deals WHERE id = $1', [req.params.id], client);
    });

    res.json({ ok: true });
  })
);

// ---------- deal documents ----------
//
// Uploads arrive as the raw file in the request body with the name in the query
// string, rather than as a multipart form. It does the same job for one file at
// a time, needs no parsing library, and keeps the whole multipart surface out of
// the app. The browser sends the File object straight through as the body.

const MAX_FILENAME_LENGTH = 200;

// Everything about a stored file is decided here, from the extension alone.
// The browser's Content-Type is never trusted: it is trivially set to anything,
// and this is what the file will later be served as.
function documentTypeFor(filename) {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return null;
  return DOCUMENT_TYPES[filename.slice(dot).toLowerCase()] || null;
}

// A filename is attacker-controlled text that later goes into a response
// header, so it is reduced to a bare name: no directories, no control
// characters, no leading dots, and a sane length.
function safeFilename(raw) {
  const name = String(raw || '')
    .split(/[\\/]/)
    .pop()
    .replace(/[\x00-\x1f\x7f"]/g, '')
    .replace(/^\.+/, '')
    .trim();
  if (!name) return '';
  if (name.length <= MAX_FILENAME_LENGTH) return name;
  // trim the middle, not the end, so the extension survives
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot) : '';
  return name.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
}

// Sizes appear in messages people read, so a 40 KB file is never described as
// "0.0 MB". Matches the formatting the browser uses.
function humanSize(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const DOCUMENT_COLUMNS = `id, deal_id, filename, content_type, byte_size, uploaded_by_name, uploaded_at`;

async function documentUsage(dealId, exec) {
  const row = await db.one(
    'SELECT COALESCE(SUM(byte_size), 0)::int AS used FROM deal_documents WHERE deal_id = $1',
    [dealId],
    exec
  );
  return row.used;
}

app.get(
  '/api/deals/:id/documents',
  requireAuth,
  route(async (req, res) => {
    const deal = await loadDeal(req.params.id);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    const documents = await db.all(
      `SELECT ${DOCUMENT_COLUMNS} FROM deal_documents WHERE deal_id = $1 ORDER BY uploaded_at DESC`,
      [req.params.id]
    );
    res.json({
      documents,
      usedBytes: documents.reduce((sum, d) => sum + d.byte_size, 0),
      maxBytes: config.maxDealDocumentBytes
    });
  })
);

app.post(
  '/api/deals/:id/documents',
  requireDealEditor,
  // Anything may be sent; what is actually allowed is decided below from the
  // extension. The limit stops an oversized body being read into memory at all.
  express.raw({ type: () => true, limit: config.maxDealDocumentBytes }),
  route(async (req, res) => {
    const deal = await loadDeal(req.params.id);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });
    if (deal.archived_at) {
      return res.status(400).json({ error: 'Restore this deal before attaching documents to it.' });
    }

    const filename = safeFilename(req.query.filename);
    if (!filename) return res.status(400).json({ error: 'A filename is required' });

    const contentType = documentTypeFor(filename);
    if (!contentType) {
      return res.status(400).json({
        error: `That file type can't be attached. Allowed types: ${Object.keys(DOCUMENT_TYPES).join(', ')}`
      });
    }

    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      return res.status(400).json({ error: 'That file is empty' });
    }

    const document = await db.transaction(async (client) => {
      // Locking the deal row serialises uploads against it, so two files
      // arriving together can't each see room under the cap and both take it.
      await db.query('SELECT id FROM deals WHERE id = $1 FOR UPDATE', [req.params.id], client);

      const used = await documentUsage(req.params.id, client);
      if (used + bytes.length > config.maxDealDocumentBytes) {
        const remaining = Math.max(0, config.maxDealDocumentBytes - used);
        const problem = new Error(
          remaining === 0
            ? `This deal has used its whole ${humanSize(config.maxDealDocumentBytes)} of attachments. Remove something before adding more.`
            : `That file is ${humanSize(bytes.length)} and only ${humanSize(remaining)} is left of this deal's ${humanSize(config.maxDealDocumentBytes)}.`
        );
        problem.status = 400;
        throw problem;
      }

      const row = await db.one(
        `INSERT INTO deal_documents (deal_id, filename, content_type, byte_size, bytes, uploaded_by, uploaded_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING ${DOCUMENT_COLUMNS}`,
        [
          req.params.id,
          filename,
          contentType,
          bytes.length,
          bytes,
          req.session.user.id,
          req.session.user.name
        ],
        client
      );

      await recordHistory(
        [
          {
            deal_id: Number(req.params.id),
            deal_name: deal.customer_name,
            changed_by: req.session.user.id,
            changed_by_name: req.session.user.name,
            action: 'document_added',
            field: 'document',
            old_value: null,
            new_value: filename
          }
        ],
        client
      );

      return row;
    });

    res.json({ document });
  })
);

app.get(
  '/api/documents/:docId',
  requireAuth,
  route(async (req, res) => {
    const doc = await db.one(
      'SELECT filename, content_type, byte_size, bytes FROM deal_documents WHERE id = $1',
      [req.params.docId]
    );
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    // Saved by default. Shown in the browser only when asked for and only for
    // the handful of types with a viewer - and even then the type served is the
    // one the extension implies, sent with nosniff, so a file that is not what
    // its name claims is never interpreted as whatever it actually contains.
    const wantsInline = req.query.inline === '1' && PREVIEWABLE_TYPES.includes(doc.content_type);
    const asciiName = doc.filename.replace(/[^\x20-\x7e]/g, '_');
    res.setHeader('Content-Type', doc.content_type);
    res.setHeader('Content-Length', doc.byte_size);
    res.setHeader(
      'Content-Disposition',
      `${wantsInline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(doc.filename)}`
    );
    // These are customer documents: keep them out of any shared cache.
    res.setHeader('Cache-Control', 'private, no-store');
    // The preview frames this response from the app itself, which the global
    // frame-ancestors 'none' blocks. Relaxed to 'self' on this response alone:
    // no other site can frame a document, and every page of the app stays
    // unframeable entirely.
    if (wantsInline) res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    res.send(doc.bytes);
  })
);

app.delete(
  '/api/documents/:docId',
  requireDealEditor,
  route(async (req, res) => {
    const doc = await db.one(
      `SELECT d.id, d.deal_id, d.filename, deals.customer_name
       FROM deal_documents d JOIN deals ON deals.id = d.deal_id
       WHERE d.id = $1`,
      [req.params.docId]
    );
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    await db.transaction(async (client) => {
      await db.query('DELETE FROM deal_documents WHERE id = $1', [req.params.docId], client);
      await recordHistory(
        [
          {
            deal_id: doc.deal_id,
            deal_name: doc.customer_name,
            changed_by: req.session.user.id,
            changed_by_name: req.session.user.name,
            action: 'document_removed',
            field: 'document',
            old_value: doc.filename,
            new_value: null
          }
        ],
        client
      );
    });

    res.json({ ok: true });
  })
);

// ---------- dashboard ----------
function computeRange(range, fromQ, toQ) {
  const parts = businessNowParts();
  const now = new Date(parts.year, parts.month, parts.day);
  const y = parts.year;
  const m = parts.month;
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
       WHERE archived_at IS NULL
         AND stage = ANY($1) AND expected_close_date IS NOT NULL
         AND expected_close_date BETWEEN $2 AND $3`,
      [OPEN_STAGES, from, to]
    );

    const openDealsNoDate = await db.all(
      'SELECT * FROM deals WHERE archived_at IS NULL AND stage = ANY($1) AND expected_close_date IS NULL',
      [OPEN_STAGES]
    );

    const wonDeals = await db.all(
      "SELECT * FROM deals WHERE archived_at IS NULL AND stage = 'Won' AND won_lost_date BETWEEN $1 AND $2",
      [from, to]
    );

    const lostDeals = await db.all(
      "SELECT * FROM deals WHERE archived_at IS NULL AND stage = 'Lost' AND won_lost_date BETWEEN $1 AND $2",
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
    PRODUCT_CATEGORIES.forEach((c) => (byCategory[c] = { count: 0, value: 0 }));
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
              (d.next_action_date IS NOT NULL AND d.next_action_date < ${BUSINESS_TODAY}) AS action_overdue,
              (d.expected_close_date IS NOT NULL AND d.expected_close_date < ${BUSINESS_TODAY}) AS close_date_passed,
              (d.updated_at < NOW() - ($1 || ' days')::interval) AS gone_quiet,
              (d.expected_close_date IS NULL) AS no_close_date
       FROM deals d
       LEFT JOIN users u ON u.id = d.owner_id
       WHERE d.archived_at IS NULL AND d.stage = ANY($2)
         AND (
           (d.next_action_date IS NOT NULL AND d.next_action_date < ${BUSINESS_TODAY})
           OR (d.expected_close_date IS NOT NULL AND d.expected_close_date < ${BUSINESS_TODAY})
           OR d.updated_at < NOW() - ($1 || ' days')::interval
           -- without a close date a deal sits outside every period figure, so
           -- it would otherwise be invisible on this page entirely
           OR d.expected_close_date IS NULL
         )
       ORDER BY COALESCE(d.next_action_date, d.expected_close_date, d.updated_at::date) ASC
       LIMIT 25`,
      [String(STALE_DAYS), OPEN_STAGES]
    );

    const needsAttention = attention.map((d) => {
      const reasons = [];
      if (d.no_close_date) reasons.push({ code: 'nodate', label: 'No close date' });
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
        // Counts only the deals whose value is actually in the figures above.
        // Including unscheduled deals here made the card read "6 open deals"
        // over a total that covered five of them.
        openCount: openDeals.length,
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
         WHERE d.archived_at IS NULL AND d.stage = 'Won' AND d.won_lost_date BETWEEN $1 AND $2
         ORDER BY d.value DESC`,
        [from, to]
      ),
      db.all(
        `SELECT ${dealFields} FROM deals d LEFT JOIN users u ON u.id = d.owner_id
         WHERE d.archived_at IS NULL AND d.stage = 'Lost' AND d.won_lost_date BETWEEN $1 AND $2
         ORDER BY d.value DESC`,
        [from, to]
      ),
      db.all(
        `SELECT ${dealFields} FROM deals d LEFT JOIN users u ON u.id = d.owner_id
         WHERE d.archived_at IS NULL AND d.created_at::date BETWEEN $1 AND $2
         ORDER BY d.value DESC`,
        [from, to]
      ),
      // Open pipeline is a snapshot of where things stand now, not a period
      // slice - "what is still live" doesn't depend on the dates chosen.
      db.all(
        `SELECT ${dealFields} FROM deals d LEFT JOIN users u ON u.id = d.owner_id
         WHERE d.archived_at IS NULL AND d.stage = ANY($1) ORDER BY d.value DESC`,
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
    PRODUCT_CATEGORIES.forEach((c) => (byCategory[c] = { count: 0, value: 0 }));
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

// no-cache is not "don't cache": it is "check with me before using it". With
// the ETag that check is a cheap 304 - and it means a reload after a deploy
// always runs the new scripts, rather than whatever the browser had decided
// was still fresh enough.
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
  })
);

// Any error thrown in a route lands here rather than crashing the process.
app.use((err, req, res, next) => {
  console.error('Request failed:', req.method, req.path, '-', err.message);
  if (res.headersSent) return next(err);

  // A body over the upload limit is rejected by the body parser before any
  // route sees it, and would otherwise surface as a bare 500.
  if (err.type === 'entity.too.large') {
    return res
      .status(413)
      .json({ error: `That file is too large. The limit is ${humanSize(config.maxDealDocumentBytes)} per deal.` });
  }

  // Routes raise these deliberately, with a message meant for the person.
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });

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

async function start(port = PORT) {
  try {
    await connectWithRetry();
  } catch (e) {
    console.error(`\n  DATABASE ERROR: could not connect or set up tables.\n  ${e.message}\n`);
    process.exit(1);
  }
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      if (port === PORT) console.log(`V Living Trading Tracker running at http://localhost:${port}`);
      resolve(server);
    });
  });
}

// Only run the server when started directly. Tests import this file and drive
// the app on their own port instead.
if (require.main === module) start();

module.exports = { app, start, computeRange };
