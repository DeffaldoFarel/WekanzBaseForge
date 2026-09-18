// ============================================================================
// M39u: TEST FIRST-TIME ADMIN SETUP & DB-BACKED CREDENTIALS
//
// Fokus test:
//  1. GET /api/admin/setup-state pada DB bersih → needsSetup: true, hasAdmin: false
//  2. POST /api/admin/auth/setup validasi email dan password (min 8 chars) → 400
//  3. POST /api/admin/auth/setup sukses → 201 + token + admin info
//  4. GET /api/admin/setup-state setelah setup → needsSetup: false, hasAdmin: true
//  5. POST /api/admin/auth/setup kedua kali → 403 SETUP_COMPLETED (dikunci selamanya)
//  6. POST /api/admin/auth/login dengan akun DB baru → 200 OK
//  7. POST /api/admin/auth/login password salah → 401
//  8. Email login case-insensitive
//  9. Password tersimpan di DB ter-hash dengan scrypt (bukan plaintext)
// 10. Fallback env var tetap berfungsi (kompatibilitas test eksisting)
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import nodeHttp from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { initPlatformDb, closePlatformDb } from '../src/core/platformDb.js';
import { Router } from '../src/core/router.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';

const TEST_DATA_DIR = path.resolve('../data/m39u-admin-setup-test');

let server: nodeHttp.Server;
let baseURL: string;

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
          try {
            data = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
          } catch {}
          resolve({ status: res.statusCode ?? 0, data });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

before(async () => {
  process.env.ADMIN_EMAIL = 'env-fallback@test.local';
  process.env.ADMIN_PASSWORD = 'fallback-pass-123';

  const db = initPlatformDb();
  try {
    // Hapus SEMUA admin, bukan hanya satu email — platform.db bersifat global
    // dan test lain (Ops-5, auth-collection, dst.) membuat admin dengan email
    // berbeda. needsSetup:true mengharuskan tabel benar-benar kosong.
    db.prepare('DELETE FROM _platform_admins').run();
  } catch {}

  const router = new Router();
  router.merge(createAdminRouter());

  server = nodeHttp.createServer((req, res) => router.handle(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((r) => server.close(() => r()));
  }
  try {
    const db = initPlatformDb();
    // Bersihkan semua admin yang dibuat test ini agar tidak mencemari
    // test berikutnya (platform.db global).
    db.prepare('DELETE FROM _platform_admins').run();
  } catch {}
});

test('1. GET /api/admin/setup-state pada awal instalasi mengembalikan needsSetup: true', async () => {
  const res = await http('GET', '/api/admin/setup-state');
  assert.equal(res.status, 200);
  assert.equal(res.data.needsSetup, true);
  assert.equal(res.data.hasAdmin, false);
});

test('2. POST /api/admin/auth/setup validasi email dan password', async () => {
  // Email kosong
  const res1 = await http('POST', '/api/admin/auth/setup', { password: 'Password123' });
  assert.equal(res1.status, 400);

  // Email format salah
  const res2 = await http('POST', '/api/admin/auth/setup', {
    email: 'not-an-email',
    password: 'Password123',
  });
  assert.equal(res2.status, 400);

  // Password terlalu pendek (< 8 chars)
  const res3 = await http('POST', '/api/admin/auth/setup', {
    email: 'valid@example.com',
    password: 'short',
  });
  assert.equal(res3.status, 400);
  assert.match(res3.data.error.message, /8 characters/i);
});

test('3. POST /api/admin/auth/setup membuat admin pertama dan menerbitkan token', async () => {
  const res = await http('POST', '/api/admin/auth/setup', {
    email: 'MasterAdmin@Wekanz.Id',
    password: 'SuperSecretAdminPassword2026',
  });

  assert.equal(res.status, 201);
  assert.ok(res.data.token, 'Token harus diterbitkan');
  assert.equal(res.data.admin.email, 'masteradmin@wekanz.id', 'Email dinormalisasi ke lowercase');
  assert.ok(res.data.admin.id, 'ID admin harus ada');

  // Cek ke /api/admin/auth/me dengan token yang baru diterbitkan
  const me = await http('GET', '/api/admin/auth/me', undefined, res.data.token);
  assert.equal(me.status, 200);
  assert.equal(me.data.admin.email, 'masteradmin@wekanz.id');
});

test('4. GET /api/admin/setup-state setelah setup mengembalikan needsSetup: false', async () => {
  const res = await http('GET', '/api/admin/setup-state');
  assert.equal(res.status, 200);
  assert.equal(res.data.needsSetup, false);
  assert.equal(res.data.hasAdmin, true);
});

test('5. POST /api/admin/auth/setup kedua kali ditolak dengan 403 SETUP_COMPLETED', async () => {
  const res = await http('POST', '/api/admin/auth/setup', {
    email: 'another@example.com',
    password: 'AnotherPassword123',
  });

  assert.equal(res.status, 403);
  assert.equal(res.data.error.code, 'SETUP_COMPLETED');
});

test('6. POST /api/admin/auth/login dengan akun DB baru berhasil', async () => {
  const res = await http('POST', '/api/admin/auth/login', {
    email: 'masteradmin@wekanz.id',
    password: 'SuperSecretAdminPassword2026',
  });

  assert.equal(res.status, 200);
  assert.ok(res.data.token);
  assert.equal(res.data.admin.email, 'masteradmin@wekanz.id');
});

test('7. POST /api/admin/auth/login dengan password salah ditolak', async () => {
  const res = await http('POST', '/api/admin/auth/login', {
    email: 'masteradmin@wekanz.id',
    password: 'WrongPassword!',
  });

  assert.equal(res.status, 401);
});

test('8. POST /api/admin/auth/login case-insensitive untuk email', async () => {
  const res = await http('POST', '/api/admin/auth/login', {
    email: 'MASTERADMIN@WEKANZ.ID',
    password: 'SuperSecretAdminPassword2026',
  });

  assert.equal(res.status, 200);
  assert.ok(res.data.token);
});

test('9. Password admin di SQLite tersimpan ter-hash dengan scrypt (bukan plaintext)', async () => {
  const db = initPlatformDb();
  const row = db.prepare('SELECT email, password_hash FROM _platform_admins WHERE email = ?')
    .get('masteradmin@wekanz.id') as { email: string; password_hash: string } | undefined;

  assert.ok(row, 'Row admin harus ada di _platform_admins');
  assert.notEqual(row.password_hash, 'SuperSecretAdminPassword2026', 'Password TIDAK boleh plaintext');
  assert.ok(row.password_hash.startsWith('scrypt:16384:8:1:'), 'Harus berformat scrypt OWASP');
});

test('10. Fallback env var tetap bekerja untuk email non-DB (kompatibilitas test suite)', async () => {
  const res = await http('POST', '/api/admin/auth/login', {
    email: 'env-fallback@test.local',
    password: 'fallback-pass-123',
  });

  assert.equal(res.status, 200);
  assert.ok(res.data.token);
  assert.equal(res.data.admin.email, 'env-fallback@test.local');
});
