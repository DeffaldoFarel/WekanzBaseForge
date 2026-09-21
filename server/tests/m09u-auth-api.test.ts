// ============================================================================
// M09u: TEST AUTH API (HTTP INTEGRATION)
//
// Menggunakan router sungguhan dengan HTTP request sungguhan (node:http
// client) — bukan mock. Membuktikan seluruh alur: register → login →
// me → refresh → logout, plus rate limiting.
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

// ─── Test server sungguhan ──────────────────────────────────────────────────

let server: nodeHttp.Server;
let baseURL = '';
const TEST_DATA_DIR = path.resolve('../data/m09u-test');

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

// ─── HTTP helpers ────────────────────────────────────────────────────────────

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
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          // biarkan text
        }
        resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
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

// ─── Setup: admin token + project ────────────────────────────────────────────

test('M09u setup: admin login + buat project', async () => {
  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@test.local',
    password: 'admin-test-pass',
  });
  assert.equal(login.status, 200);
  adminToken = login.body.token;

  const project = await http('POST', '/api/admin/projects', { name: 'authapp' }, adminToken);
  assert.equal(project.status, 201);
  projectId = project.body.project.id;

  console.log('\n   🏗️  Project untuk auth API:', projectId);
});

// ════════════════════════════════════════════════════════════════════════════
// REGISTER
// ════════════════════════════════════════════════════════════════════════════

test('M09u: register → user + tokens (auto-login)', async () => {
  await resetAllRateLimits();
  const res = await http('POST', `/api/p/${projectId}/auth/register`, {
    email: 'farel@x.com',
    password: 'passwordRahasia123',
    name: 'Farel',
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.user.email, 'farel@x.com');
  assert.ok(res.body.accessToken);
  assert.ok(res.body.refreshToken);
  assert.ok(!JSON.stringify(res.body).includes('scrypt:'), 'hash tidak boleh bocor!');

  console.log('\n   ✅ Register:', res.body.user.email, '+ tokens diterima');
});

test('M09u: register email duplikat → 409', async () => {
  const res = await http('POST', `/api/p/${projectId}/auth/register`, {
    email: 'farel@x.com',
    password: 'passwordLain456',
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error.message, /already registered/);
});

test('M09u: register password lemah → 400', async () => {
  const res = await http('POST', `/api/p/${projectId}/auth/register`, {
    email: 'baru@x.com',
    password: 'pendek',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /at least 8/);
});

// ════════════════════════════════════════════════════════════════════════════
// LOGIN
// ════════════════════════════════════════════════════════════════════════════

test('M09u: login benar → user + tokens', async () => {
  await resetAllRateLimits();
  const res = await http('POST', `/api/p/${projectId}/auth/login`, {
    email: 'farel@x.com',
    password: 'passwordRahasia123',
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, 'farel@x.com');
  assert.ok(res.body.accessToken);
  assert.ok(res.body.refreshToken);
});

test('M09u: login password salah → 401 dengan pesan SERAGAM', async () => {
  const res = await http('POST', `/api/p/${projectId}/auth/login`, {
    email: 'farel@x.com',
    password: 'passwordSalah999',
  });
  assert.equal(res.status, 401);
  assert.match(res.body.error.message, /Invalid email or password/);

  // Email tidak terdaftar → PESAN SAMA (anti user enumeration!)
  const res2 = await http('POST', `/api/p/${projectId}/auth/login`, {
    email: 'hantu@x.com',
    password: 'passwordRahasia123',
  });
  assert.equal(res2.status, 401);
  assert.equal(res2.body.error.message, res.body.error.message, 'pesan harus identik!');

  console.log('\n   🛡️  Pesan seragam:', res.body.error.message);
});

// ════════════════════════════════════════════════════════════════════════════
// ME (JWT-protected)
// ════════════════════════════════════════════════════════════════════════════

test('M09u: /me dengan access token → identitas user', async () => {
  const login = await http('POST', `/api/p/${projectId}/auth/login`, {
    email: 'farel@x.com',
    password: 'passwordRahasia123',
  });

  const me = await http('GET', `/api/p/${projectId}/auth/me`, undefined, login.body.accessToken);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'farel@x.com');

  console.log('\n   👤 /me:', me.body.user.email);
});

test('M09u: /me tanpa token → 401', async () => {
  const me = await http('GET', `/api/p/${projectId}/auth/me`);
  assert.equal(me.status, 401);
});

test('M09u: /me dengan token palsu → 401', async () => {
  const forged = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJoYWNrZXIifQ.palsu';
  const me = await http('GET', `/api/p/${projectId}/auth/me`, undefined, forged);
  assert.equal(me.status, 401);
});

// ════════════════════════════════════════════════════════════════════════════
// REFRESH
// ════════════════════════════════════════════════════════════════════════════

test('M09u: refresh → access baru valid', async () => {
  const login = await http('POST', `/api/p/${projectId}/auth/login`, {
    email: 'farel@x.com',
    password: 'passwordRahasia123',
  });

  const refresh = await http('POST', `/api/p/${projectId}/auth/refresh`, {
    refreshToken: login.body.refreshToken,
  });

  assert.equal(refresh.status, 200);
  assert.ok(refresh.body.accessToken);

  // Access baru harus bisa dipakai untuk /me
  const me = await http('GET', `/api/p/${projectId}/auth/me`, undefined, refresh.body.accessToken);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'farel@x.com');

  console.log('\n   🔄 Refresh → access baru valid untuk /me');
});

// ════════════════════════════════════════════════════════════════════════════
// LOGOUT
// ════════════════════════════════════════════════════════════════════════════

test('M09u: logout → refresh token mati', async () => {
  const login = await http('POST', `/api/p/${projectId}/auth/login`, {
    email: 'farel@x.com',
    password: 'passwordRahasia123',
  });

  const logout = await http('POST', `/api/p/${projectId}/auth/logout`, {
    refreshToken: login.body.refreshToken,
  });
  assert.equal(logout.status, 200);

  // Setelah logout, refresh tidak bisa dipakai lagi
  const refresh = await http('POST', `/api/p/${projectId}/auth/refresh`, {
    refreshToken: login.body.refreshToken,
  });
  assert.equal(refresh.status, 401);
  console.log('\n   🚪 Logout: refresh token mati ✓');
});

// ════════════════════════════════════════════════════════════════════════════
// RATE LIMITING
// ════════════════════════════════════════════════════════════════════════════

test('M09u: RATE LIMIT — 11 percobaan login dalam 1 menit → 429', async () => {
  await resetAllRateLimits();

  // 10 percobaan pertama: boleh (semuanya gagal karena password salah, tapi bukan 429)
  for (let i = 0; i < 10; i++) {
    const res = await http('POST', `/api/p/${projectId}/auth/login`, {
      email: 'brute@x.com',
      password: `coba-ke-${i}`,
    });
    assert.notEqual(res.status, 429, `percobaan ke-${i + 1} tidak boleh 429`);
  }

  // Percobaan ke-11: DITOLAK dengan 429
  const res11 = await http('POST', `/api/p/${projectId}/auth/login`, {
    email: 'brute@x.com',
    password: 'coba-ke-11',
  });
  assert.equal(res11.status, 429);
  assert.match(res11.body.error.message, /Too many/);
  assert.ok(res11.headers['retry-after'], 'harus ada header Retry-After');

  console.log('\n   🚦 Rate limit: percobaan ke-11 → 429, Retry-After =',
    res11.headers['retry-after']);

  await resetAllRateLimits(); // bersihkan untuk test lain
});

test('M09u: endpoint auth project lain terpisah (isolasi data)', async () => {
  await resetAllRateLimits();

  // Buat project kedua
  const p2 = await http('POST', '/api/admin/projects', { name: 'authapp2' }, adminToken);
  assert.equal(p2.status, 201);
  const pid2 = p2.body.project.id;

  // Register user di project 1
  await http('POST', `/api/p/${projectId}/auth/register`, {
    email: 'isolasi@x.com',
    password: 'passwordRahasia123',
  });

  // Login user yang sama di project 2 → HARUS GAGAL (user tidak ada di sana)
  const login = await http('POST', `/api/p/${pid2}/auth/login`, {
    email: 'isolasi@x.com',
    password: 'passwordRahasia123',
  });
  assert.equal(login.status, 401, 'user project 1 tidak otomatis ada di project 2');

  console.log('\n   🔒 Isolasi: user project A tidak bisa login di project B ✓');
});
