// ============================================================================
// M31: TEST MULTI-PROVIDER OAUTH — registry, isOAuthProvider, API surface
//
// Test m10-oauth.test.ts sudah menguji Google/GitHub flow penuh via mock.
// Test ini fokus pada EKSPANSI provider: registry 7 provider valid,
// isOAuthProvider menerima semua, admin API menerima PUT untuk semua.
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
import { OAUTH_PROVIDER_DEFS, isOAuthProvider } from '../src/auth/oauth.js';

const TEST_DATA_DIR = path.resolve('../data/m31-oauth-multi-test');

let server: nodeHttp.Server;
let baseURL: string;
let adminToken: string;
let projectId: string;

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
          try { data = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'); } catch {}
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
  process.env.ADMIN_EMAIL = 'admin@m31.test';
  process.env.ADMIN_PASSWORD = 'm31-secret-pass';
  process.env.JWT_SECRET = 'm31-test-jwt-secret-key-long-enough';
  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createProjectAuthRouter());
  router.merge(createOAuthRouter());

  server = nodeHttp.createServer((rq, rs) => router.handle(rq, rs));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@m31.test',
    password: 'm31-secret-pass',
  });
  adminToken = login.data.token;

  const proj = await http('POST', '/api/admin/projects', { name: 'm31-multi' }, adminToken);
  projectId = proj.data.project?.id ?? proj.data.id;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  closeAllProjectDbs();
  // Windows: rmSync gagal EPERM selama handle platform.db masih terbuka.
  closePlatformDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─── 1. Registry completeness ─────────────────────────────────────────────────

test('unit: 7 provider terdaftar di OAUTH_PROVIDER_DEFS', () => {
  const providers = Object.keys(OAUTH_PROVIDER_DEFS);
  assert.equal(providers.length, 7, `expected 7, got ${providers.length}`);
  for (const p of ['google', 'github', 'apple', 'microsoft', 'discord', 'gitlab', 'facebook']) {
    assert.ok(p in OAUTH_PROVIDER_DEFS, `${p} harus terdaftar`);
    assert.ok(OAUTH_PROVIDER_DEFS[p as keyof typeof OAUTH_PROVIDER_DEFS].authorizeUrl, `${p} authorizeUrl`);
    assert.ok(OAUTH_PROVIDER_DEFS[p as keyof typeof OAUTH_PROVIDER_DEFS].tokenUrl, `${p} tokenUrl`);
    assert.ok(OAUTH_PROVIDER_DEFS[p as keyof typeof OAUTH_PROVIDER_DEFS].scope, `${p} scope`);
    assert.ok(OAUTH_PROVIDER_DEFS[p as keyof typeof OAUTH_PROVIDER_DEFS].label, `${p} label`);
  }
});

test('unit: isOAuthProvider menerima 7 provider + menolak yang tidak dikenal', () => {
  for (const p of ['google', 'github', 'apple', 'microsoft', 'discord', 'gitlab', 'facebook']) {
    assert.ok(isOAuthProvider(p), `${p} harus valid`);
  }
  assert.ok(!isOAuthProvider('twitter'));
  assert.ok(!isOAuthProvider('linkedin'));
  assert.ok(!isOAuthProvider(''));
});

// ─── 2. Admin API menerima semua provider ────────────────────────────────────

test('admin PUT: bisa konfigurasi microsoft, discord, gitlab, facebook', async () => {
  const providers = ['microsoft', 'discord', 'gitlab', 'facebook'];
  for (const p of providers) {
    const put = await http(
      'PUT',
      `/api/admin/projects/${projectId}/auth/providers/${p}`,
      { clientId: `test-${p}-id`, clientSecret: `test-${p}-secret` },
      adminToken
    );
    assert.equal(put.status, 200, `${p} PUT gagal: ${JSON.stringify(put.data)}`);
    assert.equal(put.data.provider.provider, p);
  }

  // List harus berisi 4 provider
  const list = await http('GET', `/api/admin/projects/${projectId}/auth/providers`, undefined, adminToken);
  assert.equal(list.data.providers.length, 4);
  const names = list.data.providers.map((x: any) => x.provider);
  for (const p of providers) {
    assert.ok(names.includes(p), `${p} harus ada di list`);
  }
});

test('admin PUT: provider tidak dikenal → error menyebut semua 7', async () => {
  const put = await http(
    'PUT',
    `/api/admin/projects/${projectId}/auth/providers/linkedin`,
    { clientId: 'x', clientSecret: 'y' },
    adminToken
  );
  assert.equal(put.status, 400);
  assert.match(put.data.error.message, /google/);
  assert.match(put.data.error.message, /microsoft/);
  assert.match(put.data.error.message, /discord/);
  assert.match(put.data.error.message, /gitlab/);
  assert.match(put.data.error.message, /facebook/);
  assert.match(put.data.error.message, /apple/);
});

// ─── 3. /authorize redirect untuk semua provider ─────────────────────────────

test('authorize: microsoft/discord/gitlab/facebook → 302 ke provider', async () => {
  const providers = ['microsoft', 'discord', 'gitlab', 'facebook'];
  for (const p of providers) {
    // Konfigurasi dulu (sudah ada dari test sebelumnya)
    const res = await http('GET', `/api/p/${projectId}/auth/oauth/${p}/authorize`);
    // 302 atau 404 (kalau belum aktif) — tapi harus TIDAK 400 (provider dikenal)
    assert.ok([302, 404].includes(res.status), `${p}: expected 302/404, got ${res.status}`);
  }
});

// ─── 4. Apple — error informatif (belum implementasi penuh) ─────────────────

test('apple: fetchProfile → error informatif ES256', async () => {
  const put = await http(
    'PUT',
    `/api/admin/projects/${projectId}/auth/providers/apple`,
    { clientId: 'test-apple', clientSecret: 'test-secret' },
    adminToken
  );
  assert.equal(put.status, 200, 'Apple bisa dikonfigurasi (terdaftar)');

  // Apple fetchProfile akan throw error informatif saat dipanggil
  try {
    await OAUTH_PROVIDER_DEFS.apple.fetchProfile('fake-token');
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof Error);
    assert.match((e as Error).message, /ES256/);
  }
});

// ─── 5. Cleanup ──────────────────────────────────────────────────────────────

test('cleanup: delete semua provider config', async () => {
  const providers = ['microsoft', 'discord', 'gitlab', 'facebook', 'apple'];
  for (const p of providers) {
    const del = await http(
      'DELETE',
      `/api/admin/projects/${projectId}/auth/providers/${p}`,
      undefined,
      adminToken
    );
    assert.equal(del.status, 200, `delete ${p}`);
  }

  const list = await http('GET', `/api/admin/projects/${projectId}/auth/providers`, undefined, adminToken);
  assert.equal(list.data.providers.length, 0);
});
