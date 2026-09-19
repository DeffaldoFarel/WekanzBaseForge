// ============================================================================
// Ops-12 (Tahap 4): endpoint auth-collection DIHAPUS
//
// Menggantikan ops11-auth-collection-deprecation.test.ts, yang membuktikan
// endpoint tersebut masih hidup selama masa deprecation. Sekarang kontraknya
// terbalik: endpointnya harus BENAR-BENAR hilang, sementara segala sesuatu di
// sekitarnya — CRUD record collection auth, platform auth, token yang sudah
// terbit — tetap utuh.
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import nodeHttp from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { initPlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';
import { createPublicRouter } from '../src/api/publicRoutes.js';
import { createProjectAuthRouter } from '../src/api/authRoutes.js';
import { Router } from '../src/core/router.js';
import { resetAllRateLimits } from '../src/auth/rateLimiter.js';

let server: nodeHttp.Server;
let baseURL = '';
const TEST_DATA_DIR = path.resolve('../data/ops12-test');

before(async () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  process.env.DATA_DIR = TEST_DATA_DIR;
  process.env.ADMIN_EMAIL = 'admin@test.local';
  process.env.ADMIN_PASSWORD = 'admin-test-pass';

  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());
  router.merge(createPublicRouter());
  router.merge(createProjectAuthRouter());

  server = nodeHttp.createServer((req, res) => {
    router.handle(req, res);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      baseURL = `http://localhost:${addr.port}`;
      resolve();
    });
  });
});

after(async () => {
  closeAllProjectDbs();
  server.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

interface HttpResult {
  status: number;
  body: any;
  headers: Record<string, string | string[] | undefined>;
}

async function http(method: string, reqPath: string, body?: unknown, token?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, baseURL);
    const req = nodeHttp.request(url, { method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          // biarkan mentah
        }
        resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (token) req.setHeader('Authorization', `Bearer ${token}`);
    if (body !== undefined) {
      req.setHeader('Content-Type', 'application/json');
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

let adminToken = '';
let projectId = '';
const COLL = 'ops12_users';

test('Ops-12 setup: project + collection type=auth + satu record', async () => {
  await resetAllRateLimits();

  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@test.local',
    password: 'admin-test-pass',
  });
  assert.equal(login.status, 200);
  adminToken = login.body.token;

  const project = await http('POST', '/api/admin/projects', { name: 'ops12app' }, adminToken);
  assert.equal(project.status, 201);
  projectId = project.body.project.id;

  const coll = await http(
    'POST',
    `/api/admin/projects/${projectId}/collections`,
    { name: COLL, type: 'auth', fields: [{ name: 'name', type: 'text' }] },
    adminToken
  );
  assert.equal(coll.status, 201);

  const rec = await http(
    'POST',
    `/api/p/${projectId}/collections/${COLL}/records`,
    { email: 'ops12@x.com', password: 'passwordRahasia123', name: 'User Ops12' },
    adminToken
  );
  assert.equal(rec.status, 201);
});

test('Ops-12: auth-with-password sudah TIDAK ADA (404)', async () => {
  const res = await http('POST', `/api/p/${projectId}/collections/${COLL}/auth-with-password`, {
    identity: 'ops12@x.com',
    password: 'passwordRahasia123',
  });

  assert.equal(res.status, 404, 'route harus benar-benar hilang, bukan sekadar menolak');
  assert.equal(res.headers['deprecation'], undefined, 'tidak ada lagi yang perlu ditandai usang');
});

test('Ops-12: auth-refresh sudah TIDAK ADA (404)', async () => {
  const res = await http('POST', `/api/p/${projectId}/collections/${COLL}/auth-refresh`, {
    refreshToken: 'apa-saja',
  });
  assert.equal(res.status, 404);
});

test('Ops-12: auth-logout sudah TIDAK ADA (404)', async () => {
  const res = await http('POST', `/api/p/${projectId}/collections/${COLL}/auth-logout`, {
    refreshToken: 'apa-saja',
  });
  assert.equal(res.status, 404);
});

test('Ops-12: collection type=auth tetap boleh dibuat dan CRUD-nya utuh', async () => {
  // Yang dihapus adalah jalur LOGIN lewat collection, bukan tipe collection-nya.
  // Data pengguna yang sudah ada tidak boleh jadi tidak terjangkau.
  const list = await http('GET', `/api/p/${projectId}/collections/${COLL}/records`, undefined, adminToken);
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].email, 'ops12@x.com');

  const created = await http(
    'POST',
    `/api/p/${projectId}/collections/${COLL}/records`,
    { email: 'ops12-baru@x.com', password: 'passwordRahasia123', name: 'Baru' },
    adminToken
  );
  assert.equal(created.status, 201, 'tetap bisa menambah record');

  const patched = await http(
    'PATCH',
    `/api/p/${projectId}/collections/${COLL}/records/${created.body.record.id}`,
    { name: 'Diubah' },
    adminToken
  );
  assert.equal(patched.status, 200);
  assert.equal(patched.body.record.name, 'Diubah');
});

test('Ops-12: password_hash tidak pernah bocor lewat CRUD', async () => {
  const list = await http('GET', `/api/p/${projectId}/collections/${COLL}/records`, undefined, adminToken);
  assert.equal(list.status, 200);
  for (const item of list.body.items) {
    assert.equal(item.password_hash, undefined, 'hash password tidak boleh ikut terkirim');
    assert.equal(item.password, undefined);
  }
});

test('Ops-12: collection type=auth TIDAK di-flip ke base (password_hash akan bocor)', async () => {
  // Rencana awal Tahap 4 termasuk mengubah collection sisa `type='auth'` menjadi
  // `type='base'`. Itu DIBATALKAN: penyaring `password_hash` di records.ts
  // bergantung pada `meta.type === 'auth'`, sedangkan kolomnya tetap ada di tabel.
  // Flip = hash password ikut terkirim ke klien. Test ini mengunci keputusan itu.
  const coll = await http(
    'GET',
    `/api/admin/projects/${projectId}/collections`,
    undefined,
    adminToken
  );
  assert.equal(coll.status, 200);

  const target = coll.body.collections.find((c: { name: string }) => c.name === COLL);
  assert.ok(target, 'collection harus masih ada');
  assert.equal(target.type, 'auth', 'jangan flip ke base — penyaring password_hash ikut mati');
});

test('Ops-12: platform auth adalah SATU-SATUNYA jalur login dan tetap utuh', async () => {
  const reg = await http('POST', `/api/p/${projectId}/auth/register`, {
    email: 'ops12-platform@x.com',
    password: 'passwordRahasia123',
    name: 'Platform Ops12',
  });
  assert.equal(reg.status, 201);

  const login = await http('POST', `/api/p/${projectId}/auth/login`, {
    email: 'ops12-platform@x.com',
    password: 'passwordRahasia123',
  });
  assert.equal(login.status, 200);
  assert.ok(login.body.accessToken);

  // refresh (Ops-10: membawa user)
  const refreshed = await http('POST', `/api/p/${projectId}/auth/refresh`, {
    refreshToken: login.body.refreshToken,
  });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.user.email, 'ops12-platform@x.com');

  // profil sendiri (Ops-9)
  const patched = await http(
    'PATCH',
    `/api/p/${projectId}/auth/me`,
    { name: 'Nama Baru' },
    refreshed.body.accessToken
  );
  assert.equal(patched.status, 200);
  assert.equal(patched.body.user.name, 'Nama Baru');

  const out = await http('POST', `/api/p/${projectId}/auth/logout`, {
    refreshToken: refreshed.body.refreshToken,
  });
  assert.equal(out.status, 200);
});

test('Ops-12: token yang sudah terbit dari surface lama tetap sah', async () => {
  // Kedua surface memakai issueTokens()/_auth_tokens/verifyToken() yang sama,
  // jadi menghapus route TIDAK boleh mematikan sesi yang sudah berjalan.
  const login = await http('POST', `/api/p/${projectId}/auth/login`, {
    email: 'ops12-platform@x.com',
    password: 'passwordRahasia123',
  });
  assert.equal(login.status, 200);

  const me = await http('GET', `/api/p/${projectId}/auth/me`, undefined, login.body.accessToken);
  assert.equal(me.status, 200, 'akses token tetap diverifikasi oleh mesin yang sama');
});
