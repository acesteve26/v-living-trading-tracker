// Optional: populate the database with example deals so you can see the dashboard working.
// Run with: node scripts/seed-sample-data.js
const db = require('../db');

// Values and costs are in the app's reporting currency (AED by default).
// Cost may be left null on early-stage deals where it isn't known yet.
const sample = [
  ['Al Futtaim Interiors', 'Sanitaryware', 84000, 58800, 'Negotiation', 70, '2026-10-15', null],
  ['Coastal Ceramics LLC', 'Tiles', 45000, 33750, 'Proposal Sent', 50, '2026-09-30', null],
  ['Horizon Build Supplies', 'Both', 132000, 90000, 'Qualified', 30, '2026-11-20', null],
  ['Metro Bath & Tile', 'Sanitaryware', 27500, null, 'Lead', 10, '2026-12-05', null],
  ['Sunrise Developers', 'Tiles', 96000, 64300, 'Won', 100, '2026-08-10', '2026-08-12'],
  ['Palm Grove Hotels', 'Both', 210000, 151200, 'Won', 100, '2026-07-01', '2026-07-05'],
  ['Jebel Ali Fittings Co', 'Sanitaryware', 38000, 29000, 'Lost', 0, '2026-06-15', '2026-06-20'],
  ['Bluewave Construction', 'Tiles', 61000, 42700, 'Negotiation', 70, '2027-01-15', null],
  ['Everstone Trading', 'Other', 15000, null, 'Lead', 10, '2027-02-01', null],
  ['Delta Sanitary Group', 'Sanitaryware', 73000, 51100, 'Proposal Sent', 50, '2026-10-28', null]
];

async function main() {
  await db.init();

  const { count } = await db.one('SELECT COUNT(*)::int AS count FROM deals');
  if (count > 0) {
    console.log(`Deals table already has ${count} rows - skipping sample data to avoid duplicates.`);
    return;
  }

  const admin = await db.one("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1");
  const ownerId = admin ? admin.id : null;

  for (const row of sample) {
    await db.query(
      `INSERT INTO deals
        (customer_name, product_category, value, cost, stage, probability,
         expected_close_date, won_lost_date, owner_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [...row, ownerId]
    );
  }

  console.log(`Inserted ${sample.length} sample deals.`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e.message);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
