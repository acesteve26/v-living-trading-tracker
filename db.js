const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

const db = new DatabaseSync(path.join(dataDir, 'tracker.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'sales' CHECK(role IN ('admin','sales')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_name TEXT NOT NULL,
  contact_name TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  product_category TEXT NOT NULL DEFAULT 'Tiles' CHECK(product_category IN ('Tiles','Sanitaryware','Both','Other')),
  description TEXT,
  value REAL NOT NULL DEFAULT 0,
  cost REAL,
  stage TEXT NOT NULL DEFAULT 'Lead' CHECK(stage IN ('Lead','Qualified','Proposal Sent','Negotiation','Won','Lost')),
  probability INTEGER NOT NULL DEFAULT 20,
  expected_close_date TEXT,
  won_lost_date TEXT,
  owner_id INTEGER REFERENCES users(id),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// cost was added after the first release; bring older databases up to date
const dealColumns = db.prepare('PRAGMA table_info(deals)').all().map((c) => c.name);
if (!dealColumns.includes('cost')) {
  db.exec('ALTER TABLE deals ADD COLUMN cost REAL');
  console.log('Migrated deals table: added cost column');
}

// Default stage -> probability suggestions used by the frontend
const defaultProbabilities = {
  Lead: 10,
  Qualified: 30,
  'Proposal Sent': 50,
  Negotiation: 70,
  Won: 100,
  Lost: 0
};

function seed() {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount === 0) {
    // No password is ever hardcoded here: set ADMIN_EMAIL / ADMIN_PASSWORD to
    // choose your own, otherwise a random one is generated and printed once.
    const email = (process.env.ADMIN_EMAIL || 'admin@vliving.local').toLowerCase().trim();
    const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    const generated = !process.env.ADMIN_PASSWORD;

    db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(
      'V Living Admin',
      email,
      bcrypt.hashSync(password, 10),
      'admin'
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

  const currency = db.prepare("SELECT value FROM settings WHERE key = 'currency'").get();
  if (!currency) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('currency', 'AED')").run();
  }

  const companyName = db.prepare("SELECT value FROM settings WHERE key = 'company_name'").get();
  if (!companyName) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('company_name', 'V Living Trading')").run();
  }
}

seed();

module.exports = { db, defaultProbabilities };
