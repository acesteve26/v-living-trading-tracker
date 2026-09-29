const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pg = require('pg');
const config = require('./config');
const {
  PRODUCT_CATEGORIES,
  STAGES,
  ROLES,
  HISTORY_ACTIONS,
  ACTIVITY_ACTIONS,
  EXPENSE_CATEGORIES,
  DEFAULT_PROBABILITIES,
  sqlList
} = require('./constants');

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

// The schema is set as a connection option rather than by running SET on every
// new connection: Postgres applies it as the session starts, so there is no
// window where a query could run against the wrong schema.
function connectionStringFor(url, schema) {
  if (schema === 'public') return url;
  const parsed = new URL(url);
  parsed.searchParams.set('options', `-c search_path=${schema},public`);
  return parsed.toString();
}

const pool = new pg.Pool({
  connectionString: connectionStringFor(config.databaseUrl, config.dbSchema),
  ssl: config.databaseSsl,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000
});

pool.on('error', (err) => {
  console.error('Unexpected database error on an idle connection:', err.message);
});


// Convenience wrappers mirroring how the app used the SQLite driver. Each takes
// an optional executor so the same call works inside a transaction.
const query = (text, params, exec = pool) => exec.query(text, params);
const one = async (text, params, exec = pool) => (await exec.query(text, params)).rows[0] || null;
const all = async (text, params, exec = pool) => (await exec.query(text, params)).rows;

// Runs everything in fn against one connection inside a transaction. Used where
// a write and its audit record have to land together or not at all - otherwise
// a deal can change with no history, or history can claim a deletion that then
// failed.
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('Rollback failed:', rollbackError.message);
    }
    throw e;
  } finally {
    client.release();
  }
}

const defaultProbabilities = DEFAULT_PROBABILITIES;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'sales' CHECK (role IN (${sqlList(ROLES)})),
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
    CHECK (product_category IN (${sqlList(PRODUCT_CATEGORIES)})),
  description TEXT,
  value NUMERIC(14,2) NOT NULL DEFAULT 0,
  cost NUMERIC(14,2),
  stage TEXT NOT NULL DEFAULT 'Lead'
    CHECK (stage IN (${sqlList(STAGES)})),
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
  action TEXT NOT NULL CHECK (action IN (${sqlList(HISTORY_ACTIONS)})),
  field TEXT,
  old_value TEXT,
  new_value TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS deal_history_deal_idx ON deal_history (deal_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS deal_history_when_idx ON deal_history (changed_at DESC);

-- What the business spends, kept deliberately apart from deals. A deal's cost
-- is what that deal's goods cost and it drives gross profit; these are the
-- overheads that sit alongside the pipeline - rent, salaries, freight. Mixing
-- them into deal margin would make every deal look unprofitable.
CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  expense_date DATE NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Other',
  amount NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS expenses_date_idx ON expenses (expense_date DESC);

-- Signing in, admin changes to accounts, reports being run: everything worth
-- recording that isn't a change to a deal. Deal changes are not duplicated
-- here - deal_history already holds them, with their before and after - and
-- the two are merged when the log is read.
--
-- actor_name is kept on the row so the trail survives the account being
-- deleted, the same reasoning as deal_history. actor_id is null for a failed
-- sign-in against an email that belongs to nobody, and actor_name then holds
-- what was typed.
CREATE TABLE IF NOT EXISTS activity_log (
  id SERIAL PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT,
  action TEXT NOT NULL,
  subject_name TEXT,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS activity_log_actor_idx ON activity_log (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS activity_log_when_idx ON activity_log (created_at DESC);

-- Quotes, purchase orders, invoices and spec sheets attached to a deal. The
-- file contents live in Postgres rather than on a disk so that a document and
-- the deal it belongs to are captured by the same backup and restored together
-- - a disk would give two backups that can disagree with each other.
--
-- The bytes sit in their own table on purpose. Listing a deal's attachments
-- reads metadata only; the contents are fetched solely when someone downloads
-- one, so no ordinary query ever drags a 40 MB PDF through memory.
--
-- Deleting a deal takes its documents with it. Unlike history, which is kept
-- precisely because it is the record of what happened, a file attached to a
-- deal that no longer exists has nothing left to describe.
CREATE TABLE IF NOT EXISTS deal_documents (
  id SERIAL PRIMARY KEY,
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  bytes BYTEA NOT NULL,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_by_name TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS deal_documents_deal_idx ON deal_documents (deal_id, uploaded_at DESC);

-- Migrations for columns added after the first release. CREATE TABLE IF NOT
-- EXISTS won't touch an existing table, so new columns go here. These are
-- idempotent, so they run harmlessly on every boot.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

-- Touched at most once a minute per person, so "last seen" is a cheap answer
-- to "is anyone actually using this" without a write on every request.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- Rebuilt from the shared list each boot, like the other vocabularies, so the
-- set of recordable actions can grow without a hand-written migration.
ALTER TABLE activity_log DROP CONSTRAINT IF EXISTS activity_log_action_check;
ALTER TABLE activity_log ADD CONSTRAINT activity_log_action_check
  CHECK (action IN (${sqlList(ACTIVITY_ACTIONS)}));

ALTER TABLE expenses DROP CONSTRAINT IF EXISTS expenses_category_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_category_check
  CHECK (category IN (${sqlList(EXPENSE_CATEGORIES)}));

-- Roles grew from admin/sales to four. The inline CHECK has to be replaced
-- rather than altered; dropping first keeps this safe to run repeatedly.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN (${sqlList(ROLES)}));
ALTER TABLE deals ADD COLUMN IF NOT EXISTS next_action TEXT;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS next_action_date DATE;
-- Free text rather than a constrained list: the suggestions in the UI cover the
-- common cases, but a reason worth recording shouldn't be blocked by a CHECK.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS lost_reason TEXT;

-- Deals are archived rather than destroyed. A salesperson removing a deal is
-- usually tidying up, not intending to erase a business record, so the row
-- stays and is simply hidden from normal views.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS archived_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS deals_archived_idx ON deals (archived_at);

-- Category and stage lists grow over time, so their constraints are rebuilt
-- from the shared list on every boot rather than staying pinned to whatever
-- they were when the table was first created.
ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_product_category_check;

-- 'Both' meant tiles and sanitaryware back when those were the only two
-- categories. Among seven it no longer says which two, so it is renamed to
-- 'Mixed'. The order here is load-bearing and is what the tests pin down: the
-- rename sits between the two statements either side of it, because the old
-- constraint would refuse 'Mixed' and the new one would refuse 'Both'. The
-- category itself is unchanged, so the history rows carrying the old label are
-- renamed with it rather than left naming something the app no longer has.
UPDATE deals SET product_category = 'Mixed' WHERE product_category = 'Both';
UPDATE deal_history SET old_value = 'Mixed'
  WHERE field = 'product_category' AND old_value = 'Both';
UPDATE deal_history SET new_value = 'Mixed'
  WHERE field = 'product_category' AND new_value = 'Both';

ALTER TABLE deals ADD CONSTRAINT deals_product_category_check
  CHECK (product_category IN (${sqlList(PRODUCT_CATEGORIES)}));

ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_stage_check;
ALTER TABLE deals ADD CONSTRAINT deals_stage_check
  CHECK (stage IN (${sqlList(STAGES)}));

-- history gained two more actions alongside archiving
ALTER TABLE deal_history DROP CONSTRAINT IF EXISTS deal_history_action_check;
ALTER TABLE deal_history ADD CONSTRAINT deal_history_action_check
  CHECK (action IN (${sqlList(HISTORY_ACTIONS)}));

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

module.exports = { pool, query, one, all, transaction, init, defaultProbabilities };
