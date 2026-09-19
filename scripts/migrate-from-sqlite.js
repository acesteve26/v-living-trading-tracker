// One-off: copy deals, users and settings out of the old SQLite file into Postgres.
//
//   node scripts/migrate-from-sqlite.js            (dry run - shows what it would copy)
//   node scripts/migrate-from-sqlite.js --commit   (actually writes)
//
// Safe to run more than once: it refuses to write if the Postgres deals table
// already has rows, so it can't duplicate your pipeline.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const db = require('../db');

const commit = process.argv.includes('--commit');
const sqlitePath = path.join(__dirname, '..', 'data', 'tracker.db');

async function main() {
  if (!fs.existsSync(sqlitePath)) {
    console.log(`No SQLite database found at ${sqlitePath} - nothing to migrate.`);
    return;
  }

  const sqlite = new DatabaseSync(sqlitePath);
  // fold any outstanding WAL content into the file before reading it
  sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');

  const users = sqlite.prepare('SELECT * FROM users ORDER BY id').all();
  const deals = sqlite.prepare('SELECT * FROM deals ORDER BY id').all();
  const settings = sqlite.prepare('SELECT * FROM settings').all();

  console.log(`Found in SQLite: ${users.length} users, ${deals.length} deals, ${settings.length} settings`);

  await db.init();
  const { count } = await db.one('SELECT COUNT(*)::int AS count FROM deals');
  if (count > 0) {
    console.log(`\nPostgres already has ${count} deals - refusing to migrate on top of existing data.`);
    console.log('Clear the Postgres deals table first if you really want to re-import.');
    return;
  }

  if (!commit) {
    console.log('\nDRY RUN - nothing written. Re-run with --commit to migrate.');
    console.log('\nWould copy these deals:');
    deals.forEach((d) => console.log(`  ${d.customer_name} - ${d.value} (${d.stage})`));
    return;
  }

  // users first, so deals can reference them. Map old ids to new ones.
  const idMap = new Map();
  for (const u of users) {
    const existing = await db.one('SELECT id FROM users WHERE email = $1', [u.email]);
    if (existing) {
      idMap.set(u.id, existing.id);
      console.log(`user ${u.email} already exists - reusing`);
      continue;
    }
    const row = await db.one(
      'INSERT INTO users (name, email, password_hash, role, active) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [u.name, u.email, u.password_hash, u.role, u.active === 1 || u.active === true]
    );
    idMap.set(u.id, row.id);
    console.log(`copied user ${u.email}`);
  }

  for (const d of deals) {
    await db.query(
      `INSERT INTO deals
        (customer_name, contact_name, contact_email, contact_phone, product_category,
         description, value, cost, stage, probability, expected_close_date,
         won_lost_date, owner_id, notes, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
               COALESCE($15::timestamptz, NOW()), COALESCE($16::timestamptz, NOW()))`,
      [
        d.customer_name, d.contact_name, d.contact_email, d.contact_phone,
        d.product_category, d.description, d.value, d.cost, d.stage, d.probability,
        d.expected_close_date, d.won_lost_date,
        d.owner_id ? idMap.get(d.owner_id) || null : null,
        d.notes, d.created_at, d.updated_at
      ]
    );
  }
  console.log(`copied ${deals.length} deals`);

  for (const s of settings) {
    await db.query(
      'INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [s.key, s.value]
    );
  }
  console.log(`copied ${settings.length} settings`);

  const after = await db.one('SELECT COUNT(*)::int AS count FROM deals');
  console.log(`\nDone. Postgres now has ${after.count} deals.`);
}

main()
  .catch((e) => {
    console.error('Migration failed:', e.message);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
