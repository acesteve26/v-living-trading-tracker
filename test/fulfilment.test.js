// After the sale: Delivered and Paid on a won deal, who may tick them, and how
// they decide what still needs attention.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { FULFILMENT_FLAG_DAYS } = require('../constants');

let admin;
let sales;
let management;
let accounts;

// Business dates relative to today in Dubai, so these tests mean the same
// thing whichever day they run on.
const daysAgo = (n) => {
  const d = new Date(Date.now() - n * 86400000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
};
const today = () => daysAgo(0);

async function wonDeal(name, wonDaysAgo = 1, extra = {}) {
  const res = await admin.post('/api/deals', h.baseDeal({
    customer_name: name,
    stage: 'Won',
    probability: 100,
    won_lost_date: daysAgo(wonDaysAgo),
    expected_close_date: daysAgo(wonDaysAgo),
    ...extra
  }));
  assert.equal(res.status, 200, `could not create deal: ${JSON.stringify(res.body)}`);
  return res.body.deal;
}

const tick = (client, id, body) => client.patch(`/api/deals/${id}/fulfilment`, body);

// Moves a tick's date into the past, which the endpoint itself never does -
// it always records today. Only for setting up the "30 days ago" cases.
const backdate = (id, column, date) => h.getDb().query(`UPDATE deals SET ${column} = $1 WHERE id = $2`, [date, id]);

const attentionFor = async (name) => {
  const { needsAttention } = (await admin.get('/api/dashboard?range=ytd')).body;
  return needsAttention.find((d) => d.customer_name === name);
};

before(async () => {
  await h.startApp();
  admin = await h.loginAsAdmin();
  sales = (await h.createUserAndLogin(admin, { name: 'Ful Sales', email: 'ful-sales@test.local', role: 'sales' })).client;
  management = (await h.createUserAndLogin(admin, { name: 'Ful Mgmt', email: 'ful-mgmt@test.local', role: 'management' })).client;
  accounts = (await h.createUserAndLogin(admin, { name: 'Ful Accounts', email: 'ful-acc@test.local', role: 'accounts' })).client;
});

after(async () => {
  await h.stopApp();
});

describe('ticking delivered and paid', () => {
  test('ticking records the day and who did it', async () => {
    const deal = await wonDeal('Tick Records');
    const res = await tick(admin, deal.id, { delivered: true });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.deal.delivered_on, today());
    assert.equal(res.body.deal.delivered_by_name, 'V Living Admin');
    assert.equal(res.body.deal.paid_on, null, 'ticking one leaves the other alone');
  });

  test('it lands in the deal history', async () => {
    const deal = await wonDeal('Tick History');
    await tick(admin, deal.id, { paid: true });

    const { history } = (await admin.get(`/api/deals/${deal.id}/history`)).body;
    const entry = history.find((e) => e.field === 'paid_on');
    assert.ok(entry, 'the payment tick should be in the trail');
    assert.equal(entry.new_value, today());
  });

  test('ticking something already ticked keeps the original date', async () => {
    const deal = await wonDeal('Tick Twice');
    await tick(admin, deal.id, { delivered: true });
    await backdate(deal.id, 'delivered_on', daysAgo(5));

    const res = await tick(admin, deal.id, { delivered: true });
    assert.equal(res.body.deal.delivered_on, daysAgo(5), 'a second click must not move when it arrived');
  });

  test('taking a tick off clears its date and who', async () => {
    const deal = await wonDeal('Tick Removed');
    await tick(admin, deal.id, { delivered: true });
    const res = await tick(admin, deal.id, { delivered: false });

    assert.equal(res.body.deal.delivered_on, null);
    assert.equal(res.body.deal.delivered_by_name, null);
  });

  test('only a won deal can be ticked', async () => {
    const open = await admin.post('/api/deals', h.baseDeal({ customer_name: 'Not Won Yet', stage: 'Negotiation' }));
    const res = await tick(admin, open.body.deal.id, { delivered: true });
    assert.equal(res.status, 400);
  });

  test('reopening a won deal clears both ticks', async () => {
    const deal = await wonDeal('Reopened After Tick');
    await tick(admin, deal.id, { delivered: true, paid: true });

    const current = (await admin.get(`/api/deals/${deal.id}`)).body.deal;
    const res = await admin.put(`/api/deals/${deal.id}`, { ...current, stage: 'Negotiation', probability: 70 });

    assert.equal(res.body.deal.delivered_on, null, 'a deal back in the pipeline has delivered nothing');
    assert.equal(res.body.deal.paid_on, null);
  });

  test('editing a won deal leaves its ticks in place', async () => {
    const deal = await wonDeal('Edited After Tick');
    await tick(admin, deal.id, { delivered: true });

    const current = (await admin.get(`/api/deals/${deal.id}`)).body.deal;
    const res = await admin.put(`/api/deals/${deal.id}`, { ...current, description: 'a note' });
    assert.equal(res.body.deal.delivered_on, today(), 'a routine edit must not undo delivery');
  });

  test('a malformed request is refused rather than guessed at', async () => {
    const deal = await wonDeal('Bad Tick');
    assert.equal((await tick(admin, deal.id, {})).status, 400);
    assert.equal((await tick(admin, deal.id, { delivered: 'yes' })).status, 400);
  });
});

describe('who can tick what', () => {
  test('sales can tick both', async () => {
    const deal = await wonDeal('Sales Ticks');
    assert.equal((await tick(sales, deal.id, { delivered: true })).status, 200);
    assert.equal((await tick(sales, deal.id, { paid: true })).status, 200);
  });

  test('accounts can mark a deal paid, and only paid', async () => {
    const deal = await wonDeal('Accounts Ticks');
    assert.equal((await tick(accounts, deal.id, { paid: true })).status, 200, 'paying is a finance job');
    assert.equal((await tick(accounts, deal.id, { delivered: true })).status, 403, 'delivery is not');
    assert.equal(
      (await accounts.put(`/api/deals/${deal.id}`, { ...deal, description: 'sneaky' })).status,
      403,
      'and accounts still cannot edit the deal itself'
    );
  });

  test('management can tick neither', async () => {
    const deal = await wonDeal('Management Ticks');
    assert.equal((await tick(management, deal.id, { delivered: true })).status, 403);
    assert.equal((await tick(management, deal.id, { paid: true })).status, 403);
  });

  test('the browser is told who may mark paid', async () => {
    assert.equal((await accounts.get('/api/session')).body.user.canMarkPaid, true);
    assert.equal((await management.get('/api/session')).body.user.canMarkPaid, false);
  });
});

describe('what needs attention after a win', () => {
  test(`a deal won over ${FULFILMENT_FLAG_DAYS} days ago and not delivered is flagged`, async () => {
    await wonDeal('Stuck Delivery', FULFILMENT_FLAG_DAYS + 1);
    const entry = await attentionFor('Stuck Delivery');
    assert.ok(entry, 'it should be in Needs Attention');
    assert.ok(entry.reasons.some((r) => r.code === 'delivery'), 'flagged as not yet delivered');
  });

  test('a recent win with no next action is left alone', async () => {
    await wonDeal('Fresh Win', 5);
    assert.equal(await attentionFor('Fresh Win'), undefined, 'five days is not yet late');
  });

  test(`delivered over ${FULFILMENT_FLAG_DAYS} days ago and not paid is flagged`, async () => {
    const deal = await wonDeal('Slow Payer', FULFILMENT_FLAG_DAYS + 20);
    await tick(admin, deal.id, { delivered: true });
    await backdate(deal.id, 'delivered_on', daysAgo(FULFILMENT_FLAG_DAYS + 1));

    const entry = await attentionFor('Slow Payer');
    assert.ok(entry);
    assert.ok(entry.reasons.some((r) => r.code === 'payment'), 'flagged as not yet paid');
    assert.ok(!entry.reasons.some((r) => r.code === 'delivery'), 'and no longer as undelivered');
  });

  test('the payment clock starts at delivery, not at the win', async () => {
    // won long ago, but only delivered last week: payment is not late yet
    const deal = await wonDeal('Late Delivery Recent', FULFILMENT_FLAG_DAYS + 30);
    await tick(admin, deal.id, { delivered: true });
    await backdate(deal.id, 'delivered_on', daysAgo(7));

    assert.equal(await attentionFor('Late Delivery Recent'), undefined);
  });

  test('an overdue next action on an unfinished won deal is flagged', async () => {
    await wonDeal('Won Action Late', 3, { next_action: 'Book the delivery truck', next_action_date: daysAgo(2) });
    const entry = await attentionFor('Won Action Late');
    assert.ok(entry);
    assert.ok(entry.reasons.some((r) => r.code === 'action'));
  });

  test('once delivered and paid, nothing on the deal can be late', async () => {
    const deal = await wonDeal('All Done', FULFILMENT_FLAG_DAYS + 40, {
      next_action: 'Old follow-up', next_action_date: daysAgo(20)
    });
    await tick(admin, deal.id, { delivered: true, paid: true });

    assert.equal(await attentionFor('All Done'), undefined, 'a finished deal never needs attention');
    const overdue = (await admin.get('/api/deals?view=overdue')).body.deals.map((d) => d.customer_name);
    assert.ok(!overdue.includes('All Done'));
  });

  test('pipeline-only checks never fire on a won deal', async () => {
    await wonDeal('No Pipeline Noise', FULFILMENT_FLAG_DAYS + 1);
    const entry = await attentionFor('No Pipeline Noise');
    const codes = entry.reasons.map((r) => r.code);
    assert.ok(!codes.includes('close'), 'a won deal\'s close date is in the past by definition');
    assert.ok(!codes.includes('quiet'));
    assert.ok(!codes.includes('nodate'));
  });
});

describe('finding won deals still outstanding', () => {
  before(async () => {
    const delivered = await wonDeal('View Delivered Unpaid');
    await tick(admin, delivered.id, { delivered: true });
    await wonDeal('View Undelivered');
    const done = await wonDeal('View Complete');
    await tick(admin, done.id, { delivered: true, paid: true });
  });

  const names = async (view) => (await admin.get(`/api/deals?view=${view}`)).body.deals.map((d) => d.customer_name);

  test('awaiting delivery lists won deals not yet delivered', async () => {
    const list = await names('awaiting_delivery');
    assert.ok(list.includes('View Undelivered'));
    assert.ok(!list.includes('View Delivered Unpaid'));
    assert.ok(!list.includes('View Complete'));
  });

  test('awaiting payment lists won deals not yet paid', async () => {
    const list = await names('awaiting_payment');
    assert.ok(list.includes('View Delivered Unpaid'));
    assert.ok(list.includes('View Undelivered'), 'not delivered also means not paid');
    assert.ok(!list.includes('View Complete'));
  });

  test('the list marks lateness exactly as Needs Attention does', async () => {
    const lateDelivery = await wonDeal('Pill Late Delivery', FULFILMENT_FLAG_DAYS + 2);
    const latePayment = await wonDeal('Pill Late Payment', FULFILMENT_FLAG_DAYS + 40);
    await tick(admin, latePayment.id, { delivered: true });
    await backdate(latePayment.id, 'delivered_on', daysAgo(FULFILMENT_FLAG_DAYS + 3));
    const onTime = await wonDeal('Pill On Time', 4);

    const { deals } = (await admin.get('/api/deals?status=won')).body;
    const row = (id) => deals.find((d) => d.id === id);

    assert.equal(row(lateDelivery.id).delivery_late, true);
    assert.equal(row(lateDelivery.id).payment_late, false, 'payment cannot be late before delivery');
    assert.equal(row(latePayment.id).delivery_late, false);
    assert.equal(row(latePayment.id).payment_late, true);
    assert.equal(row(onTime.id).delivery_late, false);

    // and every deal the list calls late is one Needs Attention flags for it
    for (const deal of [lateDelivery, latePayment]) {
      const entry = await attentionFor(deal.customer_name);
      assert.ok(entry, `${deal.customer_name} is late on the list, so it must be in Needs Attention`);
    }
  });

  test('the overdue filter now includes an unfinished won deal with a late action', async () => {
    await wonDeal('Overdue Filter Won', 3, { next_action: 'Chase deposit', next_action_date: daysAgo(1) });
    assert.ok((await names('overdue')).includes('Overdue Filter Won'));
  });
});
