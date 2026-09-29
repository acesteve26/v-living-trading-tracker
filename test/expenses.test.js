// Expenses: the overheads that sit alongside the pipeline, who can change
// them, and the period filtering the page is built around.
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

const anExpense = (overrides = {}) => ({
  expense_date: '2026-05-15',
  description: 'Warehouse rent',
  category: 'Rent',
  amount: 12000,
  ...overrides
});

describe('recording an expense', () => {
  test('a valid expense is saved and read back', async () => {
    const res = await admin.post('/api/expenses', anExpense({ description: 'Saved Expense' }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.expense.description, 'Saved Expense');
    assert.equal(res.body.expense.amount, 12000);
    assert.equal(res.body.expense.expense_date, '2026-05-15');
    assert.equal(res.body.expense.created_by_name, 'V Living Admin');
  });

  test('it can be edited, and only the real changes are logged', async () => {
    const created = await admin.post('/api/expenses', anExpense({ description: 'Before Edit', amount: 500 }));
    const id = created.body.expense.id;

    const updated = await admin.put(`/api/expenses/${id}`, anExpense({ description: 'After Edit', amount: 750 }));
    assert.equal(updated.status, 200);
    assert.equal(updated.body.expense.description, 'After Edit');
    assert.equal(updated.body.expense.amount, 750);

    const { events } = (await admin.get('/api/activity')).body;
    const edit = events.find((e) => e.action === 'expense_updated' && e.subject === 'After Edit');
    assert.ok(edit, 'the edit should be in the activity log');
    assert.match(edit.detail, /description: Before Edit → After Edit/);
    assert.match(edit.detail, /amount: 500 → 750/);
  });

  test('it can be deleted, and the deletion is recorded', async () => {
    const created = await admin.post('/api/expenses', anExpense({ description: 'Doomed Expense' }));
    const id = created.body.expense.id;

    assert.equal((await admin.del(`/api/expenses/${id}`)).status, 200);
    assert.equal((await admin.put(`/api/expenses/${id}`, anExpense())).status, 404, 'it should be gone');

    const { events } = (await admin.get('/api/activity')).body;
    assert.ok(events.some((e) => e.action === 'expense_deleted' && e.subject === 'Doomed Expense'));
  });

  test('creating one is recorded in the activity log', async () => {
    await admin.post('/api/expenses', anExpense({ description: 'Logged Expense', category: 'Marketing' }));
    const { events } = (await admin.get('/api/activity')).body;
    const entry = events.find((e) => e.action === 'expense_created' && e.subject === 'Logged Expense');
    assert.ok(entry);
    assert.match(entry.detail, /Marketing/);
  });
});

describe('what an expense must have', () => {
  const cases = [
    ['no description', { description: '' }],
    ['a description of only spaces', { description: '   ' }],
    ['no date', { expense_date: null }],
    ['an impossible date', { expense_date: '2026-02-30' }],
    ['a malformed date', { expense_date: 'last tuesday' }],
    ['a negative amount', { amount: -100 }],
    ['an absurd amount', { amount: 1e15 }],
    ['no amount', { amount: '' }],
    ['an amount that is not a number', { amount: 'a lot' }],
    ['a category that does not exist', { category: 'Yachts' }]
  ];

  for (const [label, override] of cases) {
    test(`rejects ${label}`, async () => {
      const res = await admin.post('/api/expenses', anExpense(override));
      assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.ok(res.body.error);
    });
  }

  test('zero is allowed - a nil expense is a real thing to record', async () => {
    const res = await admin.post('/api/expenses', anExpense({ amount: 0, description: 'Zero Expense' }));
    assert.equal(res.status, 200);
  });
});

describe('periods and totals', () => {
  before(async () => {
    // one in each of three quarters of 2027, to filter against
    await admin.post('/api/expenses', anExpense({ expense_date: '2027-01-10', amount: 1000, description: 'Q1 spend', category: 'Utilities' }));
    await admin.post('/api/expenses', anExpense({ expense_date: '2027-04-10', amount: 2000, description: 'Q2 spend', category: 'Utilities' }));
    await admin.post('/api/expenses', anExpense({ expense_date: '2027-07-10', amount: 4000, description: 'Q3 spend', category: 'Travel' }));
  });

  test('a quarter returns only that quarter', async () => {
    const res = await admin.get('/api/expenses?range=quarter:2027-2');
    const descriptions = res.body.expenses.map((e) => e.description);
    assert.deepEqual(descriptions, ['Q2 spend']);
    assert.equal(res.body.total, 2000);
    assert.equal(res.body.range.label, 'Q2 2027');
  });

  test('a full year adds the quarters up', async () => {
    const res = await admin.get('/api/expenses?range=year:2027');
    assert.equal(res.body.total, 7000);
    assert.equal(res.body.count, 3);
  });

  test('a custom range takes the dates given', async () => {
    const res = await admin.get('/api/expenses?range=custom&from=2027-04-01&to=2027-12-31');
    assert.equal(res.body.total, 6000, 'Q2 and Q3 but not Q1');
  });

  test('the category breakdown covers every category, including the empty ones', async () => {
    const res = await admin.get('/api/expenses?range=year:2027');
    const { EXPENSE_CATEGORIES } = require('../constants');
    for (const category of EXPENSE_CATEGORIES) {
      assert.ok(category in res.body.byCategory, `${category} missing from the breakdown`);
    }
    assert.equal(res.body.byCategory.Utilities.total, 3000);
    assert.equal(res.body.byCategory.Utilities.count, 2);
    assert.equal(res.body.byCategory.Travel.total, 4000);
    assert.equal(res.body.byCategory.Rent.total, 0, 'an untouched category reads as nothing spent');
  });

  test('filtering by category narrows both the list and the total', async () => {
    const res = await admin.get('/api/expenses?range=year:2027&category=Travel');
    assert.equal(res.body.count, 1);
    assert.equal(res.body.total, 4000);
  });

  test('a period with nothing in it is empty rather than an error', async () => {
    const res = await admin.get('/api/expenses?range=year:2026&category=Customs %26 Duty');
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 0);
    assert.equal(res.body.total, 0);
  });
});

describe('who can change expenses', () => {
  let sales, management, accounts;

  before(async () => {
    sales = await h.createUserAndLogin(admin, { name: 'Exp Sales', email: 'exp-sales@test.local', role: 'sales' });
    management = await h.createUserAndLogin(admin, { name: 'Exp Mgmt', email: 'exp-mgmt@test.local', role: 'management' });
    accounts = await h.createUserAndLogin(admin, { name: 'Exp Acc', email: 'exp-acc@test.local', role: 'accounts' });
  });

  test('accounts can add and edit them', async () => {
    const created = await accounts.client.post('/api/expenses', anExpense({ description: 'Accounts Added' }));
    assert.equal(created.status, 200);
    assert.equal(
      (await accounts.client.put(`/api/expenses/${created.body.expense.id}`, anExpense({ description: 'Accounts Edited' }))).status,
      200
    );
  });

  test('sales and management cannot add, edit or delete', async () => {
    const existing = await admin.post('/api/expenses', anExpense({ description: 'Hands Off' }));
    const id = existing.body.expense.id;

    for (const role of [sales, management]) {
      assert.equal((await role.client.post('/api/expenses', anExpense())).status, 403);
      assert.equal((await role.client.put(`/api/expenses/${id}`, anExpense())).status, 403);
      assert.equal((await role.client.del(`/api/expenses/${id}`)).status, 403);
    }
  });

  test('but every signed-in role can see them and their totals', async () => {
    for (const role of [sales, management, accounts]) {
      const res = await role.client.get('/api/expenses?range=year:2027');
      assert.equal(res.status, 200);
      assert.equal(res.body.total, 7000, 'everyone sees the same figures');
    }
  });

  test('signed out, expenses are not reachable', async () => {
    assert.equal((await h.createClient().get('/api/expenses')).status, 401);
  });

  test('the browser is told who may edit', async () => {
    assert.equal((await admin.get('/api/session')).body.user.canEditExpenses, true);
    assert.equal((await accounts.client.get('/api/session')).body.user.canEditExpenses, true);
    assert.equal((await sales.client.get('/api/session')).body.user.canEditExpenses, false);
    assert.equal((await management.client.get('/api/session')).body.user.canEditExpenses, false);
  });
});

describe('expenses in the downloadable report', () => {
  before(async () => {
    await admin.post('/api/expenses', anExpense({ expense_date: '2028-03-05', amount: 9000, description: 'Report rent', category: 'Rent' }));
    await admin.post('/api/expenses', anExpense({ expense_date: '2028-03-20', amount: 1500, description: 'Report freight', category: 'Freight & Shipping' }));
    // outside the window, to prove the section is bounded by the report dates
    await admin.post('/api/expenses', anExpense({ expense_date: '2028-05-01', amount: 99999, description: 'Out of period', category: 'Rent' }));
  });

  test('the report carries the expenses for its own dates, and only those', async () => {
    const res = await admin.get('/api/report?from=2028-03-01&to=2028-03-31');
    assert.equal(res.status, 200);

    const { expenses } = res.body;
    assert.ok(expenses, 'the report should include an expenses section');
    assert.equal(expenses.count, 2);
    assert.equal(expenses.total, 10500);

    const descriptions = expenses.items.map((e) => e.description);
    assert.ok(descriptions.includes('Report rent'));
    assert.ok(!descriptions.includes('Out of period'), 'the section must respect the report window');
  });

  test('it breaks the period down by category', async () => {
    const { expenses } = (await admin.get('/api/report?from=2028-03-01&to=2028-03-31')).body;
    assert.equal(expenses.byCategory.Rent.total, 9000);
    assert.equal(expenses.byCategory['Freight & Shipping'].total, 1500);
    assert.equal(expenses.byCategory.Salaries.total, 0, 'untouched categories read as nothing spent');
  });

  test('a week works as well as a month, since the report is run for both', async () => {
    const { expenses } = (await admin.get('/api/report?from=2028-03-01&to=2028-03-07')).body;
    assert.equal(expenses.count, 1, 'only the expense inside that week');
    assert.equal(expenses.total, 9000);
  });

  test('the deal figures in the same report are untouched by it', async () => {
    const res = await admin.get('/api/report?from=2028-03-01&to=2028-03-31');
    // 10,500 of overheads sit in the same period and must not appear in any
    // deal total, gross profit figure or margin.
    assert.equal(res.body.summary.wonGp.gp, 0, 'no expense has leaked into gross profit');
    assert.equal(res.body.summary.wonValue, 0);
  });
});

describe('expenses stay out of deal margin', () => {
  test('recording an expense does not change deal gross profit', async () => {
    await admin.post('/api/deals', h.baseDeal({ customer_name: 'Margin Deal', value: 100000, cost: 60000, stage: 'Won', won_lost_date: '2027-03-01' }));
    const before = (await admin.get('/api/dashboard?range=year:2027')).body.kpis.wonGp.gp;

    await admin.post('/api/expenses', anExpense({ expense_date: '2027-03-02', amount: 50000, description: 'Big overhead' }));
    const after = (await admin.get('/api/dashboard?range=year:2027')).body.kpis.wonGp.gp;

    assert.equal(after, before, 'an overhead is not a deal cost and must not touch deal margin');
  });
});
