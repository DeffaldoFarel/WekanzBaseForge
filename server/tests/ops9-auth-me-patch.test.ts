// ============================================================================
// Ops-9: PATCH /api/p/:pid/auth/me — update profil sendiri (surface A)
//
// Konteks: konsolidasi 2 auth surface menjadi SATU (surface A `_auth_users`).
// Surface B (auth collection) bisa update profil lewat PATCH record biasa;
// tanpa endpoint ini, konsumen yang bermigrasi ke surface A akan KEHILANGAN
// kemampuan. Aturan user: kekurangan BaseForge diperbaiki di BACKEND, bukan
// dengan memaksa frontend menerima lebih sedikit.
//
// HTTP integration dengan server node:http sungguhan — bukan mock.
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import nodeHttp from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { initPlatformDb, closePlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';
import { createProjectAuthRouter } from '../src/api/authRoutes.js';
import { Router } from '../src/core/router.js';
import { resetAllRateLimits } from '../src/auth/rateLimiter.js';

let server: nodeHttp.Server;
let baseURL = '';
const TEST_DATA_DIR = path.resolve('../data/ops9-test');

before(async () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  process.env.DATA_DIR = TEST_DATA_DIR;
  process.env.ADMIN_EMAIL = 'admin@test.local';
  process.env.ADMIN_PASSWORD = 'admin-test-pass';

  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());
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
  // Windows: rmSync gagal EPERM selama handle platform.db masih terbuka.
  closePlatformDb();
  server.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

interface HttpResult {
  status: number;
  body: any;
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
          // biarkan text mentah
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
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
let userToken = '';
let userId = '';

test('Ops-9 setup: admin login + project + register user', async () => {
  await resetAllRateLimits();

  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@test.local',
    password: 'admin-test-pass',
  });
  assert.equal(login.status, 200);
  adminToken = login.body.token;

  const project = await http('POST', '/api/admin/projects', { name: 'ops9app' }, adminToken);
  assert.equal(project.status, 201);
  projectId = project.body.project.id;

  const reg = await http('POST', `/api/p/${projectId}/auth/register`, {
    email: 'ops9@x.com',
    password: 'passwordRahasia123',
    name: 'Nama Awal',
  });
  assert.equal(reg.status, 201);
  userToken = reg.body.accessToken;
  userId = reg.body.user.id;
  assert.ok(userId);
});

// ════════════════════════════════════════════════════════════════════════════
// JALUR SUKSES
// ════════════════════════════════════════════════════════════════════════════

test('Ops-9: PATCH /auth/me mengubah name dan persist di GET /auth/me', async () => {
  const res = await http('PATCH', `/api/p/${projectId}/auth/me`, { name: 'Nama Baru' }, userToken);

  assert.equal(res.status, 200);
  assert.equal(res.body.user.name, 'Nama Baru');
  assert.equal(res.body.user.id, userId, 'id tidak boleh berubah');
  assert.equal(res.body.user.email, 'ops9@x.com', 'email tidak boleh berubah');

  // Bukti PERSIST, bukan sekadar echo response.
  const me = await http('GET', `/api/p/${projectId}/auth/me`, undefined, userToken);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.name, 'Nama Baru');
});

test('Ops-9: PATCH /auth/me mengubah avatarUrl', async () => {
  const res = await http(
    'PATCH',
    `/api/p/${projectId}/auth/me`,
    { avatarUrl: 'https://cdn.example.com/a.png' },
    userToken
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.user.avatarUrl, 'https://cdn.example.com/a.png');

  const me = await http('GET', `/api/p/${projectId}/auth/me`, undefined, userToken);
  assert.equal(me.body.user.avatarUrl, 'https://cdn.example.com/a.png');
  assert.equal(me.body.user.name, 'Nama Baru', 'partial update tidak boleh menghapus field lain');
});

test('Ops-9: partial update — field yang tidak dikirim TIDAK tersentuh', async () => {
  const res = await http('PATCH', `/api/p/${projectId}/auth/me`, { name: 'Nama Ketiga' }, userToken);

  assert.equal(res.status, 200);
  assert.equal(res.body.user.name, 'Nama Ketiga');
  assert.equal(
    res.body.user.avatarUrl,
    'https://cdn.example.com/a.png',
    'avatarUrl harus bertahan karena tidak dikirim'
  );
});

test('Ops-9: null secara eksplisit MENGOSONGKAN field', async () => {
  const res = await http('PATCH', `/api/p/${projectId}/auth/me`, { avatarUrl: null }, userToken);

  assert.equal(res.status, 200);
  assert.equal(res.body.user.avatarUrl, null);

  const me = await http('GET', `/api/p/${projectId}/auth/me`, undefined, userToken);
  assert.equal(me.body.user.avatarUrl, null);
});

test('Ops-9: body kosong = no-op idempotent (200, state utuh)', async () => {
  const res = await http('PATCH', `/api/p/${projectId}/auth/me`, {}, userToken);

  assert.equal(res.status, 200);
  assert.equal(res.body.user.name, 'Nama Ketiga');
});

// ════════════════════════════════════════════════════════════════════════════
// KEAMANAN — field sensitif tidak boleh lewat jalur ini
// ════════════════════════════════════════════════════════════════════════════

test('Ops-9: email DITOLAK 400 (punya jalur terverifikasi sendiri)', async () => {
  const res = await http('PATCH', `/api/p/${projectId}/auth/me`, { email: 'jahat@x.com' }, userToken);

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'BAD_REQUEST');

  // Bukti email benar-benar TIDAK berubah — bukan sekadar status code.
  const me = await http('GET', `/api/p/${projectId}/auth/me`, undefined, userToken);
  assert.equal(me.body.user.email, 'ops9@x.com');
});

test('Ops-9: password DITOLAK 400', async () => {
  const res = await http('PATCH', `/api/p/${projectId}/auth/me`, { password: 'bobol123' }, userToken);
  assert.equal(res.status, 400);

  // Password lama masih berlaku → bukti tidak tertimpa.
  await resetAllRateLimits();
  const login = await http('POST', `/api/p/${projectId}/auth/login`, {
    email: 'ops9@x.com',
    password: 'passwordRahasia123',
  });
  assert.equal(login.status, 200, 'password lama harus tetap berlaku');
});

test('Ops-9: verified DITOLAK 400 (privilege escalation)', async () => {
  const res = await http('PATCH', `/api/p/${projectId}/auth/me`, { verified: true }, userToken);
  assert.equal(res.status, 400);

  const me = await http('GET', `/api/p/${projectId}/auth/me`, undefined, userToken);
  assert.equal(me.body.user.verified, false, 'verified tidak boleh naik sendiri');
});

test('Ops-9: disabled dan id DITOLAK 400', async () => {
  const dis = await http('PATCH', `/api/p/${projectId}/auth/me`, { disabled: true }, userToken);
  assert.equal(dis.status, 400);

  const idRes = await http('PATCH', `/api/p/${projectId}/auth/me`, { id: 'idpalsu123' }, userToken);
  assert.equal(idRes.status, 400);

  const me = await http('GET', `/api/p/${projectId}/auth/me`, undefined, userToken);
  assert.equal(me.body.user.id, userId, 'id harus tetap sama');
});

// ════════════════════════════════════════════════════════════════════════════
// AUTENTIKASI & VALIDASI
// ════════════════════════════════════════════════════════════════════════════

test('Ops-9: tanpa token → 401', async () => {
  const res = await http('PATCH', `/api/p/${projectId}/auth/me`, { name: 'Anonim' });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'UNAUTHORIZED');
});

test('Ops-9: token invalid → 401 (bukan diam-diam anonim)', async () => {
  const res = await http('PATCH', `/api/p/${projectId}/auth/me`, { name: 'Palsu' }, 'token.ngawur.xyz');
  assert.equal(res.status, 401);
});

test('Ops-9: tipe salah → 400', async () => {
  const num = await http('PATCH', `/api/p/${projectId}/auth/me`, { name: 12345 }, userToken);
  assert.equal(num.status, 400);

  const obj = await http('PATCH', `/api/p/${projectId}/auth/me`, { avatarUrl: { a: 1 } }, userToken);
  assert.equal(obj.status, 400);
});

test('Ops-9: name melebihi 255 karakter → 400', async () => {
  const res = await http('PATCH', `/api/p/${projectId}/auth/me`, { name: 'x'.repeat(256) }, userToken);
  assert.equal(res.status, 400);
});

test('Ops-9: project tidak dikenal → 404', async () => {
  const res = await http('PATCH', '/api/p/tidakadaproject/auth/me', { name: 'X' }, userToken);
  assert.equal(res.status, 404);
});

// ════════════════════════════════════════════════════════════════════════════
// ISOLASI ANTAR USER — token menentukan SIAPA yang diubah
// ════════════════════════════════════════════════════════════════════════════

test('Ops-9: user hanya bisa mengubah dirinya sendiri', async () => {
  await resetAllRateLimits();
  const reg2 = await http('POST', `/api/p/${projectId}/auth/register`, {
    email: 'ops9-lain@x.com',
    password: 'passwordRahasia123',
    name: 'User Lain',
  });
  assert.equal(reg2.status, 201);
  const token2 = reg2.body.accessToken;

  const res = await http('PATCH', `/api/p/${projectId}/auth/me`, { name: 'Diubah User2' }, token2);
  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, 'ops9-lain@x.com');

  // User pertama TIDAK boleh ikut berubah.
  const me1 = await http('GET', `/api/p/${projectId}/auth/me`, undefined, userToken);
  assert.equal(me1.body.user.name, 'Nama Ketiga', 'profil user lain tidak boleh tersentuh');
});
