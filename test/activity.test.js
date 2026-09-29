// The activity log: what gets recorded, who can read it, and the merging of
// the two streams it is built from.
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

const eventsFor = async (client, query = '') => (await client.get(`/api/activity${query}`)).body.events;
const findAction = (events, action) => events.find((e) => e.action === action);

describe('what gets recorded', () => {
  test('signing in is recorded', async () => {
    await h.loginAsAdmin();
    const signIn = findAction(await eventsFor(admin), 'signed_in');
    assert.ok(signIn, 'a sign-in should appear in the log');
    assert.equal(signIn.actor_name, 'V Living Admin');
    assert.equal(signIn.source, 'system');
  });

  test('a failed sign-in is recorded against the account it was aimed at', async () => {
    const c = h.createClient();
    await c.post('/api/login', { email: 'admin@test.local', password: 'not-the-password' });

    const failure = findAction(await eventsFor(admin), 'sign_in_failed');
    assert.ok(failure, 'a failed attempt should be recorded');
    assert.equal(failure.actor_name, 'V Living Admin', 'attributed to the real account');
    assert.match(failure.detail, /wrong password/i);
  });

  test('a failed sign-in against an unknown email keeps what was typed', async () => {
    const c = h.createClient();
    await c.post('/api/login', { email: 'ghost@test.local', password: 'whatever' });

    const events = await eventsFor(admin);
    const ghost = events.find((e) => e.action === 'sign_in_failed' && e.actor_name === 'ghost@test.local');
    assert.ok(ghost, 'an attempt on an unknown email should still be recorded');
    assert.equal(ghost.actor_id, null);
  });

  test('signing out is recorded', async () => {
    const c = await h.loginAsAdmin();
    await c.post('/api/logout');
    // the write is not awaited by the route, so give it a moment to land
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(findAction(await eventsFor(admin), 'signed_out'));
  });

  test('running a report is recorded, so read-only roles are not invisible', async () => {
    await admin.get('/api/report?from=2026-01-01&to=2026-12-31');
    const run = findAction(await eventsFor(admin), 'report_run');
    assert.ok(run, 'a report run should be recorded');
    assert.match(run.detail, /2026-01-01 to 2026-12-31/);
  });

  test('admin changes to an account are recorded with what changed', async () => {
    const created = await admin.post('/api/users', {
      name: 'Audit Subject', email: 'audit@test.local', password: 'temp-password-123', role: 'sales'
    });
    assert.equal(created.status, 200);

    await admin.patch(`/api/users/${created.body.id}`, { role: 'accounts' });
    await admin.patch(`/api/users/${created.body.id}`, { active: false });
    await admin.patch(`/api/users/${created.body.id}`, { newPassword: 'reset-by-admin-1' });

    const events = await eventsFor(admin);

    const made = findAction(events, 'user_created');
    assert.equal(made.subject, 'Audit Subject');

    const roleChange = events.find((e) => e.action === 'user_updated' && /role/.test(e.detail || ''));
    assert.match(roleChange.detail, /role: sales → accounts/);

    assert.ok(findAction(events, 'user_deactivated'), 'deactivation is called out by name');
    assert.ok(findAction(events, 'user_password_reset'), 'a password reset is called out by name');
  });

  test('changing your own password is recorded', async () => {
    const victim = await h.createUserAndLogin(admin, {
      name: 'Self Changer', email: 'selfchange@test.local', role: 'sales'
    });
    // createUserAndLogin already performs the forced change
    const events = await eventsFor(admin, `?userId=${victim.id}`);
    assert.ok(findAction(events, 'password_changed'));
  });
});

describe('the merged timeline', () => {
  test('deal changes and system events share one stream', async () => {
    await admin.post('/api/deals', h.baseDeal({ customer_name: 'Activity Deal' }));
    const events = await eventsFor(admin);

    assert.ok(events.some((e) => e.source === 'deal'), 'deal history should be included');
    assert.ok(events.some((e) => e.source === 'system'), 'system events should be included');

    const dealEvent = events.find((e) => e.source === 'deal' && e.action === 'created');
    assert.equal(dealEvent.subject, 'Activity Deal', 'the deal name comes through as the subject');
  });

  test('newest first', async () => {
    const events = await eventsFor(admin);
    const times = events.map((e) => new Date(e.at).getTime());
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
  });

  test('filtering by user returns only that person', async () => {
    const sales = await h.createUserAndLogin(admin, {
      name: 'Only Mine', email: 'onlymine@test.local', role: 'sales'
    });
    await sales.client.post('/api/deals', h.baseDeal({ customer_name: 'Their Deal' }));

    const events = await eventsFor(admin, `?userId=${sales.id}`);
    assert.ok(events.length > 0);
    for (const e of events) {
      assert.equal(e.actor_id, sales.id, `a foreign event leaked in: ${e.action} by ${e.actor_name}`);
    }
  });

  test('the summary counts the week and the month separately', async () => {
    const res = await admin.get('/api/activity');
    const created = res.body.summary.find((s) => s.action === 'created');
    assert.ok(created.week > 0, 'deals created this week should be counted');
    assert.ok(created.month >= created.week, 'the month can never be smaller than the week');
  });

  test('it says when recording began, rather than implying it goes back further', async () => {
    const res = await admin.get('/api/activity');
    assert.ok(res.body.recordingSince, 'the panel needs a start date to be honest about');
  });
});

describe('who can read the activity log', () => {
  let sales, management, accounts;

  before(async () => {
    sales = await h.createUserAndLogin(admin, { name: 'Log Sales', email: 'log-sales@test.local', role: 'sales' });
    management = await h.createUserAndLogin(admin, { name: 'Log Mgmt', email: 'log-mgmt@test.local', role: 'management' });
    accounts = await h.createUserAndLogin(admin, { name: 'Log Acc', email: 'log-acc@test.local', role: 'accounts' });
  });

  test('admin and management can read it', async () => {
    assert.equal((await admin.get('/api/activity')).status, 200);
    assert.equal((await management.client.get('/api/activity')).status, 200);
  });

  test('sales and accounts cannot', async () => {
    for (const role of [sales, accounts]) {
      const res = await role.client.get('/api/activity');
      assert.equal(res.status, 403, 'only admin and management may read the log');
    }
  });

  test('management can read it but still cannot manage anyone', async () => {
    const res = await management.client.post('/api/users', {
      name: 'Nope', email: 'mgmt-nope@test.local', password: 'password123'
    });
    assert.equal(res.status, 403);
  });

  test('signed out, it is not reachable', async () => {
    assert.equal((await h.createClient().get('/api/activity')).status, 401);
  });
});

describe('last seen', () => {
  test('is stamped as someone uses the app', async () => {
    const user = await h.createUserAndLogin(admin, {
      name: 'Seen Recently', email: 'seen@test.local', role: 'sales'
    });
    await user.client.get('/api/deals');
    // the stamp is written without blocking the request it came from
    await new Promise((r) => setTimeout(r, 400));

    const { users } = (await admin.get('/api/users')).body;
    const row = users.find((u) => u.id === user.id);
    assert.ok(row.last_seen_at, 'last_seen_at should be set once they have used the app');
    assert.ok(
      Date.now() - new Date(row.last_seen_at).getTime() < 60_000,
      'and it should be recent'
    );
  });
});
