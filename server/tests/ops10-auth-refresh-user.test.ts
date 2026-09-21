// ============================================================================
// Ops-10: POST /api/p/:pid/auth/refresh mengembalikan `user`
//
// Paritas dengan auth-collection `auth-refresh` yang mengembalikan `record`.
// Tanpa ini, klien yang bermigrasi dari surface B ke surface A kehilangan
// identitas user saat refresh dan harus memanggil GET /auth/me sebagai
// round-trip kedua.
//
// Tambahan FIELD (bukan perubahan bentuk), jadi backward-compatible.
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
const TEST_DATA_DIR = path.resolve('../data/ops10-test');

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
let refreshToken = '';
let userId = '';

test('Ops-10 setup: admin login + project + register user', async () => {
  await resetAllRateLimits();

  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@test.local',
    password: 'admin-test-pass',
  });
  assert.equal(login.status, 200);
  adminToken = login.body.token;

  const project = await http('POST', '/api/admin/projects', { name: 'ops10app' }, adminToken);
  assert.equal(project.status, 201);
  projectId = project.body.project.id;

  const reg = await http('POST', `/api/p/${projectId}/auth/register`, {
    email: 'ops10@x.com',
    password: 'passwordRahasia123',
    name: 'User Ops10',
  });
  assert.equal(reg.status, 201);
  refreshToken = reg.body.refreshToken;
  userId = reg.body.user.id;
  assert.ok(refreshToken);
});

test('Ops-10: /auth/refresh mengembalikan user lengkap', async () => {
  const res = await http('POST', `/api/p/${projectId}/auth/refresh`, { refreshToken });

  assert.equal(res.status, 200);

  // Field lama harus tetap ada (backward-compat).
  assert.ok(res.body.accessToken, 'accessToken wajib tetap ada');
  assert.ok(res.body.refreshToken, 'refreshToken wajib tetap ada');
  assert.equal(typeof res.body.expiresIn, 'number');

  // Field baru.
  assert.ok(res.body.user, 'user wajib ada (Ops-10)');
  assert.equal(res.body.user.id, userId);
  assert.equal(res.body.user.email, 'ops10@x.com');
  assert.equal(res.body.user.name, 'User Ops10');
  assert.equal(res.body.user.verified, false);
  assert.equal(typeof res.body.user.mfaEnabled, 'boolean');

  refreshToken = res.body.refreshToken;
});

test('Ops-10: user hasil refresh identik dengan GET /auth/me', async () => {
  const ref = await http('POST', `/api/p/${projectId}/auth/refresh`, { refreshToken });
  assert.equal(ref.status, 200);

  const me = await http('GET', `/api/p/${projectId}/auth/me`, undefined, ref.body.accessToken);
  assert.equal(me.status, 200);

  assert.deepEqual(
    ref.body.user,
    me.body.user,
    'bentuk user dari refresh harus identik dengan /auth/me — klien tidak perlu round-trip kedua'
  );

  refreshToken = ref.body.refreshToken;
});

test('Ops-10: profil terbaru ikut terbawa (bukan cache token lama)', async () => {
  const ref1 = await http('POST', `/api/p/${projectId}/auth/refresh`, { refreshToken });
  assert.equal(ref1.status, 200);

  // Ubah profil lewat Ops-9, lalu refresh lagi.
  const patch = await http(
    'PATCH',
    `/api/p/${projectId}/auth/me`,
    { name: 'Nama Diperbarui' },
    ref1.body.accessToken
  );
  assert.equal(patch.status, 200);

  const ref2 = await http('POST', `/api/p/${projectId}/auth/refresh`, { refreshToken: ref1.body.refreshToken });
  assert.equal(ref2.status, 200);
  assert.equal(ref2.body.user.name, 'Nama Diperbarui', 'refresh harus baca DB, bukan payload token lama');

  refreshToken = ref2.body.refreshToken;
});

test('Ops-10: refresh token invalid tetap 401 (tanpa user)', async () => {
  const res = await http('POST', `/api/p/${projectId}/auth/refresh`, { refreshToken: 'ngawur-tidak-ada' });

  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'INVALID_REFRESH');
  assert.equal(res.body.user, undefined, 'jangan bocorkan user pada kegagalan');
});

test('Ops-10: refresh token yang sudah di-logout ditolak 401', async () => {
  const ref = await http('POST', `/api/p/${projectId}/auth/refresh`, { refreshToken });
  assert.equal(ref.status, 200);
  const rt = ref.body.refreshToken;

  const out = await http('POST', `/api/p/${projectId}/auth/logout`, { refreshToken: rt });
  assert.equal(out.status, 200);

  const after = await http('POST', `/api/p/${projectId}/auth/refresh`, { refreshToken: rt });
  assert.equal(after.status, 401, 'token yang sudah di-revoke tidak boleh hidup lagi');
});
