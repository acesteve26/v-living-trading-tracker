// Covers the numbers people actually act on: gross profit, stage transitions,
// period ranges and the audit trail.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let admin;

before(async () => {
  await h.startApp();
  admin = await h.loginAsAdmin();
});

after(async () => {
  await h.stopApp();
});

const createDeal = async (overrides) => {
  const res = await admin.post('/api/deals', h.baseDeal(overrides));
  assert.equal(res.status, 200, `create failed: ${JSON.stringify(res.body)}`);
  return res.body.deal;
};

// ------------------------------------------------------- stage behaviour

describe('stage transitions', () => {
  test('marking a deal Won sets the close date automatically', async () => {
    const deal = await createDeal({ customer_name: 'Auto Won Date', stage: 'Lead' });
    assert.equal(deal.won_lost_date, null);

    const res = await admin.put(`/api/deals/${deal.id}`, { ...deal, stage: 'Won', probability: 100 });
    assert.equal(res.status, 200);
    assert.ok(res.body.deal.won_lost_date, 'a won deal must have a date');
  });

  test('reopening a won deal clears the close date', async () => {
    const deal = await createDeal({ customer_name: 'Reopened', stage: 'Won' });
    assert.ok(deal.won_lost_date);

    const res = await admin.put(`/api/deals/${deal.id}`, { ...deal, stage: 'Negotiation', probability: 70 });
    assert.equal(res.body.deal.won_lost_date, null);
  });

  test('a lost reason is kept on a lost deal', async () => {
    const deal = await createDeal({
      customer_name: 'Lost On Price', stage: 'Lost', lost_reason: 'Price'
    });
    assert.equal(deal.lost_reason, 'Price');
  });

  test('reopening a lost deal clears the reason, so no stale explanation lingers', async () => {
    const deal = await createDeal({
      customer_name: 'Lost Then Revived', stage: 'Lost', lost_reason: 'Lost to competitor'
    });
    const res = await admin.put(`/api/deals/${deal.id}`, { ...deal, stage: 'Qualified', probability: 30 });
    assert.equal(res.body.deal.lost_reason, null);
  });

  test('a lost reason is ignored on a deal that is not lost', async () => {
    const deal = await createDeal({
      customer_name: 'Not Lost', stage: 'Lead', lost_reason: 'Price'
    });
    assert.equal(deal.lost_reason, null);
  });
});

// --------------------------------------------------------- gross profit

describe('gross profit', () => {
  test('GP and margin are value minus cost', async () => {
    const deal = await createDeal({ customer_name: 'GP Maths', value: 100000, cost: 70000, stage: 'Won' });
    const report = await admin.get('/api/report?from=2020-01-01&to=2030-12-31');
    const row = report.body.won.find((d) => d.id === deal.id);
    assert.equal(row.value - row.cost, 30000);
  });

  test('a deal with no cost is excluded from GP but still counted', async () => {
    await createDeal({ customer_name: 'Costed', value: 100000, cost: 60000, stage: 'Won', won_lost_date: '2026-03-01' });
    await createDeal({ customer_name: 'Uncosted', value: 50000, cost: null, stage: 'Won', won_lost_date: '2026-03-02' });

    const res = await admin.get('/api/report?from=2026-03-01&to=2026-03-31');
    const { wonGp, wonCount, wonValue } = res.body.summary;

    assert.equal(wonCount, 2, 'both deals counted');
    assert.equal(wonValue, 150000, 'both values included');
    assert.equal(wonGp.gp, 40000, 'only the costed deal contributes GP');
    assert.equal(wonGp.pricedCount, 1);
    assert.equal(wonGp.totalCount, 2, 'coverage is reported so partial GP is not read as complete');
  });

  test('a loss-making deal produces negative GP rather than being hidden', async () => {
    await createDeal({
      customer_name: 'Sold At A Loss', value: 50000, cost: 60000, stage: 'Won', won_lost_date: '2026-04-15'
    });
    const res = await admin.get('/api/report?from=2026-04-01&to=2026-04-30');
    assert.equal(res.body.summary.wonGp.gp, -10000);
  });

  test('zero gross profit is reported as zero, not as missing', async () => {
    await createDeal({
      customer_name: 'Break Even', value: 80000, cost: 80000, stage: 'Won', won_lost_date: '2026-05-10'
    });
    const res = await admin.get('/api/report?from=2026-05-01&to=2026-05-31');
    assert.equal(res.body.summary.wonGp.gp, 0);
    assert.equal(res.body.summary.wonGp.pricedCount, 1, 'a break-even deal is still costed');
  });
});

// --------------------------------------------------------- dashboard

describe('dashboard figures', () => {
  test('open count covers exactly the deals in the open value', async () => {
    await createDeal({ customer_name: 'Scheduled A', value: 10000, stage: 'Qualified', expected_close_date: '2026-07-01' });
    await createDeal({ customer_name: 'Unscheduled B', value: 500000, stage: 'Qualified', expected_close_date: null });

    const res = await admin.get('/api/dashboard?range=year:2026');
    const { openCount, totalOpenValue } = res.body.kpis;

    // rebuild the total from the deals the API says are open in this period
    const deals = (await admin.get('/api/deals')).body.deals;
    const scheduledOpen = deals.filter(
      (d) => ['Lead', 'Qualified', 'Proposal Sent', 'Negotiation'].includes(d.stage) &&
             d.expected_close_date && d.expected_close_date >= '2026-01-01' && d.expected_close_date <= '2026-12-31'
    );

    assert.equal(openCount, scheduledOpen.length, 'count must match the deals behind the value');
    assert.equal(
      totalOpenValue,
      scheduledOpen.reduce((s, d) => s + d.value, 0),
      'value must cover exactly those deals'
    );
  });

  test('deals with no close date are surfaced rather than silently dropped', async () => {
    const res = await admin.get('/api/dashboard?range=year:2026');
    assert.ok(res.body.unscheduledOpenCount > 0, 'unscheduled deals are counted separately');
    assert.ok(res.body.unscheduledOpenValue > 0, 'and their value is reported');

    const flagged = res.body.needsAttention.find((d) => d.customer_name === 'Unscheduled B');
    assert.ok(flagged, 'an unscheduled deal should appear in Needs Attention');
    assert.ok(flagged.reasons.some((r) => r.code === 'nodate'));
  });

  test('weighted pipeline applies each stage probability', async () => {
    const res = await admin.get('/api/dashboard?range=year:2026');
    const deals = (await admin.get('/api/deals')).body.deals;
    const expected = deals
      .filter((d) => ['Lead', 'Qualified', 'Proposal Sent', 'Negotiation'].includes(d.stage) &&
                     d.expected_close_date && d.expected_close_date.startsWith('2026'))
      .reduce((s, d) => s + (d.value * d.probability) / 100, 0);
    assert.ok(Math.abs(res.body.kpis.weightedOpenValue - expected) < 0.01);
  });
});

// ------------------------------------------------------------- periods

describe('period ranges', () => {
  const { computeRange } = require('../server');

  test('a full year covers the whole calendar year', () => {
    const r = computeRange('year:2027');
    assert.equal(r.from, '2027-01-01');
    assert.equal(r.to, '2027-12-31');
  });

  test('a month range ends on the correct last day', () => {
    const r = computeRange('this_month');
    const [y, m] = r.from.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    assert.equal(r.to.split('-')[2], String(lastDay).padStart(2, '0'));
  });

  test('a custom range is passed through unchanged', () => {
    const r = computeRange('custom', '2026-02-03', '2026-04-05');
    assert.equal(r.from, '2026-02-03');
    assert.equal(r.to, '2026-04-05');
  });

  test('an unrecognised range falls back to this month rather than erroring', () => {
    const r = computeRange('nonsense');
    assert.match(r.from, /^\d{4}-\d{2}-01$/);
  });
});

// ------------------------------------------------------------- history

describe('deal history', () => {
  test('creating a deal records it', async () => {
    const deal = await createDeal({ customer_name: 'History Created' });
    const res = await admin.get(`/api/deals/${deal.id}/history`);
    assert.equal(res.body.history.length, 1);
    assert.equal(res.body.history[0].action, 'created');
  });

  test('each changed field is recorded with its before and after', async () => {
    const deal = await createDeal({ customer_name: 'History Changed', value: 1000, stage: 'Lead' });
    await admin.put(`/api/deals/${deal.id}`, { ...deal, value: 2000, stage: 'Qualified', probability: 30 });

    const { history } = (await admin.get(`/api/deals/${deal.id}/history`)).body;
    const byField = Object.fromEntries(history.filter((x) => x.field).map((x) => [x.field, x]));

    assert.equal(byField.value.old_value, '1000');
    assert.equal(byField.value.new_value, '2000');
    assert.equal(byField.stage.old_value, 'Lead');
    assert.equal(byField.stage.new_value, 'Qualified');
  });

  test('an unchanged save records nothing', async () => {
    const deal = await createDeal({ customer_name: 'History Unchanged' });
    await admin.put(`/api/deals/${deal.id}`, deal);
    const { history } = (await admin.get(`/api/deals/${deal.id}/history`)).body;
    assert.equal(history.filter((x) => x.action === 'updated').length, 0);
  });

  test('history survives the deal being deleted', async () => {
    const deal = await createDeal({ customer_name: 'History Deleted' });
    await admin.del(`/api/deals/${deal.id}`);

    const db = h.getDb();
    const rows = await db.all(
      "SELECT action, deal_id, deal_name FROM deal_history WHERE deal_name = 'History Deleted'"
    );
    assert.ok(rows.length >= 2, 'creation and deletion both recorded');
    assert.ok(rows.some((r) => r.action === 'deleted'));
    assert.ok(rows.every((r) => r.deal_id === null), 'link cleared but the trail kept');
  });

  test('a failed write leaves neither the deal nor its history behind', async () => {
    const db = h.getDb();
    const before = (await db.one('SELECT COUNT(*)::int AS c FROM deals')).c;
    const historyBefore = (await db.one('SELECT COUNT(*)::int AS c FROM deal_history')).c;

    await assert.rejects(
      db.transaction(async (client) => {
        await db.query(
          "INSERT INTO deals (customer_name, product_category, value, stage) VALUES ('Rollback', 'Tiles', 1, 'Lead')",
          [], client
        );
        throw new Error('simulated failure after the write');
      })
    );

    assert.equal((await db.one('SELECT COUNT(*)::int AS c FROM deals')).c, before);
    assert.equal((await db.one('SELECT COUNT(*)::int AS c FROM deal_history')).c, historyBefore);
  });
});

// ---------------------------------------------------------- categories

describe('product categories', () => {
  const { PRODUCT_CATEGORIES } = require('../constants');

  test('every configured category is accepted by the database', async () => {
    for (const category of PRODUCT_CATEGORIES) {
      const res = await admin.post('/api/deals', h.baseDeal({
        customer_name: `Category ${category}`,
        product_category: category,
        expected_close_date: '2027-03-01'
      }));
      assert.equal(res.status, 200, `${category} was rejected: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.deal.product_category, category);
    }
  });

  test('the new categories are among them', () => {
    for (const c of ['Wallpaper', 'Furniture', 'Marble']) {
      assert.ok(PRODUCT_CATEGORIES.includes(c), `${c} should be a category`);
    }
  });

  test("'Both' has been retired in favour of 'Mixed'", async () => {
    assert.ok(PRODUCT_CATEGORIES.includes('Mixed'));
    assert.ok(!PRODUCT_CATEGORIES.includes('Both'));
    const res = await admin.post('/api/deals', h.baseDeal({ product_category: 'Both' }));
    assert.equal(res.status, 400);
  });

  // The rename only matters on a database that already holds 'Both' rows, which
  // a fresh test schema never does - so one is manufactured here. Without this
  // the migration would first be exercised on the live data.
  test("a deal recorded as 'Both' is carried over to 'Mixed' on boot", async () => {
    const db = h.getDb();
    const created = await admin.post('/api/deals', h.baseDeal({
      customer_name: 'Legacy Both Deal',
      product_category: 'Tiles'
    }));
    const id = created.body.deal.id;

    // Put the database back the way it was before the rename: the row holds
    // 'Both', and the constraint in force is the old one, which permits 'Both'
    // and has never heard of 'Mixed'. Recreating that constraint matters - with
    // no constraint at all the migration passes whatever order it runs in,
    // which is how the first version of it got through.
    await db.query('ALTER TABLE deals DROP CONSTRAINT deals_product_category_check');
    await db.query('UPDATE deals SET product_category = $1 WHERE id = $2', ['Both', id]);
    // NOT VALID because the sibling test above has already put deals in the
    // newer categories, and a constraint from the old world cannot be applied
    // to those retrospectively. It is still enforced on writes, which is the
    // part that matters: the rename has to survive it.
    await db.query(
      `ALTER TABLE deals ADD CONSTRAINT deals_product_category_check
       CHECK (product_category IN ('Tiles','Sanitaryware','Both','Other')) NOT VALID`
    );
    await db.query(
      `INSERT INTO deal_history (deal_id, deal_name, action, field, old_value, new_value)
       VALUES ($1, $2, 'updated', 'product_category', 'Tiles', 'Both')`,
      [id, 'Legacy Both Deal']
    );

    await db.init(); // exactly what a deploy runs

    const deal = await db.one('SELECT product_category FROM deals WHERE id = $1', [id]);
    assert.equal(deal.product_category, 'Mixed', 'the deal should have been carried over');

    const history = await db.all(
      `SELECT new_value FROM deal_history WHERE deal_id = $1 AND field = 'product_category'`,
      [id]
    );
    assert.ok(history.length > 0);
    assert.ok(
      history.every((h2) => h2.new_value !== 'Both'),
      'the trail should not still name a category the app no longer has'
    );

    // and the rebuilt constraint is back in force
    const res = await admin.post('/api/deals', h.baseDeal({ product_category: 'Both' }));
    assert.equal(res.status, 400);
  });

  test('every category is reported on, not just the ones with deals', async () => {
    const res = await admin.get('/api/dashboard?range=year:2027');
    for (const category of PRODUCT_CATEGORIES) {
      assert.ok(category in res.body.byCategory, `${category} missing from the dashboard breakdown`);
    }

    const report = await admin.get('/api/report?from=2027-01-01&to=2027-12-31');
    for (const category of PRODUCT_CATEGORIES) {
      assert.ok(category in report.body.byCategory, `${category} missing from the report breakdown`);
    }
  });

  test('the browser is sent the same list the database enforces', async () => {
    const res = await admin.get('/api/settings');
    assert.deepEqual(res.body.productCategories, PRODUCT_CATEGORIES,
      'dropdowns must not be able to drift from the schema');
  });

  test('an unknown category is still refused', async () => {
    const res = await admin.post('/api/deals', h.baseDeal({ product_category: 'Carpet' }));
    assert.equal(res.status, 400);
  });
});
