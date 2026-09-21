// ============================================================================
// Ops-15: penegakan flag `disabled` di SELURUH jalur auth
//
// Konteks: M47 menambahkan kolom `disabled` + tombol Disable di dashboard, tapi
// TIDAK ada satu pun jalur auth yang membacanya. Dibuktikan di server lokal
// sebelum perbaikan: admin disable user → user tetap bisa login (200) dan
// memakai tokennya (200). Fitur yang mengiklankan perlindungan yang tidak ada.
//
// Empat celah yang ditutup:
//   1. login password        → verifyAuthCredentials + guard di route (403)
//   2. refresh               → refreshAccessToken melempar AuthUserDisabledError
//   3. MFA challenge         → issueTokens (gerbang tunggal)
//   4. sesi yang berjalan    → setAuthUserDisabled me-revoke refresh token
//
// Catatan jujur yang DIUJI di sini: access token yang sudah terbit tetap valid
// sampai TTL habis (verifyToken sengaja stateless). Test "jendela 15 menit"
// di bawah mendokumentasikan batas itu alih-alih menyembunyikannya.
//
// HTTP integration dengan server node:http sungguhan — bukan mock.
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import nodeHttp from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { initPlatformDb, closePlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs, getProjectDb } from '../src/core/projectDbManager.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';
import { createProjectAuthRouter } from '../src/api/authRoutes.js';
import { createUserAdminRouter } from '../src/api/userAdminRoutes.js';
import { createMfaRouter } from '../src/api/mfaRoutes.js';
import { totpAt, base32Decode } from '../src/auth/totp.js';
import { Router } from '../src/core/router.js';
import { resetAllRateLimits } from '../src/auth/rateLimiter.js';

let server: nodeHttp.Server;
let baseURL = '';
const TEST_DATA_DIR = path.resolve('../data/ops15-test');

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
  router.merge(createUserAdminRouter());
  router.merge(createMfaRouter());

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
const PASSWORD = 'passwordRahasia123';

async function registerUser(email: string): Promise<{ id: string; accessToken: string; refreshToken: string }> {
  const reg = await http('POST', `/api/p/${projectId}/auth/register`, {
    email,
    password: PASSWORD,
    name: 'Ops15 User',
  });
  assert.equal(reg.status, 201, `register ${email} harus 201`);
  return { id: reg.body.user.id, accessToken: reg.body.accessToken, refreshToken: reg.body.refreshToken };
}

async function setDisabled(uid: string, disabled: boolean): Promise<void> {
  const res = await http(
    'POST',
    `/api/admin/projects/${projectId}/auth-users/${uid}/disable`,
    { disabled },
    adminToken
  );
  assert.equal(res.status, 200, 'admin disable/enable harus 200');
  assert.equal(res.body.disabled, disabled);
}

test('Ops-15 setup: admin login + project', async () => {
  await resetAllRateLimits();

  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@test.local',
    password: 'admin-test-pass',
  });
  assert.equal(login.status, 200);
  adminToken = login.body.token;

  const project = await http('POST', '/api/admin/projects', { name: 'ops15app' }, adminToken);
  assert.equal(project.status, 201);
  projectId = project.body.project.id;
  assert.ok(projectId);
});

// ════════════════════════════════════════════════════════════════════════════
// CELAH 1 — LOGIN PASSWORD
// ════════════════════════════════════════════════════════════════════════════

test('Ops-15 celah 1: user disabled TIDAK bisa login (403 USER_DISABLED, tanpa token)', async () => {
  await resetAllRateLimits();
  const u = await registerUser('disabled-login@x.com');
  await setDisabled(u.id, true);

  const res = await http('POST', `/api/p/${projectId}/auth/login`, {
    email: 'disabled-login@x.com',
    password: PASSWORD,
  });

  // Status yang benar: 403 (kredensial SAH, akunnya yang ditolak) — bukan 401.
  assert.equal(res.status, 403, 'harus 403, bukan 401 (kredensial benar) dan bukan 200');
  assert.equal(res.body.error.code, 'USER_DISABLED');

  // Bukti STATE, bukan hanya status code: tidak ada token yang lolos.
  assert.equal(res.body.accessToken, undefined, 'tidak boleh ada accessToken');
  assert.equal(res.body.refreshToken, undefined, 'tidak boleh ada refreshToken');
});

test('Ops-15: password SALAH pada user disabled tetap 401 (jangan bocorkan status akun)', async () => {
  await resetAllRateLimits();
  const u = await registerUser('disabled-wrongpass@x.com');
  await setDisabled(u.id, true);

  const res = await http('POST', `/api/p/${projectId}/auth/login`, {
    email: 'disabled-wrongpass@x.com',
    password: 'passwordSalahSekali',
  });

  // Kalau password salah menjawab 403 USER_DISABLED, endpoint ini jadi oracle:
  // penyerang bisa memetakan akun mana yang ada & dinonaktifkan tanpa tahu password.
  assert.equal(res.status, 401, 'password salah harus tetap 401 generik');
  assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
});

// ════════════════════════════════════════════════════════════════════════════
// CELAH 2 — REFRESH
// ════════════════════════════════════════════════════════════════════════════

test('Ops-15 celah 2: refresh token user disabled ditolak 403 (tidak bisa perpanjang sesi)', async () => {
  await resetAllRateLimits();
  const u = await registerUser('disabled-refresh@x.com');

  // refresh SEBELUM disable harus jalan — membuktikan token itu memang sah
  const before = await http('POST', `/api/p/${projectId}/auth/refresh`, { refreshToken: u.refreshToken });
  assert.equal(before.status, 200, 'baseline: refresh jalan sebelum disable');
  const freshRefresh = before.body.refreshToken as string;

  await setDisabled(u.id, true);

  // Jalur NORMAL: disable via admin API sudah me-revoke token (celah 4) — lapis
  // pertama menang, token dianggap tidak dikenal → 401. Tidak ada token baru.
  const after = await http('POST', `/api/p/${projectId}/auth/refresh`, { refreshToken: freshRefresh });
  assert.ok(after.status === 401 || after.status === 403, `harus ditolak, dapat ${after.status}`);
  assert.equal(after.body.accessToken, undefined, 'tidak boleh menerbitkan access token baru');
});

test('Ops-15 celah 2 (lapis kedua): flag disabled TANPA revoke tetap menolak refresh dengan 403', async () => {
  await resetAllRateLimits();
  const u = await registerUser('disabled-refresh-sql@x.com');

  // Simulasi jalur yang MELEWATI setAuthUserDisabled (migrasi manual, SQL langsung,
  // tool lain): flag disabled=1 tapi refresh token masih revoked=0. Di sinilah
  // cek `u.disabled` di refreshAccessToken menjadi satu-satunya penjaga.
  const db = getProjectDb(projectId);
  db.prepare('UPDATE _auth_users SET disabled = 1 WHERE id = ?').run(u.id);
  const masihAktif = db
    .prepare('SELECT COUNT(*) AS c FROM _auth_tokens WHERE user_id = ? AND revoked = 0')
    .get(u.id) as { c: number };
  assert.ok(masihAktif.c > 0, 'prasyarat: token belum di-revoke');

  const res = await http('POST', `/api/p/${projectId}/auth/refresh`, { refreshToken: u.refreshToken });
  assert.equal(res.status, 403, 'tanpa revoke, cek disabled harus menangkap → 403');
  assert.equal(res.body.error.code, 'USER_DISABLED');
  assert.equal(res.body.accessToken, undefined);
});

// ════════════════════════════════════════════════════════════════════════════
// CELAH 3 — MFA CHALLENGE (jalur sampingan yang melewati guard login)
// ════════════════════════════════════════════════════════════════════════════

function nowCode(secretB32: string): string {
  return totpAt(base32Decode(secretB32), Math.floor(Date.now() / 1000));
}

test('Ops-15 celah 3: MFA challenge tidak boleh menuntaskan sesi untuk akun disabled', async () => {
  await resetAllRateLimits();
  const u = await registerUser('disabled-mfa@x.com');

  // Aktifkan MFA selagi akun masih aktif
  const enroll = await http('POST', `/api/p/${projectId}/auth/mfa/enroll`, {}, u.accessToken);
  assert.equal(enroll.status, 200, JSON.stringify(enroll.body));
  const secret = enroll.body.secret as string;
  const verify = await http(
    'POST',
    `/api/p/${projectId}/auth/mfa/verify`,
    { token: nowCode(secret) },
    u.accessToken
  );
  assert.equal(verify.status, 200, 'MFA aktif sebagai prasyarat');

  // Login → dapat mfaToken (belum sesi penuh)
  await resetAllRateLimits();
  const login = await http('POST', `/api/p/${projectId}/auth/login`, {
    email: 'disabled-mfa@x.com',
    password: PASSWORD,
  });
  assert.equal(login.status, 200);
  assert.equal(login.body.mfaRequired, true);
  const mfaToken = login.body.mfaToken as string;
  assert.ok(mfaToken);

  // Admin menonaktifkan akun DI TENGAH alur MFA (mfaToken sudah di tangan user)
  await setDisabled(u.id, true);

  // Challenge dengan kode TOTP yang BENAR → harus tetap ditolak 403.
  // Tanpa gerbang di issueTokens, jalur ini menerbitkan sesi penuh dan
  // melewati guard di route login sepenuhnya.
  const challenge = await http('POST', `/api/p/${projectId}/auth/mfa/challenge`, {
    mfaToken,
    token: nowCode(secret),
  });
  assert.equal(challenge.status, 403, 'MFA challenge harus 403 untuk akun disabled');
  assert.equal(challenge.body.error.code, 'USER_DISABLED');
  assert.equal(challenge.body.accessToken, undefined, 'tidak boleh ada sesi penuh');
});

// ════════════════════════════════════════════════════════════════════════════
// CELAH 4 — SESI YANG SEDANG BERJALAN
// ════════════════════════════════════════════════════════════════════════════

test('Ops-15 celah 4: disable me-REVOKE semua refresh token yang beredar', async () => {
  await resetAllRateLimits();
  const u = await registerUser('disabled-revoke@x.com');

  // dua sesi terpisah (mis. HP + laptop)
  const login2 = await http('POST', `/api/p/${projectId}/auth/login`, {
    email: 'disabled-revoke@x.com',
    password: PASSWORD,
  });
  assert.equal(login2.status, 200);
  const sesiKedua = login2.body.refreshToken as string;

  await setDisabled(u.id, true);

  // Bukti di DB: tidak ada refresh token aktif yang tersisa untuk user ini.
  const db = getProjectDb(projectId);
  const aktif = db
    .prepare('SELECT COUNT(*) AS c FROM _auth_tokens WHERE user_id = ? AND revoked = 0')
    .get(u.id) as { c: number };
  assert.equal(aktif.c, 0, 'semua refresh token harus revoked saat disable');

  // Kedua sesi mati, bukan hanya yang terakhir.
  const r1 = await http('POST', `/api/p/${projectId}/auth/refresh`, { refreshToken: u.refreshToken });
  const r2 = await http('POST', `/api/p/${projectId}/auth/refresh`, { refreshToken: sesiKedua });
  assert.ok(r1.status >= 400, 'sesi pertama harus mati');
  assert.ok(r2.status >= 400, 'sesi kedua harus mati');
});

test('Ops-15 BATAS YANG DIAKUI: access token yang sudah terbit masih valid sampai TTL habis', async () => {
  await resetAllRateLimits();
  const u = await registerUser('disabled-window@x.com');

  await setDisabled(u.id, true);

  // verifyToken sengaja STATELESS (9 pemanggil, hot path) → token 15 menit yang
  // sudah terbit tidak bisa dibatalkan seketika. Perilaku ini SAMA dengan
  // Supabase (JWT stateless). Diuji supaya terdokumentasi, bukan tersembunyi;
  // kalau suatu saat diputuskan harus 401 seketika, test ini yang gagal lebih
  // dulu dan memaksa keputusan itu eksplisit.
  const me = await http('GET', `/api/p/${projectId}/auth/me`, undefined, u.accessToken);
  assert.equal(me.status, 200, 'BATAS DIAKUI: access token lama masih lolos sampai expired');

  // Yang penting: user tidak bisa MEMPERPANJANG sesi itu.
  const refresh = await http('POST', `/api/p/${projectId}/auth/refresh`, { refreshToken: u.refreshToken });
  assert.ok(refresh.status === 401 || refresh.status === 403, 'perpanjangan sesi tetap tertutup');
  assert.equal(refresh.body.accessToken, undefined);
});

// ════════════════════════════════════════════════════════════════════════════
// PEMULIHAN — enable ulang
// ════════════════════════════════════════════════════════════════════════════

test('Ops-15: enable ulang memulihkan login (disable bukan penghapusan permanen)', async () => {
  await resetAllRateLimits();
  const u = await registerUser('disabled-then-enabled@x.com');

  await setDisabled(u.id, true);
  const ditolak = await http('POST', `/api/p/${projectId}/auth/login`, {
    email: 'disabled-then-enabled@x.com',
    password: PASSWORD,
  });
  assert.equal(ditolak.status, 403);

  await setDisabled(u.id, false);
  await resetAllRateLimits();

  const diterima = await http('POST', `/api/p/${projectId}/auth/login`, {
    email: 'disabled-then-enabled@x.com',
    password: PASSWORD,
  });
  assert.equal(diterima.status, 200, 'setelah di-enable harus bisa login lagi');
  assert.ok(diterima.body.accessToken, 'dan menerima token penuh');

  // Bukti state di sumbernya (respons login tidak memuat field `disabled`).
  const db = getProjectDb(projectId);
  const row = db.prepare('SELECT disabled FROM _auth_users WHERE id = ?').get(u.id) as { disabled: number };
  assert.equal(row.disabled, 0);
});

// ════════════════════════════════════════════════════════════════════════════
// NON-REGRESI — user normal tidak terganggu
// ════════════════════════════════════════════════════════════════════════════

test('Ops-15 non-regresi: user aktif tetap bisa login, refresh, dan akses /auth/me', async () => {
  await resetAllRateLimits();
  const u = await registerUser('aktif-normal@x.com');

  const login = await http('POST', `/api/p/${projectId}/auth/login`, {
    email: 'aktif-normal@x.com',
    password: PASSWORD,
  });
  assert.equal(login.status, 200);
  assert.ok(login.body.accessToken);

  const refresh = await http('POST', `/api/p/${projectId}/auth/refresh`, {
    refreshToken: login.body.refreshToken,
  });
  assert.equal(refresh.status, 200);

  const me = await http('GET', `/api/p/${projectId}/auth/me`, undefined, refresh.body.accessToken);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.email, 'aktif-normal@x.com');
  void u;
});
