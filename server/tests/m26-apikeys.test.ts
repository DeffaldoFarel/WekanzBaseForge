// ============================================================================
// M26: TEST PER-PROJECT API KEYS
//
// Fokus test:
//  1. Create via admin API → full key sekali (bf_...); list menampilkan MASKED
//  2. Key BYPASS API Rules (listRule ketat tetap terbaca — perilaku service)
//  3. Scope: read = GET OK / POST 403; write = POST/PATCH/DELETE OK
//  4. Key invalid → 401; revoked → 401
//  5. X-API-Key header juga bekerja
//  6. Key tidak berlaku di auth-refresh (401) — flow end-user murni
//  7. Isolasi: key project A tidak valid di project B
//  8. Usage tracking real-time (merge buffer) + requests counter
//  9. Rate limit per key (300/menit — 301st → 429)
// 10. File terproteksi via key (read scope → bypass)
// 11. Admin endpoint butuh requireAdmin
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
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';
import { createPublicRouter } from '../src/api/publicRoutes.js';
import { createProjectAuthRouter } from '../src/api/authRoutes.js';
import { createApiKeyRouter } from '../src/api/apiKeyRoutes.js';
import { createStorageRouter } from '../src/api/storageRoutes.js';

const TEST_DATA_DIR = path.resolve('../data/m26-keys-test');

let server: nodeHttp.Server;
let baseURL: string;
let adminToken: string;
let projectIdA: string;
let projectIdB: string;

function http(
  method: string,
  p: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ status: number; data: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request(
      new URL(p, baseURL),
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let data: any = {};
          try {
            data = JSON.parse(raw || '{}');
          } catch {}
          resolve({ status: res.statusCode ?? 0, data, raw });
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
  process.env.ADMIN_EMAIL = 'admin@m26.test';
  process.env.ADMIN_PASSWORD = 'm26-secret-pass';
  process.env.JWT_SECRET = 'm26-test-jwt-secret-key-long-enough';
  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());
  router.merge(createPublicRouter());
  router.merge(createProjectAuthRouter());
  router.merge(createApiKeyRouter());
  router.merge(createStorageRouter());

  server = nodeHttp.createServer((rq, rs) => router.handle(rq, rs));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  baseURL = `http://127.0.0.1:${addr.port}`;

  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@m26.test',
    password: 'm26-secret-pass',
  });
  assert.equal(login.status, 200);
  adminToken = login.data.token;

  // Project A + collection dengan rules KETAT (private) + data
  const projA = await http('POST', '/api/admin/projects', { name: 'm26-a' }, { Authorization: `Bearer ${adminToken}` });
  assert.equal(projA.status, 201);
  projectIdA = projA.data.project?.id ?? projA.data.id;

  const colA = await http(
    'POST',
    `/api/admin/projects/${projectIdA}/collections`,
    {
      name: 'secrets',
      fields: [{ name: 'title', type: 'text' }, { name: 'owner', type: 'text' }],
      rules: {
        listRule: 'owner = @request.auth.id',
        viewRule: 'owner = @request.auth.id',
        createRule: 'owner = @request.auth.id',
      },
    },
    { Authorization: `Bearer ${adminToken}` }
  );
  assert.equal(colA.status, 201, JSON.stringify(colA.data));

  // Seed 1 record (via admin API)
  const seed = await http(
    'POST',
    `/api/admin/projects/${projectIdA}/collections/secrets/records`,
    { title: 'classified', owner: 'someone-else' },
    { Authorization: `Bearer ${adminToken}` }
  );
  assert.equal(seed.status, 201);

  // Project B (isolasi)
  const projB = await http('POST', '/api/admin/projects', { name: 'm26-b' }, { Authorization: `Bearer ${adminToken}` });
  assert.equal(projB.status, 201);
  projectIdB = projB.data.project?.id ?? projB.data.id;
  const colB = await http(
    'POST',
    `/api/admin/projects/${projectIdB}/collections`,
    { name: 'secrets', fields: [{ name: 'title', type: 'text' }, { name: 'owner', type: 'text' }], rules: { listRule: 'owner = @request.auth.id' } },
    { Authorization: `Bearer ${adminToken}` }
  );
  assert.equal(colB.status, 201);

  // Auth collection utk test auth-refresh (key tidak boleh berlaku di sana)
  const usersCol = await http(
    'POST',
    `/api/admin/projects/${projectIdA}/collections`,
    { name: 'users', type: 'auth', fields: [] },
    { Authorization: `Bearer ${adminToken}` }
  );
  assert.equal(usersCol.status, 201, JSON.stringify(usersCol.data));
  const seedUser = await http(
    'POST',
    `/api/admin/projects/${projectIdA}/collections/users/records`,
    { email: 'victim@m26.test', password: 'passwordV-123', passwordConfirm: 'passwordV-123' },
    { Authorization: `Bearer ${adminToken}` }
  );
  assert.equal(seedUser.status, 201, JSON.stringify(seedUser.data));
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  closeAllProjectDbs();
  // Windows: rmSync gagal EPERM selama handle platform.db masih terbuka.
  closePlatformDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

async function makeKey(pid: string, scope: 'read' | 'write', name?: string): Promise<string> {
  const res = await http(
    'POST',
    `/api/admin/projects/${pid}/api-keys`,
    { name: name ?? `test-${scope}`, scope },
    { Authorization: `Bearer ${adminToken}` }
  );
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.ok(res.data.key?.startsWith('bf_'), 'key harus berformat bf_...');
  return res.data.key as string;
}

// ─── 1. Create & masked list ──────────────────────────────────────────────────

test('create: full key sekali saja; list menampilkan hint masked', async () => {
  const created = await http(
    'POST',
    `/api/admin/projects/${projectIdA}/api-keys`,
    { name: 'integration key', scope: 'write' },
    { Authorization: `Bearer ${adminToken}` }
  );
  assert.equal(created.status, 201);
  assert.ok(created.data.key.startsWith('bf_'));
  assert.equal(created.data.apiKey.scope, 'write');
  assert.ok(created.data.apiKey.hint.startsWith('bf_'));
  assert.ok(!created.data.apiKey.hint.includes(created.data.key.slice(12, 30)), 'hint tidak boleh membocorkan tengah key');

  const list = await http('GET', `/api/admin/projects/${projectIdA}/api-keys`, undefined, {
    Authorization: `Bearer ${adminToken}`,
  });
  assert.equal(list.status, 200);
  const found = (list.data.keys as any[]).find((k) => k.name === 'integration key');
  assert.ok(found);
  assert.ok(!('key' in found) && !('key_hash' in found), 'list tidak boleh memuat key/hash');
});

// ─── 2. Bypass API Rules ──────────────────────────────────────────────────────

test('key BYPASS rules: collection ketat tetap terbaca (perilaku service key)', async () => {
  const key = await makeKey(projectIdA, 'read');

  // Anonymous → rules menutup (403/empty)
  const anon = await http('GET', `/api/p/${projectIdA}/collections/secrets/records`);
  assert.ok(anon.status === 403 || (anon.status === 200 && anon.data.items?.length === 0));

  // API key → bypass: record terlihat
  const withKey = await http('GET', `/api/p/${projectIdA}/collections/secrets/records`, undefined, {
    Authorization: `Bearer ${key}`,
  });
  assert.equal(withKey.status, 200, JSON.stringify(withKey.data));
  assert.equal(withKey.data.items.length, 1);
  assert.equal(withKey.data.items[0].title, 'classified');
});

// ─── 3. Scope enforcement ─────────────────────────────────────────────────────

test('scope: read key → GET ok, POST 403; write key → POST ok', async () => {
  const readKey = await makeKey(projectIdA, 'read');
  const writeKey = await makeKey(projectIdA, 'write');

  const getOk = await http('GET', `/api/p/${projectIdA}/collections/secrets/records`, undefined, {
    Authorization: `Bearer ${readKey}`,
  });
  assert.equal(getOk.status, 200);

  const postBlocked = await http(
    'POST',
    `/api/p/${projectIdA}/collections/secrets/records`,
    { title: 'x', owner: 'me' },
    { Authorization: `Bearer ${readKey}` }
  );
  assert.equal(postBlocked.status, 403);
  assert.equal(postBlocked.data.error.code, 'INSUFFICIENT_SCOPE');

  const postOk = await http(
    'POST',
    `/api/p/${projectIdA}/collections/secrets/records`,
    { title: 'by key', owner: 'service' },
    { Authorization: `Bearer ${writeKey}` }
  );
  assert.equal(postOk.status, 201, JSON.stringify(postOk.data));

  // PATCH + DELETE dengan write key
  const rid = postOk.data.record.id;
  const patch = await http(
    'PATCH',
    `/api/p/${projectIdA}/collections/secrets/records/${rid}`,
    { title: 'updated by key' },
    { Authorization: `Bearer ${writeKey}` }
  );
  assert.equal(patch.status, 200);
  const del = await http('DELETE', `/api/p/${projectIdA}/collections/secrets/records/${rid}`, undefined, {
    Authorization: `Bearer ${writeKey}`,
  });
  assert.equal(del.status, 200);
});

// ─── 4. Invalid & revoked ─────────────────────────────────────────────────────

test('key invalid → 401 INVALID_API_KEY', async () => {
  const r = await http('GET', `/api/p/${projectIdA}/collections/secrets/records`, undefined, {
    Authorization: 'Bearer bf_0000000000000000000000000000000000000000',
  });
  assert.equal(r.status, 401);
  assert.equal(r.data.error.code, 'INVALID_API_KEY');
});

test('revoked key → 401 (revocation langsung efektif)', async () => {
  const key = await makeKey(projectIdA, 'write', 'to-be-revoked');

  const before = await http('GET', `/api/p/${projectIdA}/collections/secrets/records`, undefined, {
    Authorization: `Bearer ${key}`,
  });
  assert.equal(before.status, 200);

  // Cari id dari list
  const list = await http('GET', `/api/admin/projects/${projectIdA}/api-keys`, undefined, {
    Authorization: `Bearer ${adminToken}`,
  });
  const entry = (list.data.keys as any[]).find((k) => k.name === 'to-be-revoked');
  const del = await http('DELETE', `/api/admin/projects/${projectIdA}/api-keys/${entry.id}`, undefined, {
    Authorization: `Bearer ${adminToken}`,
  });
  assert.equal(del.status, 200);

  const after = await http('GET', `/api/p/${projectIdA}/collections/secrets/records`, undefined, {
    Authorization: `Bearer ${key}`,
  });
  assert.equal(after.status, 401);

  // Delete kedua kali → 404
  const del2 = await http('DELETE', `/api/admin/projects/${projectIdA}/api-keys/${entry.id}`, undefined, {
    Authorization: `Bearer ${adminToken}`,
  });
  assert.equal(del2.status, 404);
});

// ─── 5. X-API-Key header ──────────────────────────────────────────────────────

test('X-API-Key header juga berlaku (alternatif Bearer)', async () => {
  const key = await makeKey(projectIdA, 'read');
  const r = await http('GET', `/api/p/${projectIdA}/collections/secrets/records`, undefined, {
    'X-API-Key': key,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.items.length, 1);
});

// ─── 6. Tidak berlaku di auth flow ────────────────────────────────────────────

// Tahap 4: endpoint auth-collection dihapus; padanannya di platform auth adalah
// GET /auth/me. Niat uji tetap sama — API key BUKAN identitas end-user, jadi
// memakainya di flow auth harus ditolak 401, bukan diperlakukan sebagai user.
test('key TIDAK valid untuk flow auth end-user (GET /auth/me) → 401', async () => {
  const key = await makeKey(projectIdA, 'write');
  const r = await http(
    'GET',
    `/api/p/${projectIdA}/auth/me`,
    undefined,
    { Authorization: `Bearer ${key}` }
  );
  assert.equal(r.status, 401, JSON.stringify(r.data));
});

// ─── 7. Isolasi antar project ─────────────────────────────────────────────────

test('key project A tidak berlaku di project B', async () => {
  const keyA = await makeKey(projectIdA, 'read');
  const r = await http('GET', `/api/p/${projectIdB}/collections/secrets/records`, undefined, {
    Authorization: `Bearer ${keyA}`,
  });
  assert.equal(r.status, 401);
  assert.equal(r.data.error.code, 'INVALID_API_KEY');
});

// ─── 8. Usage tracking real-time ──────────────────────────────────────────────

test('usage: requests counter + lastUsed real-time (merge buffer)', async () => {
  const key = await makeKey(projectIdA, 'read', 'usage-check');

  // 3 request pakai key
  for (let i = 0; i < 3; i++) {
    await http('GET', `/api/p/${projectIdA}/collections/secrets/records`, undefined, {
      Authorization: `Bearer ${key}`,
    });
  }

  const list = await http('GET', `/api/admin/projects/${projectIdA}/api-keys`, undefined, {
    Authorization: `Bearer ${adminToken}`,
  });
  const entry = (list.data.keys as any[]).find((k) => k.name === 'usage-check');
  assert.ok(entry, 'key usage-check harus ada');
  assert.ok(entry.requests >= 3, `requests >= 3 (dapat ${entry.requests})`);
  assert.ok(entry.lastUsed, 'lastUsed terisi');
});

// ─── 9. Rate limit per key ────────────────────────────────────────────────────

test('rate limit: request ke-301 → 429 RATE_LIMITED', async () => {
  const key = await makeKey(projectIdA, 'read', 'rate-limit-check');
  const headers = { Authorization: `Bearer ${key}` };

  let lastStatus = 0;
  for (let i = 0; i < 301; i++) {
    const r = await http('GET', `/api/p/${projectIdA}/collections/secrets/records`, undefined, headers);
    lastStatus = r.status;
    if (r.status === 429) break;
  }
  assert.equal(lastStatus, 429, 'harus kena 429 sebelum/tepat request 301');
});

// ─── 10. Admin auth ───────────────────────────────────────────────────────────

test('admin endpoints: tanpa token → 401; scope invalid → 400', async () => {
  const noAuth = await http('GET', `/api/admin/projects/${projectIdA}/api-keys`);
  assert.equal(noAuth.status, 401);

  const badScope = await http(
    'POST',
    `/api/admin/projects/${projectIdA}/api-keys`,
    { scope: 'admin' },
    { Authorization: `Bearer ${adminToken}` }
  );
  assert.equal(badScope.status, 400);
});
