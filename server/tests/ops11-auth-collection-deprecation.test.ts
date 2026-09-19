// ============================================================================
// Ops-11 (Tahap 3): auth-collection endpoints ditandai DEPRECATED
//
// Inti tahap ini: menandai, BUKAN menghapus. Kontrak yang diuji:
//   1. ketiga endpoint tetap berfungsi PENUH (rollback tersedia)
//   2. setiap respons membawa header Deprecation/Link/Warning
//   3. endpoint pengganti (surface A) tidak ikut tertandai
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
const TEST_DATA_DIR = path.resolve('../data/ops11-test');

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
const COLL = 'ops11_users';

test('Ops-11 setup: project + auth collection + satu user', async () => {
  await resetAllRateLimits();

  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@test.local',
    password: 'admin-test-pass',
  });
  assert.equal(login.status, 200);
  adminToken = login.body.token;

  const project = await http('POST', '/api/admin/projects', { name: 'ops11app' }, adminToken);
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
    { email: 'ops11@x.com', password: 'passwordRahasia123', name: 'User Ops11' },
    adminToken
  );
  assert.equal(rec.status, 201);
});

test('Ops-11: auth-with-password TETAP BERFUNGSI (rollback tersedia)', async () => {
  const res = await http('POST', `/api/p/${projectId}/collections/${COLL}/auth-with-password`, {
    identity: 'ops11@x.com',
    password: 'passwordRahasia123',
  });

  assert.equal(res.status, 200, 'deprecated bukan berarti mati');
  assert.ok(res.body.token, 'token wajib tetap terbit');
  assert.ok(res.body.refreshToken, 'refreshToken wajib tetap terbit');
  assert.equal(res.body.record.email, 'ops11@x.com');
});

test('Ops-11: auth-with-password membawa header deprecation', async () => {
  const res = await http('POST', `/api/p/${projectId}/collections/${COLL}/auth-with-password`, {
    identity: 'ops11@x.com',
    password: 'passwordRahasia123',
  });

  assert.equal(res.headers['deprecation'], 'true');
  assert.match(String(res.headers['link']), /\/auth\/login/);
  assert.match(String(res.headers['warning']), /deprecated/i);
});

test('Ops-11 regresi: auth-refresh jalan untuk auth collection TANPA field `name`', async () => {
  // Collection type=auth hanya menjamin email/password_hash/verified. Handler
  // dulu SELECT kolom `name` secara eksplisit sehingga collection tanpa field
  // itu gagal refresh dengan "no such column: name" — ditemukan saat Tahap 3.
  const coll = await http(
    'POST',
    `/api/admin/projects/${projectId}/collections`,
    { name: 'ops11_noname', type: 'auth', fields: [{ name: 'nickname', type: 'text' }] },
    adminToken
  );
  assert.equal(coll.status, 201);

  const rec = await http(
    'POST',
    `/api/p/${projectId}/collections/ops11_noname/records`,
    { email: 'noname@x.com', password: 'passwordRahasia123', nickname: 'Tanpa Name' },
    adminToken
  );
  assert.equal(rec.status, 201);

  const login = await http('POST', `/api/p/${projectId}/collections/ops11_noname/auth-with-password`, {
    identity: 'noname@x.com',
    password: 'passwordRahasia123',
  });
  assert.equal(login.status, 200, 'login harus jalan tanpa field name');

  const refreshed = await http('POST', `/api/p/${projectId}/collections/ops11_noname/auth-refresh`, {
    refreshToken: login.body.refreshToken,
  });
  assert.equal(refreshed.status, 200, 'refresh tidak boleh gagal hanya karena kolom `name` tidak ada');
  assert.ok(refreshed.body.token);
});

test('Ops-11: auth-refresh tetap berfungsi + tertandai', async () => {
  const login = await http('POST', `/api/p/${projectId}/collections/${COLL}/auth-with-password`, {
    identity: 'ops11@x.com',
    password: 'passwordRahasia123',
  });
  assert.equal(login.status, 200);

  const res = await http('POST', `/api/p/${projectId}/collections/${COLL}/auth-refresh`, {
    refreshToken: login.body.refreshToken,
  });

  assert.equal(res.status, 200, 'refresh wajib tetap jalan selama masa deprecation');
  assert.ok(res.body.token);
  assert.equal(res.headers['deprecation'], 'true');
  assert.match(String(res.headers['link']), /\/auth\/refresh/);
});

test('Ops-11: auth-logout tetap berfungsi + tertandai', async () => {
  const login = await http('POST', `/api/p/${projectId}/collections/${COLL}/auth-with-password`, {
    identity: 'ops11@x.com',
    password: 'passwordRahasia123',
  });
  assert.equal(login.status, 200);

  const res = await http('POST', `/api/p/${projectId}/collections/${COLL}/auth-logout`, {
    refreshToken: login.body.refreshToken,
  });

  assert.equal(res.status, 200);
  assert.equal(res.headers['deprecation'], 'true');
  assert.match(String(res.headers['link']), /\/auth\/logout/);

  // logout harus benar-benar mencabut token, bukan sekadar menandai
  const after = await http('POST', `/api/p/${projectId}/collections/${COLL}/auth-refresh`, {
    refreshToken: login.body.refreshToken,
  });
  assert.notEqual(after.status, 200, 'token yang sudah logout tidak boleh hidup');
});

test('Ops-11: respons GAGAL pun tetap tertandai deprecated', async () => {
  const res = await http('POST', `/api/p/${projectId}/collections/${COLL}/auth-with-password`, {
    identity: 'ops11@x.com',
    password: 'passwordSalah',
  });

  assert.equal(res.status, 400);
  assert.equal(
    res.headers['deprecation'],
    'true',
    'klien yang gagal login juga perlu tahu endpointnya usang'
  );
});

test('Ops-11: surface A (pengganti) TIDAK tertandai deprecated', async () => {
  const reg = await http('POST', `/api/p/${projectId}/auth/register`, {
    email: 'ops11-platform@x.com',
    password: 'passwordRahasia123',
    name: 'Platform User',
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.headers['deprecation'], undefined, 'jangan tandai endpoint yang justru dituju');

  const login = await http('POST', `/api/p/${projectId}/auth/login`, {
    email: 'ops11-platform@x.com',
    password: 'passwordRahasia123',
  });
  assert.equal(login.status, 200);
  assert.equal(login.headers['deprecation'], undefined);
});

test('Ops-11: records CRUD collection auth tidak ikut tertandai', async () => {
  // Hanya endpoint AUTH yang deprecated; collection-nya sendiri masih normal.
  const res = await http('GET', `/api/p/${projectId}/collections/${COLL}/records`, undefined, adminToken);

  assert.equal(res.status, 200);
  assert.equal(res.headers['deprecation'], undefined, 'CRUD record bukan bagian yang dipensiunkan');
});
