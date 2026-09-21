// Shared test setup.
//
// Tests run against a throwaway schema inside the same Postgres database, so
// they exercise the real schema, real constraints and real SQL - without ever
// touching development or live data. The schema is created before the app
// loads and dropped afterwards.
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-not-used-anywhere-real';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'testadmin123';

const TEST_SCHEMA = `test_${process.pid}_${Date.now().toString(36)}`;
process.env.DB_SCHEMA = TEST_SCHEMA;

const pg = require('pg');

async function createSchema() {
  // A plain client on the default schema, purely to create the test one.
  require('../config'); // loads .env
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === 'off' ? false : { rejectUnauthorized: true }
  });
  await client.connect();
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${TEST_SCHEMA}"`);
  await client.end();
}

async function dropSchema() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === 'off' ? false : { rejectUnauthorized: true }
  });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
  await client.end();
}

let server;
let baseUrl;
let db;

async function startApp() {
  await createSchema();
  const appModule = require('../server');
  db = require('../db');
  server = await appModule.start(0); // port 0 = any free port
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, db };
}

async function stopApp() {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (db) await db.pool.end();
  await dropSchema();
}

// Minimal cookie-aware client, so tests exercise the real session flow.
function createClient() {
  let cookie = '';
  return {
    async request(method, path, body) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      if (setCookie.length) cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
      let data = null;
      try { data = await res.json(); } catch { /* no body */ }
      return { status: res.status, body: data };
    },
    // Uploads and downloads are the one place the app moves bytes rather than
    // JSON, so they need a route around the JSON client above.
    async upload(path, filename, bytes, contentType = 'application/octet-stream') {
      const res = await fetch(`${baseUrl}${path}?filename=${encodeURIComponent(filename)}`, {
        method: 'POST',
        headers: { 'Content-Type': contentType, ...(cookie ? { Cookie: cookie } : {}) },
        body: bytes
      });
      let data = null;
      try { data = await res.json(); } catch { /* no body */ }
      return { status: res.status, body: data };
    },
    async download(path) {
      const res = await fetch(`${baseUrl}${path}`, { headers: cookie ? { Cookie: cookie } : {} });
      return {
        status: res.status,
        headers: res.headers,
        bytes: Buffer.from(await res.arrayBuffer())
      };
    },
    get(path) { return this.request('GET', path); },
    post(path, body) { return this.request('POST', path, body); },
    put(path, body) { return this.request('PUT', path, body); },
    patch(path, body) { return this.request('PATCH', path, body); },
    del(path) { return this.request('DELETE', path); },
    get cookie() { return cookie; }
  };
}

async function loginAs(email, password) {
  const client = createClient();
  const res = await client.post('/api/login', { email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${JSON.stringify(res.body)}`);
  return client;
}

async function loginAsAdmin() {
  return loginAs('admin@test.local', 'testadmin123');
}

// Creates a user and returns a client already signed in as them, with the
// forced password change completed.
async function createUserAndLogin(admin, { name, email, role }) {
  const tempPassword = 'temp-password-123';
  const created = await admin.post('/api/users', { name, email, password: tempPassword, role });
  if (created.status !== 200) throw new Error(`could not create ${email}: ${JSON.stringify(created.body)}`);
  const client = await loginAs(email, tempPassword);
  const ownPassword = 'own-password-456';
  await client.post('/api/change-password', { currentPassword: tempPassword, newPassword: ownPassword });
  return { client, id: created.body.id, password: ownPassword };
}

const baseDeal = (overrides = {}) => ({
  customer_name: 'Test Customer',
  product_category: 'Tiles',
  value: 100000,
  cost: 70000,
  stage: 'Lead',
  probability: 10,
  expected_close_date: '2026-11-30',
  ...overrides
});

module.exports = {
  TEST_SCHEMA,
  startApp,
  stopApp,
  createClient,
  loginAs,
  loginAsAdmin,
  createUserAndLogin,
  baseDeal,
  getDb: () => db,
  getBaseUrl: () => baseUrl
};
