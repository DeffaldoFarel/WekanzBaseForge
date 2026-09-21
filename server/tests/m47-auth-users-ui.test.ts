// ============================================================================
// M47: HALAMAN AUTH USERS — endpoint admin untuk mengelola _auth_users internal
//
// Sebelum M47: auth users internal tidak bisa dicek/dikelola dari dashboard;
// hanya ada Auth Settings (OAuth). Verifikasi user harus lewat API/script.
// Sekarang: endpoint admin lengkap + halaman UI di dashboard.
// ============================================================================

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert';
import nodeHttp from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { Router } from '../src/core/router.js';
import { initPlatformDb, closePlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs, getProjectDb } from '../src/core/projectDbManager.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createUserAdminRouter } from '../src/api/userAdminRoutes.js';
import { createProject, provisionProjectStorage } from '../src/core/platformDb.js';
import { createAuthUser, verifyAuthCredentials, initAuthUsersTable } from '../src/auth/users.js';

const TEST_DATA_DIR = path.resolve('../data/m47-test');
const ADMIN_EMAIL = 'm47@test.local';
const ADMIN_PASSWORD = 'm47-password-123';

let server: nodeHttp.Server;
let baseURL: string;
let adminToken = '';
let projectId = '';
let testUserId = '';

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
        let raw = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let data: any = null;
          try {
            data = JSON.parse(raw);
          } catch {
            data = raw;
          }
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
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.JWT_SECRET = 'm47-test-secret';

  initPlatformDb();
  // ID unik per run — full suite bisa menjalankan file test lebih dari sekali
  const proj = createProject(`m47proj${Date.now().toString(36)}`, 'm47-project', { database: true, auth: true, storage: true, functions: true });
  projectId = proj.id;
  provisionProjectStorage(projectId);

  // Buat auth user untuk diuji
  const db = getProjectDb(projectId);
  initAuthUsersTable(db);
  const user = createAuthUser(db, {
    email: 'm47-user@test.local',
    password: 'user-password-123',
    name: 'M47 Test User',
  });
  testUserId = user.id;

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createUserAdminRouter());

  server = nodeHttp.createServer((req, res) => router.handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseURL = `http://127.0.0.1:${port}`;

  const login = await http('POST', '/api/admin/auth/login', {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  assert.equal(login.status, 200);
  adminToken = login.data.token;
});

after(() => {
  closeAllProjectDbs();
  // Windows: rmSync gagal EPERM selama handle platform.db masih terbuka.
  closePlatformDb();
  server?.close();
  setTimeout(() => {
    try {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }, 100);
});

describe('M47: Auth Users admin endpoints', () => {
  test('GET /auth-users → 200 dengan items + totalItems', async () => {
    const res = await http('GET', `/api/admin/projects/${projectId}/auth-users`, undefined, adminToken);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.items), 'items harus array');
    assert.ok(typeof res.data.totalItems === 'number', 'totalItems harus number');
    assert.ok(res.data.totalItems >= 1, 'harus ada minimal 1 user');
  });

  test('GET /auth-users?search= → filter bekerja', async () => {
    const res = await http(
      'GET',
      `/api/admin/projects/${projectId}/auth-users?search=m47-user`,
      undefined,
      adminToken
    );
    assert.equal(res.status, 200);
    assert.ok(res.data.items.length >= 1, 'harus menemukan user');
    assert.ok(
      res.data.items.some((u: any) => u.email === 'm47-user@test.local'),
      'email harus cocok'
    );
  });

  test('GET /auth-users/:uid → detail user (tanpa password_hash)', async () => {
    const res = await http(
      'GET',
      `/api/admin/projects/${projectId}/auth-users/${testUserId}`,
      undefined,
      adminToken
    );
    assert.equal(res.status, 200);
    assert.equal(res.data.user.id, testUserId);
    assert.equal(res.data.user.email, 'm47-user@test.local');
    assert.ok(!('password_hash' in res.data.user), 'password_hash tidak boleh bocor');
  });

  test('POST /:uid/verify → user terverifikasi', async () => {
    const res = await http(
      'POST',
      `/api/admin/projects/${projectId}/auth-users/${testUserId}/verify`,
      { verified: true },
      adminToken
    );
    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);
    assert.equal(res.data.verified, true);

    // Verifikasi dari DB
    const db = getProjectDb(projectId);
    const row = db.prepare('SELECT verified FROM _auth_users WHERE id = ?').get(testUserId) as { verified: number };
    assert.equal(row.verified, 1);
  });

  // Ops-15: nama test ini dulu menjanjikan "login ditolak" padahal isinya hanya
  // memeriksa kolom — lubangnya baru ketahuan saat audit auth. Penegakan login
  // sekarang diuji sungguhan di tests/ops15-disabled-enforcement.test.ts.
  test('POST /:uid/disable → kolom disabled ter-set + sesi di-revoke', async () => {
    // Disable user
    const res = await http(
      'POST',
      `/api/admin/projects/${projectId}/auth-users/${testUserId}/disable`,
      { disabled: true },
      adminToken
    );
    assert.equal(res.status, 200);
    assert.equal(res.data.disabled, true);

    // Verifikasi dari DB
    const db = getProjectDb(projectId);
    const row = db.prepare('SELECT disabled FROM _auth_users WHERE id = ?').get(testUserId) as { disabled: number };
    assert.equal(row.disabled, 1);

    // Ops-15: respons kini melaporkan berapa sesi yang diputus. User ini dibuat
    // lewat admin dan belum pernah login, jadi 0 — yang penting endpoint tidak
    // gagal saat tabel _auth_tokens belum pernah dibuat (dulu → 400).
    assert.equal(res.data.revokedSessions, 0);
  });

  test('POST /:uid/disable dengan disabled=false → user enabled kembali', async () => {
    const res = await http(
      'POST',
      `/api/admin/projects/${projectId}/auth-users/${testUserId}/disable`,
      { disabled: false },
      adminToken
    );
    assert.equal(res.status, 200);
    assert.equal(res.data.disabled, false);

    const db = getProjectDb(projectId);
    const row = db.prepare('SELECT disabled FROM _auth_users WHERE id = ?').get(testUserId) as { disabled: number };
    assert.equal(row.disabled, 0);
  });

  test('POST /:uid/verify untuk user hantu → 404', async () => {
    const res = await http(
      'POST',
      `/api/admin/projects/${projectId}/auth-users/ghost-id-123/verify`,
      { verified: true },
      adminToken
    );
    assert.equal(res.status, 404);
  });

  test('tanpa admin token → 401/403', async () => {
    const res = await http('GET', `/api/admin/projects/${projectId}/auth-users`);
    assert.ok(res.status === 401 || res.status === 403, `harus 401/403, dapat ${res.status}`);
  });
});
