// ============================================================================
// M34: TEST CUSTOM DOCUMENT ID — create dengan ID spesifik
//
// Fokus test:
//  1. Create dengan custom ID → record dibuat dengan ID itu
//  2. Auto-ID (tanpa id) tetap bekerja
//  3. Invalid ID format → 400
//  4. Duplicate ID → 409 DOCUMENT_ID_TAKEN
//  5. ID dengan karakter valid (underscore, dash, mixed case)
//  6. Admin API juga menerima custom ID
//  7. Update/delete custom ID record bekerja normal
// 8. Custom ID + rules (createRule masih dievaluasi terhadap DATA, bukan ID)
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import nodeHttp from 'node:http';
import { initPlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { Router } from '../src/core/router.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';
import { createPublicRouter } from '../src/api/publicRoutes.js';

const TEST_DATA_DIR = path.resolve('../data/m34-custom-id-test');

let server: nodeHttp.Server;
let baseURL: string;
let adminToken: string;
let projectId: string;

function http(
  method: string,
  p: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; data: any }> {
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
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let data: any = {};
          try { data = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'); } catch {}
          resolve({ status: res.statusCode ?? 0, data });
        });
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

before(async () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  process.env.DATA_DIR = TEST_DATA_DIR;
  process.env.ADMIN_EMAIL = 'admin@m34.test';
  process.env.ADMIN_PASSWORD = 'm34-secret-pass';
  process.env.JWT_SECRET = 'm34-test-jwt-secret-key-long-enough';
  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());
  router.merge(createPublicRouter());

  server = nodeHttp.createServer((rq, rs) => router.handle(rq, rs));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@m34.test',
    password: 'm34-secret-pass',
  });
  assert.equal(login.status, 200, `login failed: ${JSON.stringify(login.data)}`);
  adminToken = login.data.token;
  assert.ok(adminToken, 'adminToken harus ada');

  const proj = await http('POST', '/api/admin/projects', { name: 'm34-custom-id' }, adminToken);
  console.log('DEBUG proj:', proj.status, JSON.stringify(proj.data).slice(0, 100));
  assert.equal(proj.status, 201, `project creation failed: ${JSON.stringify(proj.data)}`);
  projectId = proj.data.project?.id;
  console.log('DEBUG projectId:', projectId);
  assert.ok(projectId, `projectId harus ada: ${JSON.stringify(proj.data)}`);

  const col = await http(
    'POST',
    `/api/admin/projects/${projectId}/collections`,
    {
      name: 'items',
      fields: [{ name: 'title', type: 'text' }, { name: 'userId', type: 'text' }],
      rules: { listRule: '', viewRule: '', createRule: '', updateRule: '', deleteRule: '' },
    },
    adminToken
  );
  assert.equal(col.status, 201, `collection creation failed: ${JSON.stringify(col.data)}`);
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  closeAllProjectDbs();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// Lazy path builder — dievaluasi saat DIPANGGIL, bukan saat module load
const B = () => `/api/p/${projectId}/collections/items`;

// ─── 1. Custom ID bekerja ────────────────────────────────────────────────────

test('create dengan custom ID → record pakai ID itu', async () => {
  const create = await http('POST', `${B()}/records`, {
    id: 'my_custom_id_123',
    title: 'Hello Custom ID',
    userId: 'user1',
  });
  assert.equal(create.status, 201, JSON.stringify(create.data));
  assert.equal(create.data.record.id, 'my_custom_id_123');
  assert.equal(create.data.record.title, 'Hello Custom ID');

  // Verifikasi: GET by ID bekerja
  const get = await http('GET', `${B()}/records/my_custom_id_123`);
  assert.equal(get.status, 200);
  assert.equal(get.data.record.title, 'Hello Custom ID');
});

// ─── 2. Auto-ID tetap bekerja ────────────────────────────────────────────────

test('create TANPA id → auto-generated ID', async () => {
  const create = await http('POST', `${B()}/records`, {
    title: 'Auto ID',
    userId: 'user1',
  });
  assert.equal(create.status, 201);
  assert.ok(create.data.record.id);
  assert.notEqual(create.data.record.id, 'undefined');
  assert.ok(create.data.record.id.length >= 10, 'auto-ID cukup panjang');
});

// ─── 3. Invalid ID format → 400 ──────────────────────────────────────────────

test('invalid ID format ditolak (400)', async () => {
  const bad1 = await http('POST', `${B()}/records`, {
    id: 'has space',
    title: 'x',
    userId: 'u',
  });
  assert.equal(bad1.status, 400);
  assert.match(bad1.data.error.message, /Invalid document ID/);

  const bad2 = await http('POST', `${B()}/records`, {
    id: 'has/slash',
    title: 'x',
    userId: 'u',
  });
  assert.equal(bad2.status, 400);

  const bad3 = await http('POST', `${B()}/records`, {
    id: 12345, // number, bukan string
    title: 'x',
    userId: 'u',
  });
  assert.equal(bad3.status, 400);

  // ID terlalu panjang (>64)
  const bad4 = await http('POST', `${B()}/records`, {
    id: 'a'.repeat(65),
    title: 'x',
    userId: 'u',
  });
  assert.equal(bad4.status, 400);
});

// ─── 4. Duplicate ID → 409 ───────────────────────────────────────────────────

test('duplicate ID → 409 DOCUMENT_ID_TAKEN', async () => {
  // Buat pertama
  await http('POST', `${B()}/records`, {
    id: 'duplicate_test_id',
    title: 'First',
    userId: 'u',
  });

  // Coba duplikat
  const dup = await http('POST', `${B()}/records`, {
    id: 'duplicate_test_id',
    title: 'Second',
    userId: 'u',
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error.code, 'DOCUMENT_ID_TAKEN');
  assert.match(dup.data.error.message, /already exists/);

  // Verifikasi: record pertama tidak tertimpa
  const get = await http('GET', `${B()}/records/duplicate_test_id`);
  assert.equal(get.status, 200);
  assert.equal(get.data.record.title, 'First');
});

// ─── 5. ID dengan format yang valid ─────────────────────────────────────────

test('ID dengan underscore, dash, mixed case, angka → valid', async () => {
  const validIds = ['user_abc', 'user-xyz', 'MixedCase123', 'a1b2c3', '_', '-'];
  for (const id of validIds) {
    const create = await http('POST', `${B()}/records`, {
      id,
      title: `Item ${id}`,
      userId: 'u',
    });
    assert.equal(create.status, 201, `ID '${id}' harus valid`);
    assert.equal(create.data.record.id, id);
  }
});

// ─── 6. Admin API juga menerima custom ID ───────────────────────────────────

test('admin API: create dengan custom ID bekerja', async () => {
  const create = await http(
    'POST',
    `/api/admin/projects/${projectId}/collections/items/records`,
    { id: 'admin_custom_id', title: 'Admin Item', userId: 'admin' },
    adminToken
  );
  assert.equal(create.status, 201, JSON.stringify(create.data));
  assert.equal(create.data.record.id, 'admin_custom_id');
});

// ─── 7. Update & delete custom ID record ────────────────────────────────────

test('update & delete record dengan custom ID bekerja normal', async () => {
  await http('POST', `${B()}/records`, {
    id: 'crud_test_id',
    title: 'Original',
    userId: 'u',
  });

  // Update
  const update = await http('PATCH', `${B()}/records/crud_test_id`, {
    title: 'Updated',
  });
  assert.equal(update.status, 200);
  assert.equal(update.data.record.title, 'Updated');

  // Delete
  const del = await http('DELETE', `${B()}/records/crud_test_id`);
  assert.equal(del.status, 200);

  // Sudah terhapus
  const get = await http('GET', `${B()}/records/crud_test_id`);
  assert.equal(get.status, 404);
});

// ─── 8. `id` bukan field skema → tidak divalidasi sebagai field ─────────────

test('id di body tidak divalidasi sebagai field skema (bukan error "field does not exist")', async () => {
  const create = await http('POST', `${B()}/records`, {
    id: 'field_test_id',
    title: 'Valid',
    userId: 'u',
  });
  // Kalau `id` divalidasi sebagai field, akan 400 "Field 'id' does not exist"
  // Tapi harusnya 201 karena id di-extract sebelum validasi field
  assert.equal(create.status, 201, JSON.stringify(create.data));
  assert.equal(create.data.record.id, 'field_test_id');
});
