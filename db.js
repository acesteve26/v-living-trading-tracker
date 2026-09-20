const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pg = require('pg');
const config = require('./config');

// --- type handling -------------------------------------------------------
// node-postgres returns some types in shapes that would quietly break the app,
// so both are normalised once here rather than guarded at every call site.

// NUMERIC arrives as a string ('84000.00'), which would turn `value - cost`
// into string concatenation. Deal values sit far inside float64's exact integer
// range, so parsing to a number is safe.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : parseFloat(v)));

// DATE arrives as a JS Date in the server's timezone, which can shift a date
// across midnight. The app compares plain 'YYYY-MM-DD' strings throughout, so
// keep the raw string exactly as stored.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

// BIGINT (what COUNT returns) also arrives as a string.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : parseInt(v, 10)));

const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000
});

pool.on('error', (err) => {
  console.error('Unexpected database error on an idle connection:', err.message);
});

// Convenience wrappers mirroring how the app used the SQLite driver.
const query = (text, params) => pool.query(text, params);
const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;
const all = async (text, params) => (await pool.query(text, params)).rows;

const defaultProbabilities = {
  Lead: 10,
  Qualified: 30,
  'Proposal Sent': 50,
  Negotiation: 70,
  Won: 100,
  Lost: 0
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'sales' CHECK (role IN ('admin','sales')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deals (
  id SERIAL PRIMARY KEY,
  customer_name TEXT NOT NULL,
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  product_category TEXT NOT NULL DEFAULT 'Tiles'
    CHECK (product_category IN ('Tiles','Sanitaryware','Both','Other')),
  description TEXT,
  value NUMERIC(14,2) NOT NULL DEFAULT 0,
  cost NUMERIC(14,2),
  stage TEXT NOT NULL DEFAULT 'Lead'
    CHECK (stage IN ('Lead','Qualified','Proposal Sent','Negotiation','Won','Lost')),
  probability INTEGER NOT NULL DEFAULT 20,
  expected_close_date DATE,
  won_lost_date DATE,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS deals_stage_idx ON deals (stage);
CREATE INDEX IF NOT EXISTS deals_expected_close_idx ON deals (expected_close_date);
CREATE INDEX IF NOT EXISTS deals_won_lost_idx ON deals (won_lost_date);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Every change to a deal, one row per field changed. History can only ever
-- describe what happened after this table existed - it cannot be backfilled -
-- which is why it is worth recording well before anything reads it.
-- changed_by_name is denormalised so the trail survives deleting a user.
-- deal_id is nulled rather than cascaded on delete, and the customer name is
-- kept on the row, so deleting a deal leaves its trail readable instead of
-- quietly erasing the evidence.
CREATE TABLE IF NOT EXISTS deal_history (
  id SERIAL PRIMARY KEY,
  deal_id INTEGER REFERENCES deals(id) ON DELETE SET NULL,
  deal_name TEXT,
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_by_name TEXT,
  action TEXT NOT NULL CHECK (action IN ('created','updated','deleted')),
  field TEXT,
  old_value TEXT,
  new_value TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS deal_history_deal_idx ON deal_history (deal_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS deal_history_when_idx ON deal_history (changed_at DESC);

-- Migrations for columns added after the first release. CREATE TABLE IF NOT
-- EXISTS won't touch an existing table, so new columns go here. These are
-- idempotent, so they run harmlessly on every boot.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

-- Roles grew from admin/sales to four. The inline CHECK has to be replaced
-- rather than altered; dropping first keeps this safe to run repeatedly.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin','management','accounts','sales'));
ALTER TABLE deals ADD COLUMN IF NOT EXISTS next_action TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS next_action_date DATE;
-- Free text rather than a constrained list: the suggestions in the UI cover the
-- common cases, but a reason worth recording shouldn't be blocked by a CHECK.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS lost_reason TEXT;

CREATE INDEX IF NOT EXISTS deals_next_action_idx ON deals (next_action_date);
`;

async function seed() {
  const { count } = await one('SELECT COUNT(*)::int AS count FROM users');
  if (count === 0) {
    // No password is ever hardcoded here: set ADMIN_EMAIL / ADMIN_PASSWORD to
    // choose your own, otherwise a random one is generated and printed once.
    const email = (process.env.ADMIN_EMAIL || 'admin@vliving.local').toLowerCase().trim();
    const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    const generated = !process.env.ADMIN_PASSWORD;

    await query(
      `INSERT INTO users (name, email, password_hash, role, must_change_password)
       VALUES ($1, $2, $3, $4, $5)`,
      ['V Living Admin', email, bcrypt.hashSync(password, 10), 'admin', generated]
    );

    console.log('\n  ============================================================');
    console.log('   FIRST RUN - administrator account created');
    console.log('  ============================================================');
    console.log(`   Email:    ${email}`);
    if (generated) {
      console.log(`   Password: ${password}`);
      console.log('\n   Write this down now - it is shown only once.');
      console.log('   Change it after logging in, via the Account button.');
    } else {
      console.log('   Password: (the ADMIN_PASSWORD you provided)');
    }
    console.log('  ============================================================\n');
  }

  await query(
    `INSERT INTO settings (key, value) VALUES ('currency', 'AED')
     ON CONFLICT (key) DO NOTHING`
  );
  await query(
    `INSERT INTO settings (key, value) VALUES ('company_name', 'V Living Trading')
     ON CONFLICT (key) DO NOTHING`
  );
}

async function init() {
  await query(SCHEMA);
  await seed();
}

module.exports = { pool, query, one, all, init, defaultProbabilities };
