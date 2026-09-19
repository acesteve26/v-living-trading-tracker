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
`;

async function seed() {
  const { count } = await one('SELECT COUNT(*)::int AS count FROM users');
  if (count === 0) {
    // No password is ever hardcoded here: set ADMIN_EMAIL / ADMIN_PASSWORD to
    // choose your own, otherwise a random one is generated and printed once.
    const email = (process.env.ADMIN_EMAIL || 'admin@vliving.local').toLowerCase().trim();
    const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    const generated = !process.env.ADMIN_PASSWORD;

    await query('INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)', [
      'V Living Admin',
      email,
      bcrypt.hashSync(password, 10),
      'admin'
    ]);

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
