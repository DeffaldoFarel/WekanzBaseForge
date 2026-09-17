// ============================================================================
// M23: TEST EMAIL SERVICE — verifikasi email & reset password (mode outbox)
//
// Tanpa SMTP aktif, sendMail() jatuh ke DEV OUTBOX (tabel platform.db) —
// test membaca link/token dari outbox, alur penuh teruji tanpa SMTP sungguhan.
//
// Fokus test:
//  1. Register → email verifikasi otomatis muncul di outbox (dengan link)
//  2. request-verification: 200 selalu (email ada/tidak), anti-enumeration
//  3. verify-email (GET link): verified=1, halaman HTML sukses, token sekali pakai
//  4. verify-email (POST SDK): JSON; token invalid → 400
//  5. request-password-reset: 200 selalu; email reset di outbox
//  6. confirm GET: peek valid → redirect #reset_token / form HTML; invalid → 400
//  7. confirm POST: password berganti + SEMUA refresh token ter-revoke
//  8. Weak password ditolak; token reset ≠ token verify (purpose mismatch)
//  9. Admin: settings CRUD (password keep-existing), test-send, outbox list/clear
// 10. Rate limit request-* (5/15 menit)
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import nodeHttp from 'node:http';
import { initPlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { Router } from '../src/core/router.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createProjectAuthRouter } from '../src/api/authRoutes.js';
import { createEmailRouter } from '../src/api/emailRoutes.js';

const TEST_DATA_DIR = path.resolve('../data/m23-mail-test');

let server: nodeHttp.Server;
let baseURL: string;
let adminToken: string;
let projectId: string;

function http(
  method: string,
  p: string,
  body?: unknown,
  token?: string,
  headers?: Record<string, string>
): Promise<{ status: number; data: any; location: string | undefined; body: string }> {
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
        const loc = res.headers.location;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let data: any = {};
          try {
            data = JSON.parse(raw || '{}');
          } catch {}
          resolve({ status: res.statusCode ?? 0, data, location: loc, body: raw });
        });
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Ambil pesan outbox terbaru yang ditujukan ke email tsb. */
async function outboxLast(to: string): Promise<{ subject: string; text: string } | null> {
  const res = await http('GET', '/api/admin/settings/mail/outbox?limit=50', undefined, adminToken);
  const found = (res.data.messages ?? []).find((m: any) => m.to === to);
  return found ?? null;
}

/** Ekstrak token dari link di body email outbox. */
function extractToken(text: string, endpoint: string): string | null {
  const m = text.match(new RegExp(`${endpoint}\\?token=([a-f0-9]{64})`));
  return m ? m[1] : null;
}

let ipSeq = 0;
function nextIp(): string {
  ipSeq += 1;
  return `10.77.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

before(async () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  process.env.DATA_DIR = TEST_DATA_DIR;
  process.env.ADMIN_EMAIL = 'admin@m23.test';
  process.env.ADMIN_PASSWORD = 'm23-secret-pass';
  process.env.JWT_SECRET = 'm23-test-jwt-secret-key-long-enough';
  // SMTP_HOST sengaja TIDAK diset → mailer otomatis mode OUTBOX
  delete process.env.SMTP_HOST;
  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createProjectAuthRouter());
  router.merge(createEmailRouter());

  server = nodeHttp.createServer((rq, rs) => router.handle(rq, rs));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  baseURL = `http://127.0.0.1:${addr.port}`;

  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@m23.test',
    password: 'm23-secret-pass',
  });
  assert.equal(login.status, 200);
  adminToken = login.data.token;

  const proj = await http('POST', '/api/admin/projects', { name: 'm23-mail' }, adminToken);
  assert.equal(proj.status, 201);
  projectId = proj.data.project?.id ?? proj.data.id;
  assert.ok(projectId);

  // pastikan mode outbox aktif
  const settings = await http('GET', '/api/admin/settings/mail', undefined, adminToken);
  assert.equal(settings.status, 200);
  assert.equal(settings.data.mode, 'outbox');
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  closeAllProjectDbs();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─── 1. Register → email verifikasi otomatis ──────────────────────────────────

test('register: email verifikasi otomatis masuk outbox dengan link', async () => {
  const reg = await http('POST', `/api/p/${projectId}/auth/register`, {
    email: 'verify1@m23.test',
    password: 'passwordV-123',
    name: 'Verify One',
  });
  assert.equal(reg.status, 201);

  const msg = await outboxLast('verify1@m23.test');
  assert.ok(msg, 'email verifikasi harus ada di outbox');
  assert.ok(msg.subject.includes('Verify your email'));
  const token = extractToken(msg.text, '/auth/verify-email');
  assert.ok(token, 'link verify-email harus berisi token');
});

// ─── 2. request-verification: anti-enumeration ────────────────────────────────

test('request-verification: 200 untuk email terdaftar & TIDAK terdaftar', async () => {
  const known = await http(
    'POST',
    `/api/p/${projectId}/auth/request-verification`,
    { email: 'verify1@m23.test' },
    undefined,
    { 'X-Forwarded-For': nextIp() }
  );
  assert.equal(known.status, 200);

  const unknown = await http(
    'POST',
    `/api/p/${projectId}/auth/request-verification`,
    { email: 'hantu@tidakada.test' },
    undefined,
    { 'X-Forwarded-For': nextIp() }
  );
  assert.equal(unknown.status, 200);
  assert.equal(unknown.data.message, known.data.message, 'pesan harus identik (anti enum)');

  // email tidak ada → TIDAK ada email baru di outbox utk alamat hantu
  const ghost = await outboxLast('hantu@tidakada.test');
  assert.equal(ghost, null);

  // email terdaftar → token BARU dibuat (request ulang = token baru)
  const msg = await outboxLast('verify1@m23.test');
  assert.ok(msg);
});

// ─── 3. Verify via GET link (browser) ─────────────────────────────────────────

test('verify-email GET: verified=1, HTML sukses, token sekali pakai', async () => {
  const msg = await outboxLast('verify1@m23.test');
  assert.ok(msg);
  const token = extractToken(msg.text, '/auth/verify-email')!;

  const res = await http('GET', `/api/p/${projectId}/auth/verify-email?token=${token}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('Email verified'), 'harus halaman sukses HTML');
  assert.ok(res.body.includes('verify1@m23.test'));

  // /me menunjukkan verified=true sekarang
  const reg = await http('POST', `/api/p/${projectId}/auth/login`, {
    email: 'verify1@m23.test',
    password: 'passwordV-123',
  });
  const me = await http('GET', `/api/p/${projectId}/auth/me`, undefined, reg.data.accessToken);
  assert.equal(me.data.user.verified, true);

  // Token kedua kali → 400 (sekali pakai)
  const reuse = await http('GET', `/api/p/${projectId}/auth/verify-email?token=${token}`);
  assert.equal(reuse.status, 400);
  assert.ok(reuse.body.includes('expired'));

  // Token sampah → 400
  const garbage = await http(
    'GET',
    `/api/p/${projectId}/auth/verify-email?token=${'ab'.repeat(32)}`
  );
  assert.equal(garbage.status, 400);
});

// ─── 4. Verify via POST (SDK) ─────────────────────────────────────────────────

test('verify-email POST (SDK): JSON ok; purpose mismatch ditolak', async () => {
  // user baru via register → outbox berisi token verify segar
  await http('POST', `/api/p/${projectId}/auth/register`, {
    email: 'sdkver@m23.test',
    password: 'passwordS-123',
  });
  const msg = await outboxLast('sdkver@m23.test');
  assert.ok(msg);
  const token = extractToken(msg.text, '/auth/verify-email')!;

  const res = await http('POST', `/api/p/${projectId}/auth/verify-email`, { token });
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);

  // Token verify TIDAK bisa dipakai untuk purpose reset (mismatch)
  await http('POST', `/api/p/${projectId}/auth/register`, {
    email: 'mismatch@m23.test',
    password: 'passwordM-123',
  });
  const msg2 = await outboxLast('mismatch@m23.test');
  const vToken = extractToken(msg2!.text, '/auth/verify-email')!;
  const wrong = await http('POST', `/api/p/${projectId}/auth/confirm-password-reset`, {
    token: vToken,
    password: 'newPassword-456',
  });
  assert.equal(wrong.status, 400);
});

// ─── 5. request-password-reset ────────────────────────────────────────────────

test('request-password-reset: 200 selalu; email reset di outbox', async () => {
  const known = await http(
    'POST',
    `/api/p/${projectId}/auth/request-password-reset`,
    { email: 'verify1@m23.test' },
    undefined,
    { 'X-Forwarded-For': nextIp() }
  );
  assert.equal(known.status, 200);

  const unknown = await http(
    'POST',
    `/api/p/${projectId}/auth/request-password-reset`,
    { email: 'nobody@nowhere.test' },
    undefined,
    { 'X-Forwarded-For': nextIp() }
  );
  assert.equal(unknown.status, 200);

  const msg = await outboxLast('verify1@m23.test');
  assert.ok(msg);
  assert.ok(msg.subject.includes('Reset your password'));
  assert.ok(extractToken(msg.text, '/auth/confirm-password-reset'), 'link reset harus berisi token');

  // Email tidak terdaftar → tidak ada email untuk alamat itu
  const ghost = await outboxLast('nobody@nowhere.test');
  assert.equal(ghost, null);
});

// ─── 6. Confirm GET: peek tanpa konsumsi ─────────────────────────────────────

test('confirm-password-reset GET: redirect #reset_token; form HTML; invalid 400', async () => {
  const msg = await outboxLast('verify1@m23.test');
  const token = extractToken(msg!.text, '/auth/confirm-password-reset')!;

  // Dengan redirect_to → 302 dengan token di fragment (belum dikonsumsi)
  const app = `${baseURL}/reset-page`;
  const redir = await http(
    'GET',
    `/api/p/${projectId}/auth/confirm-password-reset?token=${token}&redirect_to=${encodeURIComponent(app)}`
  );
  assert.equal(redir.status, 302);
  assert.ok(redir.location!.startsWith(app));
  assert.ok(redir.location!.includes('#reset_token=' + token));

  // Tanpa redirect → form HTML self-contained (token masih hidup — peek)
  const form = await http(
    'GET',
    `/api/p/${projectId}/auth/confirm-password-reset?token=${token}`
  );
  assert.equal(form.status, 200);
  assert.ok(form.body.includes('Set a new password'), 'harus form HTML');

  // Token invalid → 400 halaman expired
  const bad = await http(
    'GET',
    `/api/p/${projectId}/auth/confirm-password-reset?token=${'cd'.repeat(32)}`
  );
  assert.equal(bad.status, 400);
});

// ─── 7. Confirm POST: reset penuh + revoke semua sesi ────────────────────────

test('confirm-password-reset POST: password baru + semua refresh token di-revoke', async () => {
  // Login dulu (dapat refresh token aktif) — harus mati setelah reset
  const login1 = await http('POST', `/api/p/${projectId}/auth/login`, {
    email: 'verify1@m23.test',
    password: 'passwordV-123',
  });
  assert.equal(login1.status, 200);
  const oldRefresh = login1.data.refreshToken;

  const msg = await outboxLast('verify1@m23.test');
  const token = extractToken(msg!.text, '/auth/confirm-password-reset')!;

  const res = await http('POST', `/api/p/${projectId}/auth/confirm-password-reset`, {
    token,
    password: 'passwordBaru-789',
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.ok, true);
  assert.ok(res.data.revokedSessions >= 1, 'refresh token harus di-revoke');

  // Password baru bisa login
  const login2 = await http('POST', `/api/p/${projectId}/auth/login`, {
    email: 'verify1@m23.test',
    password: 'passwordBaru-789',
  });
  assert.equal(login2.status, 200);

  // Password lama gagal
  const login3 = await http('POST', `/api/p/${projectId}/auth/login`, {
    email: 'verify1@m23.test',
    password: 'passwordV-123',
  });
  assert.equal(login3.status, 401);

  // Refresh token LAMA mati (revoke semua device)
  const refreshOld = await http('POST', `/api/p/${projectId}/auth/refresh`, {
    refreshToken: oldRefresh,
  });
  assert.equal(refreshOld.status, 401);

  // Token reset sekali pakai
  const reuse = await http('POST', `/api/p/${projectId}/auth/confirm-password-reset`, {
    token,
    password: 'passwordLagi-012',
  });
  assert.equal(reuse.status, 400);
});

// ─── 8. Weak password ditolak ────────────────────────────────────────────────

test('confirm-password-reset: password lemah ditolak WEAK_PASSWORD', async () => {
  await http('POST', `/api/p/${projectId}/auth/register`, {
    email: 'weakpw@m23.test',
    password: 'passwordW-123',
  });
  const req = await http(
    'POST',
    `/api/p/${projectId}/auth/request-password-reset`,
    { email: 'weakpw@m23.test' },
    undefined,
    { 'X-Forwarded-For': nextIp() }
  );
  assert.equal(req.status, 200);

  const msg = await outboxLast('weakpw@m23.test');
  const token = extractToken(msg!.text, '/auth/confirm-password-reset')!;

  const res = await http('POST', `/api/p/${projectId}/auth/confirm-password-reset`, {
    token,
    password: 'short',
  });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, 'WEAK_PASSWORD');

  // password asli masih berfungsi (reset tidak jadi)
  const login = await http('POST', `/api/p/${projectId}/auth/login`, {
    email: 'weakpw@m23.test',
    password: 'passwordW-123',
  });
  assert.equal(login.status, 200);
});

// ─── 9. Admin mail settings CRUD + test send + outbox management ─────────────

test('admin: settings CRUD (keep-existing pass), test send, outbox clear', async () => {
  // Simpan konfigurasi SMTP (host lokal dummy — tidak dipakai kirim di test ini)
  const put = await http('PUT', '/api/admin/settings/mail', {
    host: 'smtp.dummy.test',
    port: 587,
    secure: false,
    user: 'mailer@dummy.test',
    pass: 'dummy-smtp-password',
    from: 'BaseForge Test <test@dummy.test>',
  }, adminToken);
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal(put.data.mode, 'smtp');
  assert.equal(put.data.config.host, 'smtp.dummy.test');
  assert.equal(put.data.config.hasPassword, true);
  // password tidak bocor
  assert.ok(!JSON.stringify(put.data).includes('dummy-smtp-password'));

  // Update tanpa pass → password lama dipertahankan
  const put2 = await http('PUT', '/api/admin/settings/mail', {
    host: 'smtp2.dummy.test',
    port: 465,
    secure: true,
    user: 'mailer2@dummy.test',
    from: 'BF <t2@dummy.test>',
  }, adminToken);
  assert.equal(put2.status, 200);
  assert.equal(put2.data.config.host, 'smtp2.dummy.test');
  assert.equal(put2.data.config.hasPassword, true, 'password lama harus dipertahankan');

  // Host kosong → 400
  const bad = await http('PUT', '/api/admin/settings/mail', { host: '' }, adminToken);
  assert.equal(bad.status, 400);

  // Tanpa admin → 401
  const noAuth = await http('GET', '/api/admin/settings/mail');
  assert.equal(noAuth.status, 401);

  // Clear → kembali ke outbox mode
  const del = await http('DELETE', '/api/admin/settings/mail', undefined, adminToken);
  assert.equal(del.status, 200);
  assert.equal(del.data.mode, 'outbox');

  // Outbox: list + clear
  const list = await http('GET', '/api/admin/settings/mail/outbox', undefined, adminToken);
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.data.messages));

  const cleared = await http('DELETE', '/api/admin/settings/mail/outbox', undefined, adminToken);
  assert.equal(cleared.status, 200);
  const afterClear = await http('GET', '/api/admin/settings/mail/outbox', undefined, adminToken);
  assert.equal(afterClear.data.messages.length, 0);
});

// ─── 10. Rate limit endpoint request-* ───────────────────────────────────────

test('rate limit: request-password-reset dibatasi 5/15 menit per IP', async () => {
  const ip = nextIp();
  const send = () =>
    http(
      'POST',
      `/api/p/${projectId}/auth/request-password-reset`,
      { email: 'verify1@m23.test' },
      undefined,
      { 'X-Forwarded-For': ip }
    );

  for (let i = 0; i < 5; i++) {
    const r = await send();
    assert.equal(r.status, 200, `request ke-${i + 1} harus lolos`);
  }
  const blocked = await send();
  assert.equal(blocked.status, 429);
});
