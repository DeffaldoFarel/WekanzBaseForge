// ============================================================================
// SECURITY: auth hardening — temuan audit FASE 1 (2026-10)
//
// AUD-1-05 — POST /auth/mfa/disable tanpa rate limit: pemegang access token
//   curian bisa menebak TOTP 6-digit (HMAC ~µs) untuk mematikan MFA PERMANEN.
//   Probe lama: 30 kode salah → 429=0. Kini 5/15 menit per user.
//
// AUD-1-06 — fallback chain secret tanpa fail-loud: produksi tanpa JWT_SECRET
//   membuat semua JWT user + secret terenkripsi ditandatangani/derive dari
//   password admin (atau dev-constant!). Kini: NODE_ENV=production tanpa
//   JWT_SECRET → server menolak menyala (productionSecretGate).
//
// AUD-1-08 — TOTP tanpa proteksi replay: kode yang tereks masih valid di
//   window berikutnya. Kini: replay guard mode LENIENT — kode dari window
//   lebih lama dari keberhasilan terakhir ditolak; window saat ini tetap
//   boleh (kontrak m27: confirm→challenge cepat).
//
// AUD-1-09 — email user di-interpolasi tanpa escape di halaman verifikasi
//   HTML (regex email memperbolehkan '<>' di local part) → self-XSS.
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import nodeHttp from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { initPlatformDb, closePlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs, getProjectDb } from '../src/core/projectDbManager.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createProjectAuthRouter } from '../src/api/authRoutes.js';
import { createMfaRouter } from '../src/api/mfaRoutes.js';
import { createEmailRouter } from '../src/api/emailRoutes.js';
import { Router } from '../src/core/router.js';
import { totpAt, base32Decode } from '../src/auth/totp.js';
import { startEnrollment, verifyUserTotp } from '../src/auth/mfa.js';
import { productionSecretGate } from '../src/platform/prodSecrets.js';

let server: nodeHttp.Server;
let baseURL = '';
const TEST_DATA_DIR = path.resolve('../data/sec-auth-hard-test');

let pid: string;
let adminToken: string;

async function http(method: string, reqPath: string, body?: unknown, token?: string): Promise<{ status: number; data: any; text: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, baseURL);
    const req = nodeHttp.request(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let data: any = null;
        try { data = JSON.parse(text); } catch { data = null; }
        resolve({ status: res.statusCode ?? 0, data, text });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

before(async () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  process.env.DATA_DIR = TEST_DATA_DIR;
  process.env.ADMIN_EMAIL = 'admin@test.local';
  process.env.ADMIN_PASSWORD = 'admin-test-pass';
  process.env.STORAGE_DIR = path.join(TEST_DATA_DIR, 'storage');

  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createProjectAuthRouter());
  router.merge(createMfaRouter());
  router.merge(createEmailRouter());

  server = nodeHttp.createServer((req, res) => { router.handle(req, res); });
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      baseURL = `http://localhost:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });

  const login = await http('POST', '/api/admin/auth/login', { email: 'admin@test.local', password: 'admin-test-pass' });
  adminToken = login.data.token;
  const proj = await http('POST', '/api/admin/projects', { name: 'sec-auth-hard' }, adminToken);
  pid = proj.data.project.id;
});

after(async () => {
  closeAllProjectDbs();
  closePlatformDb();
  server.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test('AUD-1-05: /mfa/disable kena rate limit (5/15 menit per user)', async () => {
  const email = 'mfa-hard@audit.test';
  const reg = await http('POST', `/api/p/${pid}/auth/register`, { email, password: 'passwordH-123' });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
  const login = await http('POST', `/api/p/${pid}/auth/login`, { email, password: 'passwordH-123' });
  const jwt0 = login.data.accessToken;

  const enroll = await http('POST', `/api/p/${pid}/auth/mfa/enroll`, {}, jwt0);
  const secret = enroll.data.secret as string;
  const verify = await http('POST', `/api/p/${pid}/auth/mfa/verify`, { token: totpAt(base32Decode(secret), Math.floor(Date.now() / 1000)) }, jwt0);
  assert.equal(verify.status, 200, JSON.stringify(verify.data));

  let s400 = 0, s429 = 0;
  for (let i = 0; i < 8; i++) {
    const r = await http('POST', `/api/p/${pid}/auth/mfa/disable`, { token: '000000' }, jwt0);
    if (r.status === 400 || r.status === 401) s400++; else if (r.status === 429) s429++;
  }
  assert.equal(s400, 5, `5 percobaan pertama = 400 INVALID_CODE (dapat ${s400})`);
  assert.ok(s429 >= 3, `percobaan 6-8 harus 429 (dapat ${s429}) — sebelumnya TIDAK ADA limit`);
});

test('AUD-1-06: productionSecretGate — fail-loud saat produksi tanpa JWT_SECRET', () => {
  const saved = { nodeEnv: process.env.NODE_ENV, jwt: process.env.JWT_SECRET, oauth: process.env.OAUTH_SECRET };
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.JWT_SECRET;
    delete process.env.OAUTH_SECRET;
    const fatal = productionSecretGate();
    assert.ok(fatal.fatal, 'produksi tanpa JWT_SECRET harus FATAL (sebelumnya: fallback senyap ke ADMIN_PASSWORD/dev-constant)');

    process.env.JWT_SECRET = 'prod-secret-for-test';
    const warn = productionSecretGate();
    assert.equal(warn.fatal, null, 'JWT_SECRET terisi → tidak fatal');
    assert.ok(warn.warn, 'produksi tanpa OAUTH_SECRET harus setidaknya WARNING');

    process.env.OAUTH_SECRET = 'prod-oauth-secret-for-test';
    const clean = productionSecretGate();
    assert.equal(clean.fatal, null);
    assert.equal(clean.warn, null);
  } finally {
    process.env.NODE_ENV = saved.nodeEnv;
    if (saved.jwt !== undefined) process.env.JWT_SECRET = saved.jwt; else delete process.env.JWT_SECRET;
    if (saved.oauth !== undefined) process.env.OAUTH_SECRET = saved.oauth; else delete process.env.OAUTH_SECRET;
  }

  // Non-produksi → gate tidak aktif (dev/test tetap jalan tanpa secret)
  const dev = productionSecretGate();
  assert.equal(dev.fatal, null);
  assert.equal(dev.warn, null);
});

test('AUD-1-08: TOTP replay guard (lenient) — window lebih lama ditolak', () => {
  const db = getProjectDb(pid);
  const uid = 'totp-replay-unit-user';
  const { secretB32 } = startEnrollment(db, uid);
  const secret = base32Decode(secretB32);
  const now = Math.floor(Date.now() / 1000);

  // Kode window +1 (masih dalam toleransi ±1) → diterima, last = counter+1
  const codeFuture = totpAt(secret, now + 30);
  assert.equal(verifyUserTotp(db, uid, codeFuture), true, 'kode window+1 harus diterima');

  // Kode window sekarang (SEBELUM last) → DITOLAK. Sebelum fix: diterima
  // (replay lintas window terbuka lebar).
  const codeNow = totpAt(secret, now);
  assert.equal(verifyUserTotp(db, uid, codeNow), false, 'kode dari window lebih lama harus ditolak (replay guard)');

  // Kode window yang sama dengan last → tetap boleh (mode lenient — kontrak
  // m27: re-login cepat setelah enroll/confirm tidak boleh terkunci).
  assert.equal(verifyUserTotp(db, uid, codeFuture), true, 'kode window saat ini tetap reusable (lenient)');
});

test('AUD-1-09: email user di-escape di halaman verifikasi (anti self-XSS)', async () => {
  // Regex email memperbolehkan '<>' di local part — halaman HTML harus escape
  const email = 'x<b>tags@esc.test';
  const reg = await http('POST', `/api/p/${pid}/auth/register`, { email, password: 'passwordE-123' });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));

  const req = await http('POST', `/api/p/${pid}/auth/request-verification`, { email });
  assert.equal(req.status, 200);

  const outbox = await http('GET', '/api/admin/settings/mail/outbox?limit=5', undefined, adminToken);
  const msgs: any[] = outbox.data?.messages ?? [];
  const msg = msgs.find((m) => String(m.to ?? '').toLowerCase() === email && String(m.text ?? '').includes('verify-email'));
  assert.ok(msg, 'email verifikasi harus ada di outbox');
  const link = String(msg.text).match(/https?:\/\/\S+/)?.[0] ?? '';

  const click = await http('GET', link.replace(baseURL, ''));
  assert.equal(click.status, 200);
  assert.ok(!click.text.includes('<b>tags@'), 'raw <b> TIDAK boleh muncul di HTML (sebelumnya: di-interpolasi mentah)');
  assert.ok(click.text.includes('x&lt;b&gt;tags@'), 'email harus tampil dalam bentuk ter-escape');
});
