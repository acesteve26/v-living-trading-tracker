// Documents attached to deals.
//
// The 50 MB ceiling is a business rule read from config, so the cap is set to
// something tiny here. That keeps the limit honest - the same code path is
// exercised - without pushing 50 MB over the wire to the test database.
process.env.MAX_DEAL_DOCUMENT_BYTES = String(64 * 1024);

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

const CAP = 64 * 1024;

let admin;
let dealId;

// A real little PDF, header and all, rather than random bytes labelled .pdf.
const pdf = (size = 512) => {
  const header = Buffer.from('%PDF-1.4\n%test document\n');
  return Buffer.concat([header, Buffer.alloc(Math.max(0, size - header.length), 0x20)]);
};

async function newDeal(name) {
  const res = await admin.post('/api/deals', h.baseDeal({ customer_name: name }));
  assert.equal(res.status, 200, `could not create deal: ${JSON.stringify(res.body)}`);
  return res.body.deal.id;
}

before(async () => {
  await h.startApp();
  admin = await h.loginAsAdmin();
  dealId = await newDeal('Documents Customer');
});

after(async () => {
  await h.stopApp();
});

describe('attaching documents', () => {
  test('a file goes up, comes back in the list, and downloads byte for byte', async () => {
    const bytes = pdf(2048);
    const up = await admin.upload(`/api/deals/${dealId}/documents`, 'quotation.pdf', bytes, 'application/pdf');
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(up.body.document.filename, 'quotation.pdf');
    assert.equal(up.body.document.byte_size, bytes.length);
    assert.equal(up.body.document.uploaded_by_name, 'V Living Admin');

    const list = await admin.get(`/api/deals/${dealId}/documents`);
    assert.equal(list.status, 200);
    assert.ok(list.body.documents.some((d) => d.filename === 'quotation.pdf'));
    assert.equal(list.body.maxBytes, CAP);

    const down = await admin.download(`/api/documents/${up.body.document.id}`);
    assert.equal(down.status, 200);
    assert.ok(down.bytes.equals(bytes), 'the file that comes back must be the file that went up');
  });

  test('the listing never carries the file contents', async () => {
    const list = await admin.get(`/api/deals/${dealId}/documents`);
    for (const doc of list.body.documents) {
      assert.ok(!('bytes' in doc), 'listing a deal must not drag file contents with it');
    }
  });

  test('downloads are handed over as attachments, never rendered', async () => {
    const up = await admin.upload(`/api/deals/${dealId}/documents`, 'spec sheet.pdf', pdf(), 'text/html');
    const down = await admin.download(`/api/documents/${up.body.document.id}`);

    const disposition = down.headers.get('content-disposition');
    assert.ok(disposition.startsWith('attachment;'), `expected an attachment, got: ${disposition}`);
    assert.match(disposition, /spec sheet\.pdf/);
    // the browser claimed text/html on the way in; the extension decides
    assert.equal(down.headers.get('content-type'), 'application/pdf');
    assert.match(down.headers.get('cache-control'), /no-store/);
  });

  test('a filename carrying a path is stored as a bare name', async () => {
    const up = await admin.upload(`/api/deals/${dealId}/documents`, '../../etc/passwd.pdf', pdf(), 'application/pdf');
    assert.equal(up.status, 200);
    assert.equal(up.body.document.filename, 'passwd.pdf');
  });

  test('refuses a file type that is not on the list', async () => {
    for (const name of ['payload.exe', 'drawing.svg', 'page.html', 'noextension']) {
      const res = await admin.upload(`/api/deals/${dealId}/documents`, name, pdf(), 'application/pdf');
      assert.equal(res.status, 400, `${name} should have been refused`);
      assert.ok(res.body.error);
    }
  });

  test('refuses an empty file', async () => {
    const res = await admin.upload(`/api/deals/${dealId}/documents`, 'empty.pdf', Buffer.alloc(0), 'application/pdf');
    assert.equal(res.status, 400);
  });

  test('refuses an upload to a deal that does not exist', async () => {
    const res = await admin.upload('/api/deals/999999/documents', 'orphan.pdf', pdf(), 'application/pdf');
    assert.equal(res.status, 404);
  });
});

describe('the per-deal size cap', () => {
  test('fills a deal to its limit and then refuses the next file', async () => {
    const id = await newDeal('Cap Customer');

    // three quarters of the budget in one file
    const big = pdf(Math.floor(CAP * 0.75));
    assert.equal((await admin.upload(`/api/deals/${id}/documents`, 'big.pdf', big, 'application/pdf')).status, 200);

    // another one of the same size does not fit alongside it
    const refused = await admin.upload(`/api/deals/${id}/documents`, 'big-again.pdf', big, 'application/pdf');
    assert.equal(refused.status, 400, 'the second file should not fit');
    assert.match(refused.body.error, /left|whole/i);

    // but a small one still does
    assert.equal(
      (await admin.upload(`/api/deals/${id}/documents`, 'small.pdf', pdf(256), 'application/pdf')).status,
      200
    );

    const list = await admin.get(`/api/deals/${id}/documents`);
    assert.ok(list.body.usedBytes <= CAP, 'the total must never exceed the cap');
    assert.equal(list.body.documents.length, 2);
  });

  test('a single file larger than the cap is rejected outright', async () => {
    const id = await newDeal('Oversized Customer');
    const res = await admin.upload(`/api/deals/${id}/documents`, 'huge.pdf', pdf(CAP * 2), 'application/pdf');
    assert.equal(res.status, 413, JSON.stringify(res.body));
    assert.match(res.body.error, /too large/i);
  });

  test('the cap is per deal, not across all of them', async () => {
    const id = await newDeal('Separate Budget Customer');
    const res = await admin.upload(`/api/deals/${id}/documents`, 'fresh.pdf', pdf(Math.floor(CAP * 0.75)), 'application/pdf');
    assert.equal(res.status, 200, 'a different deal starts with its own allowance');
  });
});

describe('who can do what with documents', () => {
  let sales, management, accounts, docId;

  before(async () => {
    sales = await h.createUserAndLogin(admin, { name: 'Doc Sales', email: 'doc-sales@test.local', role: 'sales' });
    management = await h.createUserAndLogin(admin, { name: 'Doc Manager', email: 'doc-mgmt@test.local', role: 'management' });
    accounts = await h.createUserAndLogin(admin, { name: 'Doc Accounts', email: 'doc-acc@test.local', role: 'accounts' });

    const up = await admin.upload(`/api/deals/${dealId}/documents`, 'shared.pdf', pdf(), 'application/pdf');
    docId = up.body.document.id;
  });

  test('sales can attach documents', async () => {
    const res = await sales.client.upload(`/api/deals/${dealId}/documents`, 'from-sales.pdf', pdf(), 'application/pdf');
    assert.equal(res.status, 200);
  });

  test('read-only roles can read documents and download them', async () => {
    for (const role of [management, accounts]) {
      assert.equal((await role.client.get(`/api/deals/${dealId}/documents`)).status, 200);
      assert.equal((await role.client.download(`/api/documents/${docId}`)).status, 200);
    }
  });

  test('read-only roles cannot attach or remove documents', async () => {
    for (const role of [management, accounts]) {
      const up = await role.client.upload(`/api/deals/${dealId}/documents`, 'nope.pdf', pdf(), 'application/pdf');
      assert.equal(up.status, 403);
      assert.equal((await role.client.del(`/api/documents/${docId}`)).status, 403);
    }
  });

  test('signed out, documents are not reachable at all', async () => {
    const anon = h.createClient();
    assert.equal((await anon.get(`/api/deals/${dealId}/documents`)).status, 401);
    assert.equal((await anon.download(`/api/documents/${docId}`)).status, 401);
  });
});

describe('documents and the rest of the deal', () => {
  test('attaching and removing are both recorded in the deal history', async () => {
    const id = await newDeal('History Customer');
    const up = await admin.upload(`/api/deals/${id}/documents`, 'contract.pdf', pdf(), 'application/pdf');
    await admin.del(`/api/documents/${up.body.document.id}`);

    const { history } = (await admin.get(`/api/deals/${id}/history`)).body;
    const added = history.find((e) => e.action === 'document_added');
    const removed = history.find((e) => e.action === 'document_removed');

    assert.ok(added, 'the upload should be in the trail');
    assert.equal(added.new_value, 'contract.pdf');
    assert.ok(removed, 'the removal should be in the trail');
    assert.equal(removed.old_value, 'contract.pdf');
  });

  test('an archived deal keeps its documents but takes no new ones', async () => {
    const id = await newDeal('Archived Customer');
    const up = await admin.upload(`/api/deals/${id}/documents`, 'before-archive.pdf', pdf(), 'application/pdf');

    await admin.post(`/api/deals/${id}/archive`);

    assert.equal((await admin.download(`/api/documents/${up.body.document.id}`)).status, 200,
      'an archived deal is still readable');
    const blocked = await admin.upload(`/api/deals/${id}/documents`, 'after-archive.pdf', pdf(), 'application/pdf');
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error, /restore/i);
  });

  test('deleting a deal takes its documents with it', async () => {
    const id = await newDeal('Doomed Customer');
    const up = await admin.upload(`/api/deals/${id}/documents`, 'goes-away.pdf', pdf(), 'application/pdf');
    const docId = up.body.document.id;

    await admin.del(`/api/deals/${id}`);

    assert.equal((await admin.download(`/api/documents/${docId}`)).status, 404);
    const db = h.getDb();
    const left = await db.one('SELECT COUNT(*)::int AS n FROM deal_documents WHERE deal_id = $1', [id]);
    assert.equal(left.n, 0, 'no orphaned file contents should be left behind');
  });
});
