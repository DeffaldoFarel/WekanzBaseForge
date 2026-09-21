// ============================================================================
// M27: TEST MFA/TOTP — vektor RFC 6238, lifecycle, challenge, recovery
//
// Kunci test: waktu TOTP dikontrol via parameter unixTime (verifyTotp) —
// unit test deterministic. Untuk test HTTP (enroll/verify/challenge), kode
// dihitung REAL dari secret yang di-return enroll (jam mesin = jam server).
//
// Fokus:
//  1. Unit: vektor RFC 6238 (6 nilai resmi) + window ±1 + tolak +2
//  2. Enroll → secret + otpauthUrl; login masih normal (pending)
//  3. Verify salah → 400; benar → enabled + 10 recovery codes sekali
//  4. Login MFA → { mfaRequired, mfaToken } TANPA accessToken
//  5. Challenge: salah → 401 (mfaToken tetap hidup); benar → tokens + /me ok
//  6. mfaToken sekali sukses (challenge kedua → 401)
//  7. Recovery code: sukses → tokens; sekali pakai
//  8. Disable: butuh kode; sukses → login kembali normal
//  9. Rate limit challenge: 6th percobaan → 429
// 10. Admin: list users + mfaEnabled; mfa-reset → login normal
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import nodeHttp from 'node:http';
import { initPlatformDb, closePlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { Router } from '../src/core/router.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createProjectAuthRouter } from '../src/api/authRoutes.js';
import { createMfaRouter } from '../src/api/mfaRoutes.js';
import { createUserAdminRouter } from '../src/api/userAdminRoutes.js';
import { totpAt, verifyTotp, base32Decode } from '../src/auth/totp.js';

const TEST_DATA_DIR = path.resolve('../data/m27-mfa-test');

let server: nodeHttp.Server;
let baseURL: string;
let adminToken: string;
let projectId: string;

const USER = { email: 'mfa-user@m27.test', password: 'passwordM-123' };

function http(
  method: string,
  p: string,
  body?: unknown,
  token?: string,
  headers?: Record<string, string>
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request(
      new URL(p, baseURL),
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(headers ?? {}),
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
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Kode TOTP valid SAAT INI untuk secret base32 (server & test 1 jam mesin). */
function nowCode(secretB32: string): string {
  return totpAt(base32Decode(secretB32), Math.floor(Date.now() / 1000));
}

// Rotasi IP: rate limiter login/enroll/verify adalah per-IP — test suite
// dari satu IP akan saling membatasi. Setiap kelompok panggilan pakai IP unik.
let ipSeq = 0;
function ip(): string {
  ipSeq += 1;
  return '10.88.' + Math.floor(ipSeq / 250) + '.' + ((ipSeq % 250) + 1);
}
function fh(): Record<string, string> {
  return { 'X-Forwarded-For': ip() };
}

before(async () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  process.env.DATA_DIR = TEST_DATA_DIR;
  process.env.ADMIN_EMAIL = 'admin@m27.test';
  process.env.ADMIN_PASSWORD = 'm27-secret-pass';
  process.env.JWT_SECRET = 'm27-test-jwt-secret-key-long-enough';
  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createProjectAuthRouter());
  router.merge(createMfaRouter());
  router.merge(createUserAdminRouter());

  server = nodeHttp.createServer((rq, rs) => router.handle(rq, rs));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  baseURL = `http://127.0.0.1:${addr.port}`;

  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@m27.test',
    password: 'm27-secret-pass',
  });
  assert.equal(login.status, 200);
  adminToken = login.data.token;

  const proj = await http('POST', '/api/admin/projects', { name: 'm27-mfa' }, adminToken);
  assert.equal(proj.status, 201);
  projectId = proj.data.project?.id ?? proj.data.id;

  const reg = await http('POST', `/api/p/${projectId}/auth/register`, USER);
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  closeAllProjectDbs();
  // Windows: rmSync gagal EPERM selama handle platform.db masih terbuka.
  closePlatformDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─── 1. Unit: vektor resmi RFC 6238 ───────────────────────────────────────────

test('unit: vektor RFC 6238 (secret standar 12345678901234567890)', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii');
  // Nilai 6-digit resmi (terpotong dari vektor 8-digit Appendix B)
  const vectors: Array<[number, string]> = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ];
  for (const [t, expected] of vectors) {
    assert.equal(totpAt(secret, t), expected, `T=${t}`);
  }
});

test('unit: window ±1 diterima; ±2 ditolak; non-digit ditolak', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii');
  const t = 1111111109;
  assert.ok(verifyTotp(secret, totpAt(secret, t), t), 'kode current');
  assert.ok(verifyTotp(secret, totpAt(secret, t + 30), t), 'drift +30s (clock user maju)');
  assert.ok(verifyTotp(secret, totpAt(secret, t - 30), t), 'drift -30s');
  assert.ok(!verifyTotp(secret, totpAt(secret, t + 60), t), '+60s ditolak');
  assert.ok(!verifyTotp(secret, 'abcdef', t), 'non-digit');
  assert.ok(!verifyTotp(secret, '12345', t), '5 digit');
});

// ─── 2-3. Enroll & verify lifecycle ───────────────────────────────────────────

test('enroll → login masih normal (pending) → verify benar → recovery codes sekali', async () => {
  // Login dulu (tanpa MFA)
  const login1 = await http('POST', `/api/p/${projectId}/auth/login`, USER, undefined, fh());
  assert.equal(login1.status, 200);
  assert.ok(login1.data.accessToken);
  assert.equal(login1.data.user.mfaEnabled, false);
  const jwt = login1.data.accessToken;

  // Enroll
  const enroll = await http('POST', `/api/p/${projectId}/auth/mfa/enroll`, {}, jwt, fh());
  assert.equal(enroll.status, 200, JSON.stringify(enroll.data));
  assert.ok(enroll.data.secret);
  assert.ok(enroll.data.otpauthUrl.startsWith('otpauth://totp/BaseForge%3A'));
  assert.ok(enroll.data.otpauthUrl.includes(`secret=${enroll.data.secret}`));

  // MASIH pending → login normal (belum ada gerbang)
  const login2 = await http('POST', `/api/p/${projectId}/auth/login`, USER, undefined, fh());
  assert.equal(login2.status, 200);
  assert.ok(login2.data.accessToken, 'pending enrollment tidak boleh memicu MFA');
  const jwt2 = login2.data.accessToken;

  // Verify dengan kode salah → 400
  const badVerify = await http('POST', `/api/p/${projectId}/auth/mfa/verify`, { token: '000000' }, jwt2);
  assert.equal(badVerify.status, 400);
  assert.equal(badVerify.data.error.code, 'INVALID_CODE');

  // Verify dengan kode benar → recovery codes
  const goodVerify = await http(
    'POST',
    `/api/p/${projectId}/auth/mfa/verify`,
    { token: nowCode(enroll.data.secret) },
    jwt2
  );
  assert.equal(goodVerify.status, 200, JSON.stringify(goodVerify.data));
  assert.equal(goodVerify.data.mfaEnabled, true);
  assert.equal(goodVerify.data.recoveryCodes.length, 10);
  assert.ok(goodVerify.data.recoveryCodes.every((c: string) => /^[a-z0-9]{10}$/.test(c)));
});

// ─── 4-6. Login MFA + challenge ───────────────────────────────────────────────

test('login MFA → mfaToken tanpa accessToken; challenge salah → 401; benar → tokens', async () => {
  // Ambil secret untuk hitung kode — enroll ulang via user yang sudah enabled?
  // Tidak: enroll ulang akan menurunkan enabled. Ambil dari login flow saja:
  // kita butuh kode valid → gunakan user BARU + enroll + verify, simpan secret.
  const newUser = { email: 'mfa-challenge@m27.test', password: 'passwordC-123' };
  await http('POST', `/api/p/${projectId}/auth/register`, newUser);
  const login0 = await http('POST', `/api/p/${projectId}/auth/login`, newUser, undefined, fh());
  const jwt0 = login0.data.accessToken;
  const enroll = await http('POST', `/api/p/${projectId}/auth/mfa/enroll`, {}, jwt0, fh());
  const secret = enroll.data.secret;
  const verify = await http('POST', `/api/p/${projectId}/auth/mfa/verify`, { token: nowCode(secret) }, jwt0, fh());
  assert.equal(verify.status, 200);

  // LOGIN: password benar → mfaRequired, TANPA token
  const login = await http('POST', `/api/p/${projectId}/auth/login`, newUser, undefined, fh());
  assert.equal(login.status, 200);
  assert.equal(login.data.mfaRequired, true);
  assert.ok(login.data.mfaToken);
  assert.ok(!login.data.accessToken, 'token penuh tidak boleh keluar sebelum MFA');
  const mfaToken = login.data.mfaToken;

  // Challenge salah → 401 (mfaToken masih hidup — percobaan tidak membunuhnya)
  const bad = await http('POST', `/api/p/${projectId}/auth/mfa/challenge`, {
    mfaToken,
    token: '000000',
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.data.error.code, 'INVALID_CODE');

  // Challenge benar → tokens
  const good = await http('POST', `/api/p/${projectId}/auth/mfa/challenge`, {
    mfaToken,
    token: nowCode(secret),
  });
  assert.equal(good.status, 200, JSON.stringify(good.data));
  assert.ok(good.data.accessToken);
  assert.equal(good.data.user.mfaEnabled, true);

  // /me dengan token hasil challenge
  const me = await http('GET', `/api/p/${projectId}/auth/me`, undefined, good.data.accessToken);
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, newUser.email);
  assert.equal(me.data.user.mfaEnabled, true);

  // mfaToken sekali sukses → challenge kedua → 401
  const replay = await http('POST', `/api/p/${projectId}/auth/mfa/challenge`, {
    mfaToken,
    token: nowCode(secret),
  });
  assert.equal(replay.status, 401);
});

// ─── 7. Recovery code path ────────────────────────────────────────────────────

test('recovery code: challenge sukses; sekali pakai', async () => {
  const newUser = { email: 'mfa-recovery@m27.test', password: 'passwordR-123' };
  await http('POST', `/api/p/${projectId}/auth/register`, newUser);
  const login0 = await http('POST', `/api/p/${projectId}/auth/login`, newUser, undefined, fh());
  const jwt0 = login0.data.accessToken;
  const enroll = await http('POST', `/api/p/${projectId}/auth/mfa/enroll`, {}, jwt0, fh());
  const verify = await http('POST', `/api/p/${projectId}/auth/mfa/verify`, { token: nowCode(enroll.data.secret) }, jwt0, fh());
  assert.equal(verify.status, 200);
  const recoveryCodes: string[] = verify.data.recoveryCodes;

  const login = await http('POST', `/api/p/${projectId}/auth/login`, newUser, undefined, fh());
  const mfaToken = login.data.mfaToken;

  // Recovery code pertama → sukses
  const good = await http('POST', `/api/p/${projectId}/auth/mfa/challenge`, {
    mfaToken,
    recoveryCode: recoveryCodes[0],
  });
  assert.equal(good.status, 200, JSON.stringify(good.data));
  assert.ok(good.data.accessToken);

  // Login ulang + recovery code SAMA → gagal (sudah dipakai)
  const login2 = await http('POST', `/api/p/${projectId}/auth/login`, newUser, undefined, fh());
  const used = await http('POST', `/api/p/${projectId}/auth/mfa/challenge`, {
    mfaToken: login2.data.mfaToken,
    recoveryCode: recoveryCodes[0],
  });
  assert.equal(used.status, 401);
});

// ─── 8. Disable ───────────────────────────────────────────────────────────────

test('disable: tanpa bukti → 400; dengan recovery code → login kembali normal', async () => {
  const newUser = { email: 'mfa-disable@m27.test', password: 'passwordD-123' };
  await http('POST', `/api/p/${projectId}/auth/register`, newUser);
  const login0 = await http('POST', `/api/p/${projectId}/auth/login`, newUser, undefined, fh());
  const jwt0 = login0.data.accessToken;
  const enroll = await http('POST', `/api/p/${projectId}/auth/mfa/enroll`, {}, jwt0, fh());
  const verify = await http('POST', `/api/p/${projectId}/auth/mfa/verify`, { token: nowCode(enroll.data.secret) }, jwt0, fh());
  const recoveryCodes: string[] = verify.data.recoveryCodes;

  // Login MFA dulu untuk dapat JWT sesi (login password kena gerbang MFA...
  // tapi jwt0 dari sebelum enable masih valid!)
  const noProof = await http('POST', `/api/p/${projectId}/auth/mfa/disable`, {}, jwt0);
  assert.equal(noProof.status, 400);

  const disable = await http(
    'POST',
    `/api/p/${projectId}/auth/mfa/disable`,
    { recoveryCode: recoveryCodes[3] },
    jwt0
  );
  assert.equal(disable.status, 200);

  // Login kembali normal — tanpa MFA
  const loginAfter = await http('POST', `/api/p/${projectId}/auth/login`, newUser, undefined, fh());
  assert.equal(loginAfter.status, 200);
  assert.ok(loginAfter.data.accessToken);
  assert.equal(loginAfter.data.mfaRequired, undefined);
});

// ─── 9. Rate limit challenge (brute force 6-digit) ───────────────────────────

test('challenge: 6 percobaan kode salah → 429 (brute force blocked)', async () => {
  const newUser = { email: 'mfa-brute@m27.test', password: 'passwordB-123' };
  await http('POST', `/api/p/${projectId}/auth/register`, newUser);
  const login0 = await http('POST', `/api/p/${projectId}/auth/login`, newUser, undefined, fh());
  const jwt0 = login0.data.accessToken;
  const enroll = await http('POST', `/api/p/${projectId}/auth/mfa/enroll`, {}, jwt0, fh());
  await http('POST', `/api/p/${projectId}/auth/mfa/verify`, { token: nowCode(enroll.data.secret) }, jwt0, fh());

  const login = await http('POST', `/api/p/${projectId}/auth/login`, newUser, undefined, fh());
  const mfaToken = login.data.mfaToken;

  let lastStatus = 0;
  for (let i = 0; i < 6; i++) {
    const r = await http('POST', `/api/p/${projectId}/auth/mfa/challenge`, {
      mfaToken,
      token: '000000', // salah terus
    });
    lastStatus = r.status;
    if (r.status === 429) break;
  }
  assert.equal(lastStatus, 429, 'harus terblokir di percobaan ke-6');
});

// ─── 10. Admin: mfaEnabled di list + mfa-reset ───────────────────────────────

test('admin: list users menampilkan mfaEnabled; mfa-reset melepas gerbang', async () => {
  const newUser = { email: 'mfa-admin@m27.test', password: 'passwordA-123' };
  const reg = await http('POST', `/api/p/${projectId}/auth/register`, newUser);
  const jwt0 = reg.data.accessToken;
  const enroll = await http('POST', `/api/p/${projectId}/auth/mfa/enroll`, {}, jwt0, fh());
  await http('POST', `/api/p/${projectId}/auth/mfa/verify`, { token: nowCode(enroll.data.secret) }, jwt0, fh());

  // Login → harus kena MFA
  const loginBlocked = await http('POST', `/api/p/${projectId}/auth/login`, newUser, undefined, fh());
  assert.equal(loginBlocked.data.mfaRequired, true);

  // List user via admin
  const list = await http('GET', `/api/admin/projects/${projectId}/auth-users?perPage=100`, undefined, adminToken);
  assert.equal(list.status, 200);
  const entry = list.data.items.find((u: any) => u.email === newUser.email);
  assert.ok(entry, 'user ada di list');
  assert.equal(entry.mfaEnabled, true, 'status MFA terlihat admin');

  const uid = entry.id;
  const reset = await http('POST', `/api/admin/projects/${projectId}/auth-users/${uid}/mfa-reset`, {}, adminToken);
  assert.equal(reset.status, 200);

  // Login kembali normal
  const loginAfter = await http('POST', `/api/p/${projectId}/auth/login`, newUser, undefined, fh());
  assert.equal(loginAfter.status, 200);
  assert.ok(loginAfter.data.accessToken);

  // Reset kedua (tanpa MFA) → 404
  const reset2 = await http('POST', `/api/admin/projects/${projectId}/auth-users/${uid}/mfa-reset`, {}, adminToken);
  assert.equal(reset2.status, 404);
});

// ─── Auth & guard tambahan ────────────────────────────────────────────────────

test('guard: enroll tanpa JWT → 401; mfaToken sampah → 401; body kurang → 400', async () => {
  const noAuth = await http('POST', `/api/p/${projectId}/auth/mfa/enroll`, {});
  assert.equal(noAuth.status, 401);

  const garbage = await http('POST', `/api/p/${projectId}/auth/mfa/challenge`, {
    mfaToken: 'deadbeef'.repeat(8),
    token: '123456',
  });
  assert.equal(garbage.status, 401);
  assert.equal(garbage.data.error.code, 'INVALID_MFA_TOKEN');

  const missing = await http('POST', `/api/p/${projectId}/auth/mfa/challenge`, { mfaToken: 'x' });
  assert.equal(missing.status, 400);
});
