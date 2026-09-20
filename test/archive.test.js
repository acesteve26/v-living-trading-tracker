// Archiving replaces destructive deletion for everyday use. These tests cover
// the thing that actually matters: an archived deal must vanish from every
// figure, without the record being lost.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let admin;
let sales;

before(async () => {
  await h.startApp();
  admin = await h.loginAsAdmin();
  sales = await h.createUserAndLogin(admin, {
    name: 'Archive Sales', email: 'archive-sales@test.local', role: 'sales'
  });
});

after(async () => {
  await h.stopApp();
});

const createDeal = async (client, overrides) => {
  const res = await client.post('/api/deals', h.baseDeal(overrides));
  assert.equal(res.status, 200, `create failed: ${JSON.stringify(res.body)}`);
  return res.body.deal;
};

describe('archiving', () => {
  test('an archived deal disappears from the deal list', async () => {
    const deal = await createDeal(sales.client, { customer_name: 'To Archive' });
    assert.ok((await sales.client.get('/api/deals')).body.deals.some((d) => d.id === deal.id));

    assert.equal((await sales.client.post(`/api/deals/${deal.id}/archive`)).status, 200);

    const after = (await sales.client.get('/api/deals')).body.deals;
    assert.ok(!after.some((d) => d.id === deal.id), 'archived deals are hidden by default');
  });

  test('archived deals can still be listed deliberately', async () => {
    const res = await sales.client.get('/api/deals?archived=true');
    assert.ok(res.body.deals.some((d) => d.customer_name === 'To Archive'));
  });

  test('archiving removes the deal from pipeline figures', async () => {
    const deal = await createDeal(sales.client, {
      customer_name: 'Counted Then Archived', value: 250000, stage: 'Qualified', expected_close_date: '2026-08-01'
    });

    const before = (await admin.get('/api/dashboard?range=year:2026')).body.kpis;
    await sales.client.post(`/api/deals/${deal.id}/archive`);
    const afterKpis = (await admin.get('/api/dashboard?range=year:2026')).body.kpis;

    assert.equal(afterKpis.totalOpenValue, before.totalOpenValue - 250000, 'value drops by exactly that deal');
    assert.equal(afterKpis.openCount, before.openCount - 1);
  });

  test('archiving removes a won deal from the report and its GP', async () => {
    const deal = await createDeal(admin, {
      customer_name: 'Won Then Archived', value: 90000, cost: 50000, stage: 'Won', won_lost_date: '2026-06-10'
    });

    const before = (await admin.get('/api/report?from=2026-06-01&to=2026-06-30')).body.summary;
    await admin.post(`/api/deals/${deal.id}/archive`);
    const afterSummary = (await admin.get('/api/report?from=2026-06-01&to=2026-06-30')).body.summary;

    assert.equal(afterSummary.wonValue, before.wonValue - 90000);
    assert.equal(afterSummary.wonGp.gp, before.wonGp.gp - 40000);
  });

  test('an archived deal drops out of Needs Attention', async () => {
    const deal = await createDeal(sales.client, {
      customer_name: 'Attention Then Archived', expected_close_date: null
    });
    const before = (await admin.get('/api/dashboard?range=year:2026')).body.needsAttention;
    assert.ok(before.some((d) => d.id === deal.id), 'flagged while active');

    await sales.client.post(`/api/deals/${deal.id}/archive`);
    const afterAttention = (await admin.get('/api/dashboard?range=year:2026')).body.needsAttention;
    assert.ok(!afterAttention.some((d) => d.id === deal.id));
  });

  test('restoring brings the deal and its value back', async () => {
    const deal = await createDeal(sales.client, {
      customer_name: 'Restore Me', value: 40000, stage: 'Qualified', expected_close_date: '2026-09-15'
    });
    await sales.client.post(`/api/deals/${deal.id}/archive`);
    const archived = (await admin.get('/api/dashboard?range=year:2026')).body.kpis.totalOpenValue;

    assert.equal((await sales.client.post(`/api/deals/${deal.id}/restore`)).status, 200);

    const restored = (await admin.get('/api/dashboard?range=year:2026')).body.kpis.totalOpenValue;
    assert.equal(restored, archived + 40000);
    assert.ok((await sales.client.get('/api/deals')).body.deals.some((d) => d.id === deal.id));
  });

  test('archiving and restoring are recorded in the history', async () => {
    const deal = await createDeal(sales.client, { customer_name: 'Archive History' });
    await sales.client.post(`/api/deals/${deal.id}/archive`);
    await sales.client.post(`/api/deals/${deal.id}/restore`);

    const actions = (await sales.client.get(`/api/deals/${deal.id}/history`)).body.history.map((x) => x.action);
    assert.ok(actions.includes('archived'));
    assert.ok(actions.includes('restored'));
  });

  test('archiving twice is refused rather than silently repeated', async () => {
    const deal = await createDeal(sales.client, { customer_name: 'Double Archive' });
    await sales.client.post(`/api/deals/${deal.id}/archive`);
    assert.equal((await sales.client.post(`/api/deals/${deal.id}/archive`)).status, 400);
  });

  test('restoring a deal that is not archived is refused', async () => {
    const deal = await createDeal(sales.client, { customer_name: 'Not Archived' });
    assert.equal((await sales.client.post(`/api/deals/${deal.id}/restore`)).status, 400);
  });
});

describe('permanent deletion', () => {
  test('sales cannot permanently delete a deal', async () => {
    const deal = await createDeal(sales.client, { customer_name: 'Sales Cannot Delete' });
    assert.equal((await sales.client.del(`/api/deals/${deal.id}`)).status, 403);

    // and the deal is still there
    assert.ok((await admin.get('/api/deals')).body.deals.some((d) => d.id === deal.id));
  });

  test('an admin can, and the history still records it', async () => {
    const deal = await createDeal(admin, { customer_name: 'Admin Can Delete' });
    assert.equal((await admin.del(`/api/deals/${deal.id}`)).status, 200);

    const db = h.getDb();
    const rows = await db.all("SELECT action FROM deal_history WHERE deal_name = 'Admin Can Delete'");
    assert.ok(rows.some((r) => r.action === 'deleted'));
  });

  test('read-only roles cannot archive either', async () => {
    const deal = await createDeal(admin, { customer_name: 'Read Only Archive Attempt' });
    const accounts = await h.createUserAndLogin(admin, {
      name: 'Archive Accounts', email: 'archive-accounts@test.local', role: 'accounts'
    });
    assert.equal((await accounts.client.post(`/api/deals/${deal.id}/archive`)).status, 403);
  });
});
