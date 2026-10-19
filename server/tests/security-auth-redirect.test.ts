// ============================================================================
// SECURITY: redirect target validation — temuan audit FASE 1 (2026-10)
//
// AUD-1-03 — reset password token bocor via redirect_to bebas:
//   POST /auth/request-password-reset menerima redirectTo http(s) apa pun;
//   link di email korban membawa parameter itu, dan GET confirm-password-reset
//   me-redirect korban ke domain attacker dengan token di fragment:
//   302 https://evil.example/cb#reset_token=<token> → account takeover.
//   Probe lama: TERBUKTI. Kini target harus same-origin / AUTH_REDIRECT_ORIGINS.
//
// AUD-1-07 — verify-email open redirect (?verified=true) — pola yang sama,
//   tanpa token tapi jalan masuk phishing. Fix menyatu dengan AUD-1-03.
//
// AUD-1-04 — OAuth redirect_to: allow-list provider kosong (DEFAULT) berarti
//   SEMUA origin diizinkan → access+refresh token dikirim via fragment ke
//   domain mana pun. Kini: allow-list kosong → fallback same-origin/global,
//   sama seperti email flow.
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import nodeHttp from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { initPlatformDb, closePlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createProjectAuthRouter } from '../src/api/authRoutes.js';
import { createEmailRouter } from '../src/api/emailRoutes.js';
import { createOAuthRouter } from '../src/api/oauthRoutes.js';
import { OAUTH_PROVIDER_DEFS } from '../src/auth/oauth.js';
import { Router } from '../src/core/router.js';

let server: nodeHttp.Server;
let mockServer: nodeHttp.Server;
let baseURL = '';
let mockURL = '';
const TEST_DATA_DIR = path.resolve('../data/sec-auth-redir-test');

let pid: string;
let adminToken: string;
const savedGoogleDef = { ...OAUTH_PROVIDER_DEFS.google };

interface R { status: number; data: any; location: string | undefined; text: string }

function http(method: string, reqPath: string, body?: unknown, token?: string, extraHeaders?: Record<string, string>): Promise<R> {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, baseURL);
    const req = nodeHttp.request(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(extraHeaders ?? {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let data: any = null;
        try { data = JSON.parse(text); } catch { data = null; }
        resolve({ status: res.statusCode ?? 0, data, location: res.headers.location, text });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function outboxLink(to: string, fragment: string): Promise<string | null> {
  return http('GET', '/api/admin/settings/mail/outbox?limit=20', undefined, adminToken).then((r) => {
    const msgs: any[] = r.data?.messages ?? [];
    // listOutbox = newest-first; ambil pesan TERBARU milik penerima spesifik
    const msg = msgs.find(
      (m) => String(m.to ?? '').toLowerCase() === to.toLowerCase() && String(m.text ?? '').includes(fragment)
    );
    if (!msg) return null;
    return String(msg.text).match(/https?:\/\/\S+/)?.[0] ?? null;
  });
}

before(async () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  process.env.DATA_DIR = TEST_DATA_DIR;
  process.env.ADMIN_EMAIL = 'admin@test.local';
  process.env.ADMIN_PASSWORD = 'admin-test-pass';
  process.env.STORAGE_DIR = path.join(TEST_DATA_DIR, 'storage');
  delete process.env.AUTH_REDIRECT_ORIGINS;
  delete process.env.PUBLIC_BASE_URL;

  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createProjectAuthRouter());
  router.merge(createEmailRouter());
  router.merge(createOAuthRouter());

  server = nodeHttp.createServer((req, res) => { router.handle(req, res); });
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      baseURL = `http://localhost:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });

  // Mock provider Google lokal (pola m10): /token + /userinfo
  mockServer = nodeHttp.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (req.method === 'POST' && url.pathname === '/token') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'mock-access-token' }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/userinfo') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        sub: 'redirect-audit-sub-001',
        email: 'oauth@redirect.test',
        email_verified: true,
        name: 'Redirect Audit User',
      }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((resolve) => {
    mockServer.listen(0, () => {
      mockURL = `http://localhost:${(mockServer.address() as { port: number }).port}`;
      resolve();
    });
  });
  OAUTH_PROVIDER_DEFS.google.authorizeUrl = `${mockURL}/authorize`;
  OAUTH_PROVIDER_DEFS.google.tokenUrl = `${mockURL}/token`;
  OAUTH_PROVIDER_DEFS.google.profileUrl = `${mockURL}/userinfo`;

  const login = await http('POST', '/api/admin/auth/login', { email: 'admin@test.local', password: 'admin-test-pass' });
  adminToken = login.data.token;

  const proj = await http('POST', '/api/admin/projects', { name: 'sec-auth-redir' }, adminToken);
  pid = proj.data.project.id;

  await http('POST', `/api/p/${pid}/auth/register`, { email: 'victim@redir.test', password: 'victim-pass-123' });

  // Provider google aktif TANPA allow-list (konfigurasi default admin)
  const put = await http('PUT', `/api/admin/projects/${pid}/auth/providers/google`, {
    clientId: 'mock-client-id', clientSecret: 'mock-client-secret',
  }, adminToken);
  assert.equal(put.status, 200, JSON.stringify(put.data));
});

after(async () => {
  OAUTH_PROVIDER_DEFS.google.authorizeUrl = savedGoogleDef.authorizeUrl;
  OAUTH_PROVIDER_DEFS.google.tokenUrl = savedGoogleDef.tokenUrl;
  OAUTH_PROVIDER_DEFS.google.profileUrl = savedGoogleDef.profileUrl;
  delete process.env.AUTH_REDIRECT_ORIGINS;
  delete process.env.PUBLIC_BASE_URL;
  closeAllProjectDbs();
  closePlatformDb();
  server.close();
  mockServer.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

async function authorizeGoogle(redirectTo: string): Promise<string | undefined> {
  const r = await http('GET', `/api/p/${pid}/auth/oauth/google/authorize?redirect_to=${encodeURIComponent(redirectTo)}`);
  if (r.status !== 302) return undefined;
  return new URL(r.location!, mockURL).searchParams.get('state') ?? undefined;
}

test('AUD-1-03: reset link TIDAK membawa redirect_to cross-origin (token tidak bocor)', async () => {
  const req = await http('POST', `/api/p/${pid}/auth/request-password-reset`,
    { email: 'victim@redir.test', redirectTo: 'https://evil.example/cb' });
  assert.equal(req.status, 200, JSON.stringify(req.data));

  const link = await outboxLink('victim@redir.test', 'confirm-password-reset');
  assert.ok(link, 'email reset harus ada di outbox');
  // Link yang masuk email tidak boleh membawa redirect_to evil
  assert.ok(!link.includes('redirect_to='),
    `link email tidak boleh membawa redirect_to attacker: ${link}`);

  // Klik link → fallback aman: form HTML (200), BUKAN 302 ke evil
  const click = await http('GET', link.replace(baseURL, ''));
  assert.notEqual(click.status, 302, 'tidak boleh redirect (sebelumnya: 302 ke evil.example)');
  assert.equal(click.status, 200, 'harus jatuh ke form HTML aman');
  assert.ok(click.text.includes('Set a new password'), 'harus form reset self-contained');
});

test('AUD-1-03 regression: redirect_to same-origin tetap bekerja', async () => {
  const app = `${baseURL}/reset-page`;
  const req = await http('POST', `/api/p/${pid}/auth/request-password-reset`,
    { email: 'victim@redir.test', redirectTo: app });
  assert.equal(req.status, 200);

  const link = await outboxLink('victim@redir.test', 'confirm-password-reset');
  assert.ok(link, 'email reset harus ada');
  assert.ok(link.includes('redirect_to='), 'redirect_to same-origin harus dipertahankan di link');

  const click = await http('GET', link.replace(baseURL, ''));
  assert.equal(click.status, 302);
  assert.ok(click.location!.startsWith(app), `Location harus ${app}: ${click.location}`);
  assert.ok(click.location!.includes('#reset_token='));
});

test('AUD-1-03: AUTH_REDIRECT_ORIGINS mengizinkan origin eksternal terdaftar', async () => {
  process.env.AUTH_REDIRECT_ORIGINS = 'https://app.sah.test';
  const req = await http('POST', `/api/p/${pid}/auth/request-password-reset`,
    { email: 'victim@redir.test', redirectTo: 'https://app.sah.test/cb' });
  assert.equal(req.status, 200);

  const link = await outboxLink('victim@redir.test', 'confirm-password-reset');
  assert.ok(link, 'email reset harus ada');

  const click = await http('GET', link.replace(baseURL, ''));
  assert.equal(click.status, 302, JSON.stringify(click.text.slice(0, 120)));
  assert.ok(click.location!.startsWith('https://app.sah.test/cb#reset_token='),
    `origin terdaftar harus diizinkan: ${click.location}`);
  delete process.env.AUTH_REDIRECT_ORIGINS;
});

test('AUD-1-07: verify-email redirect cross-origin ditolak; same-origin tetap jalan', async () => {
  // User kedua untuk varian phishing (user pertama akan jadi verified oleh
  // klik link same-origin — verifikasi berikutnya tidak lagi mengirim email).
  const reg2 = await http('POST', `/api/p/${pid}/auth/register`, { email: 'victim2@redir.test', password: 'victim2-pass-123' });
  assert.equal(reg2.status, 201, JSON.stringify(reg2.data));

  // cross-origin → redirect phishing DITOLAK, fallback halaman HTML aman
  const reqEvil = await http('POST', `/api/p/${pid}/auth/request-verification`,
    { email: 'victim2@redir.test', redirectTo: 'https://phish.example/ok' });
  assert.equal(reqEvil.status, 200);
  const linkEvil = await outboxLink('victim2@redir.test', 'verify-email');
  assert.ok(linkEvil, 'email verifikasi harus ada di outbox');
  const clickEvil = await http('GET', linkEvil.replace(baseURL, ''));
  assert.notEqual(clickEvil.status, 302, 'phishing redirect harus ditolak (sebelumnya: 302 ke phish.example)');
  assert.equal(clickEvil.status, 200, 'harus jatuh ke halaman HTML aman');
  assert.ok(clickEvil.text.includes('verified'), 'halaman sukses verify tetap dirender');

  // same-origin (user pertama, belum verified) → tetap jalan
  const okSame = await http('POST', `/api/p/${pid}/auth/request-verification`,
    { email: 'victim@redir.test', redirectTo: `${baseURL}/verified-page` });
  assert.equal(okSame.status, 200);
  const linkSame = await outboxLink('victim@redir.test', 'verify-email');
  assert.ok(linkSame);
  const clickSame = await http('GET', linkSame.replace(baseURL, ''));
  assert.equal(clickSame.status, 302);
  assert.ok(clickSame.location!.startsWith(`${baseURL}/verified-page?verified=true`), String(clickSame.location));
});

test('AUD-1-04: OAuth redirect_to cross-origin tanpa allowlist → fallback JSON (token tidak bocor)', async () => {
  const state = await authorizeGoogle('https://evil.example/cb');
  assert.ok(state, 'authorize harus sukses');
  const cb = await http('GET', `/api/p/${pid}/auth/oauth/google/callback?code=good-code&state=${state}`);
  assert.equal(cb.status, 200, 'fallback JSON — bukan 302 (sebelumnya: 302 ke evil.example#access_token=...)');
  assert.ok(cb.data?.accessToken, 'login OAuth tetap berhasil (hanya redirect-nya yang ditolak)');
  assert.equal(cb.location, undefined, 'tidak boleh ada Location');
});

test('AUD-1-04 regression: OAuth redirect_to same-origin tetap 302 dengan token di fragment', async () => {
  const landing = `${baseURL}/oauth-landing`;
  const state = await authorizeGoogle(landing);
  assert.ok(state);
  const cb = await http('GET', `/api/p/${pid}/auth/oauth/google/callback?code=good-code&state=${state}`);
  assert.equal(cb.status, 302, JSON.stringify(cb.data));
  assert.ok(cb.location!.startsWith(landing), `Location harus ${landing}: ${cb.location}`);
  assert.ok(cb.location!.includes('#access_token='));
  assert.ok(!cb.location!.includes('?access_token='));
});
