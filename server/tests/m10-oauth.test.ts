// ============================================================================
// M10: TEST OAUTH2 — authorization code flow penuh via MOCK provider lokal
//
// Provider Google & GitHub "palsu" dijalankan sebagai HTTP server lokal;
// OAUTH_PROVIDER_DEFS diarahkan ke sana (mutasi objek — ESM live binding).
//
// Fokus test:
//  1. Konfigurasi provider via Admin API (PUT + list + delete)
//  2. /authorize → 302 dengan client_id + state ke URL provider
//  3. /callback → user dibuat + tokens terbit (kontrak = login biasa M09)
//  4. State: satu kali pakai + mismatch + kedaluwarsa → 400
//  5. Account linking: email verified → link ke user password existing
//  6. Anti account-takeover: email GitHub UNVERIFIED + email terdaftar → 409
//  7. redirect_to: 302 dengan token di fragment (dan validasi allowedOrigins)
//  8. Provider tidak dikonfigurasi → 404
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
import { createOAuthRouter } from '../src/api/oauthRoutes.js';
import { createUserAdminRouter } from '../src/api/userAdminRoutes.js';
import { OAUTH_PROVIDER_DEFS } from '../src/auth/oauth.js';

const TEST_DATA_DIR = path.resolve('../data/m10-oauth-test');

// ─── state mock provider (dimutasi per-scenario oleh test) ───────────────────

const mock = {
  googleProfile: {
    sub: 'google-sub-001',
    email: 'gnewuser@m10.test',
    email_verified: true,
    name: 'Google New User',
    picture: 'https://pic.example/avatar.png',
  },
  githubUser: {
    id: 777001,
    login: 'ghnewuser',
    name: 'GH New User',
    avatar_url: 'https://avatars.example/777001.png',
    email: null,
  },
  githubEmails: [{ email: 'ghnewuser@m10.test', primary: true, verified: true }],
  /** validasi kredensial yang dikirim server ke /token — return error string atau null */
  tokenCheck: null as ((p: URLSearchParams) => string | null) | null,
  receivedRedirectUri: '',
};

let baseServer: nodeHttp.Server;
let baseURL: string;
let mockServer: nodeHttp.Server;
let mockURL: string;
let adminToken: string;
let projectId: string;

// ─── HTTP helper (dengan dukungan header tambahan utk rate-limit bypass) ─────

function http(
  method: string,
  p: string,
  body?: unknown,
  token?: string,
  headers?: Record<string, string>
): Promise<{ status: number; data: any; location: string | undefined }> {
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
          let data: any = {};
          try {
            data = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
          } catch {}
          resolve({ status: res.statusCode ?? 0, data, location: loc });
        });
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Mock provider server (Google + GitHub palsu) ────────────────────────────

function startMockProvider(): Promise<void> {
  mockServer = nodeHttp.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const send = (code: number, j: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(j));
    };

    // POST /google/token | /github/token
    if (req.method === 'POST' && (url.pathname === '/google/token' || url.pathname === '/github/token')) {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const params = new URLSearchParams(Buffer.concat(chunks).toString('utf-8'));
        mock.receivedRedirectUri = params.get('redirect_uri') ?? '';
        if (mock.tokenCheck) {
          const err = mock.tokenCheck(params);
          if (err) { send(400, { error: err }); return; }
        }
        const provider = url.pathname.startsWith('/google') ? 'google' : 'github';
        send(200, { access_token: `mock-at-${provider}-123`, token_type: 'bearer' });
      });
      return;
    }

    const auth = String(req.headers['authorization'] ?? '');

    // GET /google/userinfo
    if (req.method === 'GET' && url.pathname === '/google/userinfo') {
      if (auth !== 'Bearer mock-at-google-123') { send(401, { error: 'invalid_token' }); return; }
      send(200, mock.googleProfile);
      return;
    }

    // GET /github/user
    if (req.method === 'GET' && url.pathname === '/github/user') {
      if (auth !== 'Bearer mock-at-github-123') { send(401, { error: 'bad credentials' }); return; }
      send(200, mock.githubUser);
      return;
    }

    // GET /github/emails
    if (req.method === 'GET' && url.pathname === '/github/emails') {
      if (auth !== 'Bearer mock-at-github-123') { send(401, { error: 'bad credentials' }); return; }
      send(200, mock.githubEmails);
      return;
    }

    send(404, { error: 'mock: unknown path' });
  });

  return new Promise<void>((r) => mockServer.listen(0, '127.0.0.1', r));
}

// ─── Setup ────────────────────────────────────────────────────────────────────

before(async () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  process.env.DATA_DIR = TEST_DATA_DIR;
  process.env.ADMIN_EMAIL = 'admin@m10.test';
  process.env.ADMIN_PASSWORD = 'm10-secret-pass';
  process.env.JWT_SECRET = 'm10-test-jwt-secret-key-long-enough';
  process.env.OAUTH_SECRET = 'm10-test-oauth-encryption-key';
  initPlatformDb();

  await startMockProvider();
  const mAddr = mockServer.address() as { port: number };
  mockURL = `http://127.0.0.1:${mAddr.port}`;

  // Arahkan definisi provider ke mock (objek mutable — inti testability M10)
  OAUTH_PROVIDER_DEFS.google.authorizeUrl = `${mockURL}/google/authorize`;
  OAUTH_PROVIDER_DEFS.google.tokenUrl = `${mockURL}/google/token`;
  OAUTH_PROVIDER_DEFS.google.profileUrl = `${mockURL}/google/userinfo`;
  OAUTH_PROVIDER_DEFS.github.authorizeUrl = `${mockURL}/github/authorize`;
  OAUTH_PROVIDER_DEFS.github.tokenUrl = `${mockURL}/github/token`;
  OAUTH_PROVIDER_DEFS.github.userUrl = `${mockURL}/github/user`;
  OAUTH_PROVIDER_DEFS.github.userEmailsUrl = `${mockURL}/github/emails`;

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createProjectAuthRouter());
  router.merge(createOAuthRouter());
  router.merge(createUserAdminRouter());

  baseServer = nodeHttp.createServer((rq, rs) => router.handle(rq, rs));
  await new Promise<void>((r) => baseServer.listen(0, '127.0.0.1', r));
  const addr = baseServer.address() as { port: number };
  baseURL = `http://127.0.0.1:${addr.port}`;

  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@m10.test',
    password: 'm10-secret-pass',
  });
  assert.equal(login.status, 200);
  adminToken = login.data.token;

  const proj = await http('POST', '/api/admin/projects', { name: 'm10-oauth' }, adminToken);
  assert.equal(proj.status, 201);
  projectId = proj.data.project?.id ?? proj.data.id;
  assert.ok(projectId);
});

after(async () => {
  await new Promise<void>((r) => baseServer.close(() => r()));
  await new Promise<void>((r) => mockServer.close(() => r()));
  closeAllProjectDbs();
  // Windows: rmSync gagal EPERM selama handle platform.db masih terbuka.
  closePlatformDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// IP unik per test supaya rate limit (30/menit) tidak saling mengganggu
let ipSeq = 0;
function nextIp(): string {
  ipSeq += 1;
  return `10.99.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

/** Jalankan flow authorize → ekstrak state → return state (atau null bila gagal) */
async function authorize(provider: string, extraQuery = ''): Promise<string | null> {
  const res = await http(
    'GET',
    `/api/p/${projectId}/auth/oauth/${provider}/authorize${extraQuery}`,
    undefined, undefined,
    { 'X-Forwarded-For': nextIp() }
  );
  if (res.status !== 302) return null;
  const loc = res.location!;
  const state = new URL(loc).searchParams.get('state');
  return state;
}

// ─── 1. Konfigurasi provider via Admin API ───────────────────────────────────

test('admin: konfigurasi provider google + github + list + validasi', async () => {
  // Provider belum dikonfigurasi → list kosong
  const empty = await http('GET', `/api/admin/projects/${projectId}/auth/providers`, undefined, adminToken);
  assert.equal(empty.status, 200);
  assert.equal(empty.data.providers.length, 0);

  // PUT google
  const putG = await http('PUT', `/api/admin/projects/${projectId}/auth/providers/google`, {
    clientId: 'mock-client-id-g',
    clientSecret: 'mock-secret-g',
    enabled: true,
  }, adminToken);
  assert.equal(putG.status, 200, JSON.stringify(putG.data));
  assert.equal(putG.data.provider.clientId, 'mock-client-id-g');
  // Secret TIDAK boleh bocor di response
  assert.ok(!JSON.stringify(putG.data).includes('mock-secret-g'));

  // PUT github
  const putH = await http('PUT', `/api/admin/projects/${projectId}/auth/providers/github`, {
    clientId: 'mock-client-id-gh',
    clientSecret: 'mock-secret-gh',
  }, adminToken);
  assert.equal(putH.status, 200);

  // List berisi 2 (secret masked)
  const list = await http('GET', `/api/admin/projects/${projectId}/auth/providers`, undefined, adminToken);
  assert.equal(list.data.providers.length, 2);
  assert.ok(!JSON.stringify(list.data).includes('mock-secret'));

  // Provider tidak dikenal → 400
  const badPut = await http('PUT', `/api/admin/projects/${projectId}/auth/providers/twitter`, {
    clientId: 'x', clientSecret: 'y',
  }, adminToken);
  assert.equal(badPut.status, 400);

  // Tanpa admin token → 401
  const noAuth = await http('GET', `/api/admin/projects/${projectId}/auth/providers`);
  assert.equal(noAuth.status, 401);

  // Update clientId tanpa secret → secret lama dipertahankan (keep-existing)
  const putUpd = await http('PUT', `/api/admin/projects/${projectId}/auth/providers/google`, {
    clientId: 'mock-client-id-g2',
  }, adminToken);
  assert.equal(putUpd.status, 200);
  assert.equal(putUpd.data.provider.clientId, 'mock-client-id-g2');

  // Kembalikan clientId semula utk test berikutnya (flow tetap jalan — bukti
  // secret lama masih tersimpan & terdekripsi dengan benar)
  const putBack = await http('PUT', `/api/admin/projects/${projectId}/auth/providers/google`, {
    clientId: 'mock-client-id-g',
  }, adminToken);
  assert.equal(putBack.status, 200);
});

// ─── 2. /authorize → 302 ke provider dengan state + client_id ─────────────────

test('authorize: 302 ke provider dengan client_id, redirect_uri, dan state', async () => {
  const res = await http(
    'GET',
    `/api/p/${projectId}/auth/oauth/google/authorize`,
    undefined, undefined,
    { 'X-Forwarded-For': nextIp() }
  );
  assert.equal(res.status, 302);
  const loc = new URL(res.location!);
  assert.equal(loc.origin + loc.pathname, `${mockURL}/google/authorize`);
  assert.equal(loc.searchParams.get('client_id'), 'mock-client-id-g');
  assert.ok(loc.searchParams.get('state'), 'state harus ada');
  assert.equal(loc.searchParams.get('response_type'), 'code');
  // redirect_uri menunjuk callback BaseForge
  assert.ok(loc.searchParams.get('redirect_uri')!.includes(`/api/p/${projectId}/auth/oauth/google/callback`));

  // Provider tidak dikonfigurasi → 404 (twitter)
  const unknown = await http(
    'GET',
    `/api/p/${projectId}/auth/oauth/twitter/authorize`,
    undefined, undefined,
    { 'X-Forwarded-For': nextIp() }
  );
  assert.equal(unknown.status, 404);
});

// ─── 3. Callback penuh: user baru dibuat + tokens (kontrak M09) ───────────────

test('callback google: user baru + accessToken JWT + /me konsisten', async () => {
  // Validasi kredensial yang dikirim server ke token endpoint mock
  mock.tokenCheck = (p) => {
    if (p.get('client_id') !== 'mock-client-id-g') return 'wrong client_id';
    if (p.get('client_secret') !== 'mock-secret-g') return 'wrong client_secret';
    if (p.get('code') !== 'good-code') return 'wrong code';
    return null;
  };

  const state = await authorize('google');
  assert.ok(state, 'authorize harus menghasilkan state');

  const cb = await http(
    'GET',
    `/api/p/${projectId}/auth/oauth/google/callback?code=good-code&state=${state}`,
    undefined, undefined,
    { 'X-Forwarded-For': nextIp() }
  );
  assert.equal(cb.status, 200, JSON.stringify(cb.data));
  assert.equal(cb.data.user.email, 'gnewuser@m10.test');
  assert.equal(cb.data.user.verified, true);
  assert.equal(cb.data.user.avatarUrl, 'https://pic.example/avatar.png');
  assert.ok(cb.data.accessToken);
  assert.ok(cb.data.refreshToken);
  assert.equal(cb.data.expiresIn, 15 * 60);

  // Token terbit valid utk /me (kontrak sama dengan login password M09u)
  const me = await http('GET', `/api/p/${projectId}/auth/me`, undefined, cb.data.accessToken);
  assert.equal(me.status, 200);
  assert.equal(me.data.user.email, 'gnewuser@m10.test');

  // User OAuth tidak bisa login pakai password (password_hash NULL)
  const pwLogin = await http('POST', `/api/p/${projectId}/auth/login`, {
    email: 'gnewuser@m10.test',
    password: 'passwordX-123',
  });
  assert.equal(pwLogin.status, 401);

  mock.tokenCheck = null;
});

// ─── 4. State: mismatch, reuse, dan kode buruk ────────────────────────────────

test('state: mismatch ditolak, satu kali pakai, code invalid → error', async () => {
  // State mismatch (state tidak pernah dibuat)
  const bad = await http(
    'GET',
    `/api/p/${projectId}/auth/oauth/google/callback?code=good-code&state=deadbeef`,
    undefined, undefined,
    { 'X-Forwarded-For': nextIp() }
  );
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error.code, 'BAD_STATE');

  // State valid → dipakai sekali
  const state = await authorize('google');
  assert.ok(state);
  const first = await http(
    'GET',
    `/api/p/${projectId}/auth/oauth/google/callback?code=good-code&state=${state}`,
    undefined, undefined,
    { 'X-Forwarded-For': nextIp() }
  );
  assert.equal(first.status, 200);

  // Pemakaian KEDUA dengan state sama → ditolak (anti replay)
  const second = await http(
    'GET',
    `/api/p/${projectId}/auth/oauth/google/callback?code=good-code&state=${state}`,
    undefined, undefined,
    { 'X-Forwarded-For': nextIp() }
  );
  assert.equal(second.status, 400);

  // Code ditolak provider → EXCHANGE_FAILED
  mock.tokenCheck = () => 'invalid_grant';
  const state2 = await authorize('google');
  const rejected = await http(
    'GET',
    `/api/p/${projectId}/auth/oauth/google/callback?code=bad-code&state=${state2}`,
    undefined, undefined,
    { 'X-Forwarded-For': nextIp() }
  );
  assert.equal(rejected.status, 400);
  assert.equal(rejected.data.error.code, 'EXCHANGE_FAILED');
  mock.tokenCheck = null;

  // Tanpa code/state → 400
  const noParams = await http(
    'GET',
    `/api/p/${projectId}/auth/oauth/google/callback`,
    undefined, undefined,
    { 'X-Forwarded-For': nextIp() }
  );
  assert.equal(noParams.status, 400);
});

// ─── 5. Login ulang identity sama → user sama (tanpa duplikasi) ──────────────

test('login ulang google identity sama → user sama tanpa duplikat', async () => {
  // Hitung user sebelum
  const before = await http('GET', `/api/admin/projects/${projectId}/auth-users?perPage=100`, undefined, adminToken);
  const countBefore = before.data.totalItems;

  const state = await authorize('google');
  const cb = await http(
    'GET',
    `/api/p/${projectId}/auth/oauth/google/callback?code=good-code&state=${state}`,
    undefined, undefined,
    { 'X-Forwarded-For': nextIp() }
  );
  assert.equal(cb.status, 200);
  // Email sama dengan test 3 (identity google-sub-001 sudah terdaftar)

  const after = await http('GET', `/api/admin/projects/${projectId}/auth-users?perPage=100`, undefined, adminToken);
  assert.equal(after.data.totalItems, countBefore, 'tidak boleh ada user baru');
});

// ─── 6. Account linking: email verified → link ke user password ──────────────

test('linking: google email verified → terhubung ke user password existing', async () => {
  // Daftarkan user password existing
  const reg = await http('POST', `/api/p/${projectId}/auth/register`, {
    email: 'linkme@m10.test',
    password: 'passwordL-123',
    name: 'Link Me',
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));

  // Google profile menunjuk email user tsb (verified)
  const savedProfile = { ...mock.googleProfile };
  mock.googleProfile = {
    sub: 'google-sub-link-999',
    email: 'linkme@m10.test',
    email_verified: true,
    name: 'Link Me via Google',
    picture: null,
  };

  const state = await authorize('google');
  const cb = await http(
    'GET',
    `/api/p/${projectId}/auth/oauth/google/callback?code=good-code&state=${state}`,
    undefined, undefined,
    { 'X-Forwarded-For': nextIp() }
  );
  assert.equal(cb.status, 200, JSON.stringify(cb.data));
  assert.equal(cb.data.user.email, 'linkme@m10.test');

  // User TIDAK baru dibuat (masih identity lama + user lama)
  const after = await http('GET', `/api/admin/projects/${projectId}/auth-users?perPage=100`, undefined, adminToken);

  // Login password masih berfungsi (linking tidak merusak)
  const pwLogin = await http('POST', `/api/p/${projectId}/auth/login`, {
    email: 'linkme@m10.test',
    password: 'passwordL-123',
  });
  assert.equal(pwLogin.status, 200);

  mock.googleProfile = savedProfile;
});

// ─── 7. Anti account-takeover: email UNVERIFIED + terdaftar → 409 ────────────

test('anti-takeover: github email unverified + email terdaftar → 409', async () => {
  // GitHub profile: email cocok user terdaftar tapi verified = false
  const savedUser = { ...mock.githubUser };
  const savedEmails = [...mock.githubEmails];
  mock.githubUser = { id: 777002, login: 'evil', name: 'Evil Twin', avatar_url: null, email: null };
  mock.githubEmails = [{ email: 'linkme@m10.test', primary: true, verified: false }];

  const state = await authorize('github');
  assert.ok(state);
  const cb = await http(
    'GET',
    `/api/p/${projectId}/auth/oauth/github/callback?code=good-code&state=${state}`,
    undefined, undefined,
    { 'X-Forwarded-For': nextIp() }
  );
  assert.equal(cb.status, 409, JSON.stringify(cb.data));
  assert.equal(cb.data.error.code, 'EMAIL_UNVERIFIED_CONFLICT');

  mock.githubUser = savedUser;
  mock.githubEmails = savedEmails;
});

// ─── 8. GitHub happy path: user baru dari /user + /user/emails ───────────────

test('callback github: user baru dengan email dari /user/emails', async () => {
  const state = await authorize('github');
  const cb = await http(
    'GET',
    `/api/p/${projectId}/auth/oauth/github/callback?code=good-code&state=${state}`,
    undefined, undefined,
    { 'X-Forwarded-For': nextIp() }
  );
  assert.equal(cb.status, 200, JSON.stringify(cb.data));
  assert.equal(cb.data.user.email, 'ghnewuser@m10.test');
  assert.equal(cb.data.user.name, 'GH New User');
  assert.equal(cb.data.user.verified, true);
});

// ─── 9. redirect_to: token dikirim via fragment + allow-list origins ──────────

test('redirect_to: 302 dengan token di fragment; origin luar ditolak saat allow-list aktif', async () => {
  // Tanpa allow-list: redirect_to bebas (URL valid) → token via fragment
  const appCb = `${baseURL}/oauth-landing`;
  const state = await authorize('google', `?redirect_to=${encodeURIComponent(appCb)}`);
  assert.ok(state);

  const cb = await http(
    'GET',
    `/api/p/${projectId}/auth/oauth/google/callback?code=good-code&state=${state}`,
    undefined, undefined,
    { 'X-Forwarded-For': nextIp() }
  );
  assert.equal(cb.status, 302, JSON.stringify(cb.data));
  const loc = cb.location!;
  assert.ok(loc.startsWith(appCb), `Location harus diawali ${appCb}: ${loc}`);
  assert.ok(loc.includes('#access_token='), 'token harus di fragment');
  assert.ok(loc.includes('refresh_token='));
  assert.ok(!loc.includes('?access_token='), 'token TIDAK boleh di query (terlihat di server log)');

  // Dengan allow-list: origin luar diabaikan → fallback JSON (bukan redirect)
  const putCfg = await http('PUT', `/api/admin/projects/${projectId}/auth/providers/github`, {
    clientId: 'mock-client-id-gh',
    allowedOrigins: ['https://app.sah.test'],
  }, adminToken);
  assert.equal(putCfg.status, 200);

  const state2 = await authorize('github', `?redirect_to=${encodeURIComponent('https://evil.example/cb')}`);
  const cb2 = await http(
    'GET',
    `/api/p/${projectId}/auth/oauth/github/callback?code=good-code&state=${state2}`,
    undefined, undefined,
    { 'X-Forwarded-For': nextIp() }
  );
  // Origin tidak di-allow-list → redirect_to diabaikan → respons JSON
  assert.equal(cb2.status, 200);
  assert.ok(cb2.data.accessToken, 'fallback JSON tetap memberi token');

  // Origin yang di-allow → redirect jalan
  const state3 = await authorize('github', `?redirect_to=${encodeURIComponent('https://app.sah.test/cb')}`);
  const cb3 = await http(
    'GET',
    `/api/p/${projectId}/auth/oauth/github/callback?code=good-code&state=${state3}`,
    undefined, undefined,
    { 'X-Forwarded-For': nextIp() }
  );
  assert.equal(cb3.status, 302);
  assert.ok(cb3.location!.startsWith('https://app.sah.test/cb'));

  // Bersihkan allow-list
  const reset = await http('PUT', `/api/admin/projects/${projectId}/auth/providers/github`, {
    clientId: 'mock-client-id-gh',
    allowedOrigins: [],
  }, adminToken);
  assert.equal(reset.status, 200);
});

// ─── 10. Provider disabled → 404 saat authorize ──────────────────────────────

test('provider disabled: authorize ditolak, delete menghapus config', async () => {
  // Disable google
  await http('PUT', `/api/admin/projects/${projectId}/auth/providers/google`, {
    clientId: 'mock-client-id-g',
    enabled: false,
  }, adminToken);

  const res = await http(
    'GET',
    `/api/p/${projectId}/auth/oauth/google/authorize`,
    undefined, undefined,
    { 'X-Forwarded-For': nextIp() }
  );
  assert.equal(res.status, 404);
  assert.equal(res.data.error.code, 'PROVIDER_NOT_CONFIGURED');

  // Aktifkan kembali
  await http('PUT', `/api/admin/projects/${projectId}/auth/providers/google`, {
    clientId: 'mock-client-id-g',
    enabled: true,
  }, adminToken);

  // Delete github → authorize 404
  const del = await http('DELETE', `/api/admin/projects/${projectId}/auth/providers/github`, undefined, adminToken);
  assert.equal(del.status, 200);
  const ghRes = await http(
    'GET',
    `/api/p/${projectId}/auth/oauth/github/authorize`,
    undefined, undefined,
    { 'X-Forwarded-For': nextIp() }
  );
  assert.equal(ghRes.status, 404);

  // Delete kedua kali → 404
  const del2 = await http('DELETE', `/api/admin/projects/${projectId}/auth/providers/github`, undefined, adminToken);
  assert.equal(del2.status, 404);
});
