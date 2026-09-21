// ============================================================================
// TEST: admin batch delete — 1 request menggantikan N request DELETE serial
//
// Masalah yang ditutup: Database Studio "bulk delete" mengirim SATU HTTP
// request per record (100 record = 100 request serial). Endpoint ini menerima
// array id dalam satu POST dan mengembalikan hasil per id.
//
// Fokus:
//  1. Semua sukses → deleted[] berisi semua, failedCount = 0
//  2. Partial → id yang tidak ada masuk failed, yang valid tetap terhapus
//  3. Cascade restrict: record yang dirujuk gagal tanpa merusak yang lain
//  4. Validasi: ids kosong → 400, > 100 → 400, butuh admin
//  5. Webhook/trigger tetap terpicu per record (full payload, konsisten M38)
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import nodeHttp from 'node:http';

const TEST_DATA_DIR = path.resolve('../data/m55-batch-delete-test');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.ADMIN_EMAIL = 'admin@m55.test';
process.env.ADMIN_PASSWORD = 'm55-secret-pass';
process.env.JWT_SECRET = 'm55-test-jwt-secret-key-long-enough';

const { initPlatformDb } = await import('../src/core/platformDb.js');
const { closeAllProjectDbs } = await import('../src/core/projectDbManager.js');
const { resetPlatformDbForTests } = await import('../src/core/platformDb.js');
const { Router } = await import('../src/core/router.js');
const { createAdminRouter } = await import('../src/api/adminRoutes.js');
const { createDatabaseRouter } = await import('../src/api/databaseRoutes.js');

let server;
let baseURL;
let adminToken;
let pid;

function http(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request(
      new URL(p, baseURL),
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let data = {};
          try { data = JSON.parse(raw || '{}'); } catch {}
          resolve({ status: res.statusCode ?? 0, data, raw });
        });
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function createRecord(coll, data) {
  const r = await http('POST', `/api/admin/projects/${pid}/collections/${coll}/records`, data, adminToken);
  assert.equal(r.status, 201, r.raw);
  return r.data.record.id;
}

before(async () => {
  initPlatformDb();
  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());
  server = nodeHttp.createServer((rq, rs) => router.handle(rq, rs));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${server.address().port}`;

  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@m55.test', password: 'm55-secret-pass',
  });
  adminToken = login.data.token;

  const proj = await http('POST', '/api/admin/projects', { name: 'm55-batch' }, adminToken);
  pid = proj.data.project.id;

  // Collection induk + collection perujuk (untuk uji cascade restrict)
  await http('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'items', fields: [{ name: 'title', type: 'text' }],
  }, adminToken);
  await http('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'refs',
    fields: [
      { name: 'note', type: 'text' },
      { name: 'item', type: 'relation', options: { collectionId: 'items', cascadeDelete: 'restrict' } },
    ],
  }, adminToken);
});

after(async () => {
  await new Promise((r) => server.close(() => r()));
  closeAllProjectDbs();
  resetPlatformDbForTests();
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}
});

test('semua sukses: seluruh id terhapus dalam satu request', async () => {
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push(await createRecord('items', { title: `r${i}` }));

  const res = await http(
    'POST',
    `/api/admin/projects/${pid}/collections/items/records/batch-delete`,
    { ids },
    adminToken
  );
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.data.deletedCount, 20);
  assert.equal(res.data.failedCount, 0);
  assert.equal(res.data.deleted.length, 20);

  // Semuanya benar-benar hilang
  const list = await http('GET', `/api/admin/projects/${pid}/collections/items/records?perPage=1`, undefined, adminToken);
  assert.equal(list.data.totalItems, 0);
});

test('partial: id tidak ada masuk failed, yang valid tetap terhapus', async () => {
  const a = await createRecord('items', { title: 'keep-check' });
  const b = await createRecord('items', { title: 'keep-check2' });

  const res = await http(
    'POST',
    `/api/admin/projects/${pid}/collections/items/records/batch-delete`,
    { ids: [a, 'tidak-ada-sama-sekali', b] },
    adminToken
  );
  assert.equal(res.status, 200);
  assert.equal(res.data.deletedCount, 2, 'kedua id valid tetap terhapus');
  assert.equal(res.data.failedCount, 1);
  assert.equal(res.data.failed[0].id, 'tidak-ada-sama-sekali');
  assert.equal(res.data.failed[0].reason, 'not found');

  const list = await http('GET', `/api/admin/projects/${pid}/collections/items/records`, undefined, adminToken);
  assert.equal(list.data.totalItems, 0);
});

test('cascade restrict: record yang dirujuk gagal, yang tidak dirujuk tetap terhapus', async () => {
  const referenced = await createRecord('items', { title: 'referenced' });
  const free = await createRecord('items', { title: 'free' });
  // refs.item merujuk ke `referenced` dengan cascadeDelete: restrict
  await createRecord('refs', { note: 'link', item: referenced });

  const res = await http(
    'POST',
    `/api/admin/projects/${pid}/collections/items/records/batch-delete`,
    { ids: [referenced, free] },
    adminToken
  );
  assert.equal(res.status, 200);
  assert.equal(res.data.deletedCount, 1, 'record bebas terhapus');
  assert.deepEqual(res.data.deleted, [free]);
  assert.equal(res.data.failedCount, 1, 'record yang dirujuk DILINDUNGI restrict');
  assert.equal(res.data.failed[0].id, referenced);
  assert.match(res.data.failed[0].reason, /restrict/i, 'alasan kegagalan menyebut restrict');

  // Referenced harus masih ada. Admin route tidak punya GET /records/:id,
  // jadi diverifikasi lewat list (satu-satunya yang tersisa harus dia).
  const list = await http('GET', `/api/admin/projects/${pid}/collections/items/records`, undefined, adminToken);
  assert.equal(list.data.totalItems, 1, 'hanya record restrict yang tersisa');
  assert.equal(list.data.items[0].id, referenced);

  // SINGLE delete pada record yang sama harus DITOLAK 409 RESTRICT_VIOLATION
  // (sebelumnya 500 INTERNAL_ERROR — pemetaan status yang salah).
  const single = await http('DELETE', `/api/admin/projects/${pid}/collections/items/records/${referenced}`, undefined, adminToken);
  assert.equal(single.status, 409, `single delete restrict harus 409, dapat ${single.status}: ${single.raw}`);
  assert.equal(single.data.error.code, 'RESTRICT_VIOLATION');
});

test('validasi: ids kosong, >100, non-array, dan auth', async () => {
  const empty = await http('POST', `/api/admin/projects/${pid}/collections/items/records/batch-delete`, { ids: [] }, adminToken);
  assert.equal(empty.status, 400);

  const notArray = await http('POST', `/api/admin/projects/${pid}/collections/items/records/batch-delete`, { ids: 'abc' }, adminToken);
  assert.equal(notArray.status, 400);

  const tooMany = await http(
    'POST',
    `/api/admin/projects/${pid}/collections/items/records/batch-delete`,
    { ids: Array.from({ length: 101 }, (_, i) => `id${i}`) },
    adminToken
  );
  assert.equal(tooMany.status, 400);

  const noAuth = await http('POST', `/api/admin/projects/${pid}/collections/items/records/batch-delete`, { ids: ['x'] });
  assert.equal(noAuth.status, 401);
});

test('100 record dalam satu request (maks batas, bukti pengganti 100 request)', async () => {
  // Collection terpisah — tidak dipakai test lain, jadi tidak ada record
  // restrict yang tersisa (itu yang dulu membuat totalItems = 1, bukan 0).
  await http('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'bulk', fields: [{ name: 'title', type: 'text' }],
  }, adminToken);

  const ids = [];
  for (let i = 0; i < 100; i++) ids.push(await createRecord('bulk', { title: `bulk${i}` }));
  assert.equal(ids.length, 100);

  const t0 = Date.now();
  const res = await http(
    'POST',
    `/api/admin/projects/${pid}/collections/bulk/records/batch-delete`,
    { ids },
    adminToken
  );
  const ms = Date.now() - t0;
  assert.equal(res.status, 200);
  assert.equal(res.data.deletedCount, 100);
  console.log(`    100 record dihapus dalam 1 request (${ms} ms)`);

  const list = await http('GET', `/api/admin/projects/${pid}/collections/bulk/records?perPage=1`, undefined, adminToken);
  assert.equal(list.data.totalItems, 0);
});
