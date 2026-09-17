// ============================================================================
// M37: TEST AUTH AUTO-REFRESH — 401 → refresh → retry → 200
//
// PENTING: collection HARUS punya rules yang butuh auth (bukan public),
// kalau tidak server tidak akan return 401 untuk invalid token.
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'path';
import nodeHttp from 'node:http';
import { initPlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { Router } from '../src/core/router.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';
import { createPublicRouter } from '../src/api/publicRoutes.js';
import { createProjectAuthRouter } from '../src/api/authRoutes.js';

const TEST_DATA_DIR = path.resolve('../data/m37-refresh-test');

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
  process.env.ADMIN_EMAIL = 'admin@m37.test';
  process.env.ADMIN_PASSWORD = 'm37-secret-pass';
  process.env.JWT_SECRET = 'm37-test-jwt-secret-key-short';
  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());
  router.merge(createPublicRouter());
  router.merge(createProjectAuthRouter());

  server = nodeHttp.createServer((rq, rs) => router.handle(rq, rs));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@m37.test',
    password: 'm37-secret-pass',
  });
  adminToken = login.data.token;

  const proj = await http('POST', '/api/admin/projects', { name: 'm37-refresh' }, adminToken);
  projectId = proj.data.project.id;

  // Collection dengan AUTH-REQUIRED rules (listRule references @request.auth)
  const col = await http(
    'POST',
    `/api/admin/projects/${projectId}/collections`,
    {
      name: 'secrets',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'owner', type: 'text' },
      ],
      rules: {
        listRule: 'owner = @request.auth.id',
        viewRule: 'owner = @request.auth.id',
        createRule: 'owner = @request.auth.id',
      },
    },
    adminToken
  );
  assert.equal(col.status, 201, `collection: ${JSON.stringify(col.data)}`);

  // Seed data (admin bypasses rules)
  await http(
    'POST',
    `/api/admin/projects/${projectId}/collections/secrets/records`,
    { title: 'secret 1', owner: 'seed' },
    adminToken
  );
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  closeAllProjectDbs();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const { BaseForge } = await import('../../packages/client/src/client.js');

async function setupUser(bf: InstanceType<typeof BaseForge>, email: string, password: string): Promise<void> {
  await http('POST', `/api/p/${projectId}/auth/register`, { email, password });
  await bf.auth.login(email, password);
}

function isSessionExpired(err: unknown): boolean {
  return err instanceof Error && err.message.includes('Session expired');
}

// ─── Test 1: Token expired → auto-refresh → retry → success ───────────────

test('auto-refresh: expired token → 401 → refresh → retry → /me returns user', async () => {
  const bf = new BaseForge({ baseUrl: baseURL, projectId });
  await setupUser(bf, 'alice@m37.test', 'passwordA-123');

  assert.ok(bf.authStore.token, 'access token stored');
  assert.ok(bf.authStore.refreshToken, 'refresh token stored');

  // /auth/me explicitly validates token → 200 with valid token
  const me1 = await bf.auth.me();
  assert.equal(me1.user.email, 'alice@m37.test', 'valid token → /me works');

  // ── Simulate token expiry: break access token, keep valid refresh ──
  const refreshToken = bf.authStore.refreshToken;
  bf.authStore.save('invalid-expired-token', refreshToken, bf.authStore.user);

  // ── /me with expired token → 401 → auto-refresh → retry → 200 ──
  const me2 = await bf.auth.me();
  assert.equal(me2.user.email, 'alice@m37.test', 'request succeeded after auto-refresh');
  assert.notEqual(bf.authStore.token, 'invalid-expired-token', 'token replaced');
  assert.ok(bf.authStore.token, 'new valid token stored');
});

// ─── Test 2: Refresh fails → clear authStore → SESSION_EXPIRED ─────────────

test('both tokens invalid → refresh fails → clear authStore → SESSION_EXPIRED', async () => {
  const bf = new BaseForge({ baseUrl: baseURL, projectId });
  await setupUser(bf, 'bob@m37.test', 'passwordB-123');

  // Break BOTH tokens
  bf.authStore.save('invalid-access', 'invalid-refresh', bf.authStore.user);

  let error: unknown = null;
  try {
    await bf.auth.me();
  } catch (e) {
    error = e;
  }

  assert.ok(error, 'should throw');
  assert.ok(isSessionExpired(error), `should be SESSION_EXPIRED: ${(error as Error).message}`);
  assert.ok(!bf.authStore.token, 'authStore cleared');
});

// ─── Test 3: No refreshToken → SESSION_EXPIRED ─────────────────────────────

test('no refreshToken → skip refresh → SESSION_EXPIRED', async () => {
  const bf = new BaseForge({ baseUrl: baseURL, projectId });
  bf.authStore.save('expired-no-refresh', null, null);

  let error: unknown = null;
  try {
    await bf.auth.me();
  } catch (e) {
    error = e;
  }

  assert.ok(error, 'should throw');
  assert.ok(isSessionExpired(error), 'should be SESSION_EXPIRED');
});

// ─── Test 4: Singleton lock — multiple 401s = one refresh ─────────────────

test('singleton lock: 3 simultaneous 401s → all succeed after 1 refresh', async () => {
  const bf = new BaseForge({ baseUrl: baseURL, projectId });
  await setupUser(bf, 'carol@m37.test', 'passwordC-123');

  const refresh = bf.authStore.refreshToken;
  bf.authStore.save('invalid-batch', refresh, bf.authStore.user);

  const results = await Promise.allSettled([
    bf.auth.me(),
    bf.auth.me(),
    bf.auth.me(),
  ]);

  for (const r of results) {
    assert.equal(r.status, 'fulfilled', `should succeed: ${r.status === 'rejected' ? r.reason?.message : 'ok'}`);
  }
  assert.notEqual(bf.authStore.token, 'invalid-batch', 'token refreshed');
});

// ─── Test 5: Refresh endpoint itself doesn't loop ─────────────────────────

test('refresh endpoint: invalid refresh → error (no infinite loop)', async () => {
  const bf = new BaseForge({ baseUrl: baseURL, projectId });
  bf.authStore.save(null, 'totally-invalid-refresh', null);

  let error: unknown = null;
  try {
    await bf.auth.refresh();
  } catch (e) {
    error = e;
  }

  assert.ok(error, 'should throw');
  assert.ok(error instanceof Error);
  assert.ok(!isSessionExpired(error), 'refresh error, NOT SESSION_EXPIRED (no loop)');
});
