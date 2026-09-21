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

// ---------------------------------------------------------------- auth

describe('authentication', () => {
  test('rejects a wrong password', async () => {
    const c = h.createClient();
    const res = await c.post('/api/login', { email: 'admin@test.local', password: 'wrong' });
    assert.equal(res.status, 401);
  });

  test('rejects an unknown email', async () => {
    const c = h.createClient();
    const res = await c.post('/api/login', { email: 'nobody@test.local', password: 'whatever' });
    assert.equal(res.status, 401);
  });

  test('does not say whether the email exists', async () => {
    const c = h.createClient();
    const unknown = await c.post('/api/login', { email: 'nobody@test.local', password: 'x' });
    const known = await c.post('/api/login', { email: 'admin@test.local', password: 'x' });
    assert.equal(unknown.body.error, known.body.error);
  });

  test('blocks unauthenticated access to deals', async () => {
    const c = h.createClient();
    assert.equal((await c.get('/api/deals')).status, 401);
  });

  test('issues a new session id on login', async () => {
    const c = h.createClient();
    await c.post('/api/login', { email: 'admin@test.local', password: 'testadmin123' });
    const first = c.cookie;
    await c.post('/api/login', { email: 'admin@test.local', password: 'testadmin123' });
    assert.notEqual(first, c.cookie, 'session id should change when re-authenticating');
  });

  test('logout ends the session', async () => {
    const c = await h.loginAsAdmin();
    await c.post('/api/logout');
    assert.equal((await c.get('/api/deals')).status, 401);
  });
});

// ---------------------------------------------------------- permissions

describe('role permissions', () => {
  let sales, management, accounts;

  before(async () => {
    sales = await h.createUserAndLogin(admin, { name: 'Sales Person', email: 'sales@test.local', role: 'sales' });
    management = await h.createUserAndLogin(admin, { name: 'Manager', email: 'mgmt@test.local', role: 'management' });
    accounts = await h.createUserAndLogin(admin, { name: 'Accountant', email: 'accounts@test.local', role: 'accounts' });
  });

  test('sales can create a deal', async () => {
    const res = await sales.client.post('/api/deals', h.baseDeal({ customer_name: 'Sales Created' }));
    assert.equal(res.status, 200);
  });

  test('management cannot create a deal', async () => {
    const res = await management.client.post('/api/deals', h.baseDeal());
    assert.equal(res.status, 403);
  });

  test('accounts cannot create a deal', async () => {
    const res = await accounts.client.post('/api/deals', h.baseDeal());
    assert.equal(res.status, 403);
  });

  test('read-only roles can still read deals and run reports', async () => {
    for (const role of [management, accounts]) {
      assert.equal((await role.client.get('/api/deals')).status, 200);
      assert.equal((await role.client.get('/api/report?from=2026-01-01&to=2026-12-31')).status, 200);
      assert.equal((await role.client.get('/api/dashboard?range=year:2026')).status, 200);
    }
  });

  test('only admin can manage users', async () => {
    for (const role of [sales, management, accounts]) {
      const res = await role.client.post('/api/users', {
        name: 'Nope', email: `nope-${Math.random()}@test.local`, password: 'password123'
      });
      assert.equal(res.status, 403);
    }
  });

  test('a demoted user loses write access on their very next request', async () => {
    const victim = await h.createUserAndLogin(admin, {
      name: 'Demote Me', email: 'demote@test.local', role: 'sales'
    });
    assert.equal((await victim.client.post('/api/deals', h.baseDeal())).status, 200);

    await admin.patch(`/api/users/${victim.id}`, { role: 'accounts' });

    const after = await victim.client.post('/api/deals', h.baseDeal());
    assert.equal(after.status, 403, 'demotion must apply without the user reloading');
  });

  test('deactivating a user ends their session immediately', async () => {
    const victim = await h.createUserAndLogin(admin, {
      name: 'Deactivate Me', email: 'deactivate@test.local', role: 'sales'
    });
    assert.equal((await victim.client.get('/api/deals')).status, 200);

    await admin.patch(`/api/users/${victim.id}`, { active: false });

    assert.equal((await victim.client.get('/api/deals')).status, 401);
  });

  test('an admin cannot remove their own admin role or deactivate themselves', async () => {
    const me = (await admin.get('/api/session')).body.user;
    assert.equal((await admin.patch(`/api/users/${me.id}`, { role: 'sales' })).status, 400);
    assert.equal((await admin.patch(`/api/users/${me.id}`, { active: false })).status, 400);
    assert.equal((await admin.get('/api/session')).body.user.role, 'admin');
  });
});

// ------------------------------------------------- forced password change

describe('temporary passwords', () => {
  test('a new user must set their own password before doing anything', async () => {
    const email = 'forced@test.local';
    await admin.post('/api/users', { name: 'Forced', email, password: 'temp-password-123', role: 'sales' });
    const c = await h.loginAs(email, 'temp-password-123');

    assert.equal((await c.get('/api/session')).body.user.mustChangePassword, true);
    assert.equal((await c.get('/api/deals')).status, 403, 'blocked until the password is changed');

    const changed = await c.post('/api/change-password', {
      currentPassword: 'temp-password-123',
      newPassword: 'chosen-password-1'
    });
    assert.equal(changed.status, 200);
    assert.equal((await c.get('/api/deals')).status, 200, 'unblocked afterwards');
    assert.equal((await c.get('/api/session')).body.user.mustChangePassword, false);
  });
});

// ------------------------------------------------------------ validation

describe('deal validation', () => {
  const cases = [
    ['probability above 100', { probability: 5000 }],
    ['negative probability', { probability: -10 }],
    ['non-integer probability', { probability: 12.5 }],
    ['impossible date', { expected_close_date: '2026-13-45' }],
    ['malformed date', { expected_close_date: 'soon' }],
    ['negative value', { value: -1 }],
    ['absurd value', { value: 1e15 }],
    ['negative cost', { cost: -5 }],
    ['unknown stage', { stage: 'Maybe' }],
    // deliberately something the business does not sell; 'Marble' used to sit
    // here and became a real category, which this suite caught
    ['unknown category', { product_category: 'Carpet' }],
    ['missing customer name', { customer_name: '' }],
    ['owner who does not exist', { owner_id: 999999 }]
  ];

  for (const [label, override] of cases) {
    test(`rejects ${label} with a 400`, async () => {
      const res = await admin.post('/api/deals', h.baseDeal(override));
      assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.ok(res.body.error, 'should explain what was wrong');
    });
  }

  test('accepts a valid deal', async () => {
    const res = await admin.post('/api/deals', h.baseDeal({ customer_name: 'Perfectly Valid' }));
    assert.equal(res.status, 200);
  });
});
