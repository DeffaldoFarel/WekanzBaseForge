// ============================================================================
// M24: TEST METRICS — statistik request & bandwidth per project
//
// Alur: request lewat router → buffer in-memory → stats endpoint (real-time)
//   → flushMetrics() → stats endpoint masih benar (merge DB + buffer kosong)
//
// Fokus test:
//  1. Request public (/api/p/:pid) terhitung + bytesOut > 0
//  2. Request admin (/api/admin/projects/:pid) terhitung (dashboard traffic)
//  3. Isolasi antar project (A ≠ B)
//  4. Request non-project (/api/health) TIDAK diatribusikan
//  5. flushMetrics: data pindah ke DB, stats konsisten sebelum & sesudah
//  6. Auth: stats endpoint butuh admin token
//  7. Project 404
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
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';
import { createPublicRouter } from '../src/api/publicRoutes.js';
import { createStatsRouter } from '../src/api/statsRoutes.js';
import { flushMetrics, extractProjectId, metricsProjectId } from '../src/core/metrics.js';

const TEST_DATA_DIR = path.resolve('../data/m24-stats-test');

let server: nodeHttp.Server;
let baseURL: string;
let adminToken: string;
let projectIdA: string;
let projectIdB: string;

function http(
  method: string,
  p: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; data: any; raw: string }> {
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

async function statsOf(pid: string): Promise<any> {
  const res = await http('GET', `/api/admin/projects/${pid}/stats`, undefined, adminToken);
  assert.equal(res.status, 200, `stats harus 200: ${res.raw}`);
  return res.data;
}

before(async () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  process.env.DATA_DIR = TEST_DATA_DIR;
  process.env.ADMIN_EMAIL = 'admin@m24.test';
  process.env.ADMIN_PASSWORD = 'm24-secret-pass';
  process.env.JWT_SECRET = 'm24-test-jwt-secret-key-long-enough';
  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());
  router.merge(createPublicRouter());
  router.merge(createStatsRouter());

  server = nodeHttp.createServer((rq, rs) => router.handle(rq, rs));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  baseURL = `http://127.0.0.1:${addr.port}`;

  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@m24.test',
    password: 'm24-secret-pass',
  });
  assert.equal(login.status, 200);
  adminToken = login.data.token;

  const projA = await http('POST', '/api/admin/projects', { name: 'm24-proj-a' }, adminToken);
  assert.equal(projA.status, 201);
  projectIdA = projA.data.project?.id ?? projA.data.id;

  const projB = await http('POST', '/api/admin/projects', { name: 'm24-proj-b' }, adminToken);
  assert.equal(projB.status, 201);
  projectIdB = projB.data.project?.id ?? projB.data.id;

  // Collection di A utk traffic public API
  const col = await http(
    'POST',
    `/api/admin/projects/${projectIdA}/collections`,
    { name: 'items', fields: [{ name: 'title', type: 'text' }], rules: { listRule: '' } },
    adminToken
  );
  assert.equal(col.status, 201, JSON.stringify(col.data));
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  closeAllProjectDbs();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─── Unit: ekstraksi projectId dari path ─────────────────────────────────────

test('extractProjectId: atribusi path → project (public/admin/files)', () => {
  assert.equal(extractProjectId('/api/p/abc123/records'), 'abc123');
  assert.equal(extractProjectId('/api/p/abc123/auth/login'), 'abc123');
  assert.equal(extractProjectId('/api/admin/projects/xyz789/collections'), 'xyz789');
  assert.equal(extractProjectId('/api/files/xyz789/photos/rec/file.png'), 'xyz789');
  assert.equal(extractProjectId('/api/health'), null);
  assert.equal(extractProjectId('/api/admin/auth/login'), null);
  assert.equal(extractProjectId('/api/p'), null); // terlalu pendek
  assert.equal(extractProjectId('/'), null);
});

test('metricsProjectId: endpoint stats TIDAK dihitung (observer effect)', () => {
  assert.equal(metricsProjectId('/api/admin/projects/abc123/stats'), null);
  // Path lain tetap dihitung
  assert.equal(metricsProjectId('/api/admin/projects/abc123/collections'), 'abc123');
  assert.equal(metricsProjectId('/api/p/abc123/stats'), 'abc123'); // collection bernama 'stats' TETAP dihitung
});

// ─── 1+2: request public & admin terhitung dengan bytes ─────────────────────

test('request public & admin terhitung (requests + bytesOut)', async () => {
  const before = await statsOf(projectIdA);

  // Public API traffic (list records)
  for (let i = 0; i < 3; i++) {
    const r = await http('GET', `/api/p/${projectIdA}/collections/items/records`);
    assert.equal(r.status, 200);
  }
  // Admin API traffic (list collections)
  const admin1 = await http(
    'GET',
    `/api/admin/projects/${projectIdA}/collections`,
    undefined,
    adminToken
  );
  assert.equal(admin1.status, 200);

  // Tunggu event 'finish' (async — beri microtask kesempatan jalan)
  await new Promise((r) => setTimeout(r, 50));

  const after = await statsOf(projectIdA);
  assert.equal(after.totals.requests, before.totals.requests + 4, '4 request baru harus terhitung');
  assert.ok(after.today.bytesOut > 0, 'bytesOut harus > 0 (response JSON terukur)');
  // Byte bertambah dari sebelumnya
  assert.ok(
    after.totals.bytesOut >= before.totals.bytesOut + 0,
    'total bytesOut tidak boleh turun'
  );
  // bytesIn request GET = 0 (tanpa body)
  assert.equal(after.today.bytesIn, before.today.bytesIn);
});

// ─── 3: isolasi antar project ───────────────────────────────────────────────

test('isolasi: trafik A tidak bocor ke B', async () => {
  const beforeB = await statsOf(projectIdB);
  const beforeA = await statsOf(projectIdA);

  // Traffic hanya ke project A
  await http('GET', `/api/p/${projectIdA}/collections/items/records`);
  await new Promise((r) => setTimeout(r, 50));

  const afterB = await statsOf(projectIdB);
  const afterA = await statsOf(projectIdA);

  assert.equal(afterB.totals.requests, beforeB.totals.requests, 'B tidak boleh bertambah');
  assert.equal(afterA.totals.requests, beforeA.totals.requests + 1);
});

// ─── 4: request non-project tidak diatribusikan ─────────────────────────────

test('health check (tanpa project) tidak tercatat di project manapun', async () => {
  const beforeA = await statsOf(projectIdA);
  const beforeB = await statsOf(projectIdB);

  await http('GET', '/api/health');
  await http('POST', '/api/admin/auth/login', { email: 'x@y.test', password: 'nope1234' });
  await new Promise((r) => setTimeout(r, 50));

  const afterA = await statsOf(projectIdA);
  const afterB = await statsOf(projectIdB);
  assert.equal(afterA.totals.requests, beforeA.totals.requests);
  assert.equal(afterB.totals.requests, beforeB.totals.requests);
});

// ─── 5: flush batch ke DB — stats konsisten sebelum & sesudah ───────────────

test('flushMetrics: buffer → DB, angka tidak berubah (idempotent merge)', async () => {
  const before = await statsOf(projectIdA);
  assert.ok(before.totals.requests > 0, 'precondition: sudah ada trafik');

  const flushed = flushMetrics();
  assert.ok(flushed >= 1, `minimal 1 baris ter-flush (dapat ${flushed})`);

  // Setelah flush, stats HARUS identik (data kini dari DB, buffer kosong)
  const after = await statsOf(projectIdA);
  assert.equal(after.totals.requests, before.totals.requests);
  assert.equal(after.totals.bytesIn, before.totals.bytesIn);
  assert.equal(after.totals.bytesOut, before.totals.bytesOut);

  // Double-flush (buffer kosong) → tidak mengubah apa pun
  flushMetrics();
  const again = await statsOf(projectIdA);
  assert.equal(again.totals.requests, after.totals.requests);
});

// ─── Struktur respons ────────────────────────────────────────────────────────

test('struktur stats: 14 hari zero-filled + today = hari terakhir', async () => {
  const s = await statsOf(projectIdA);
  assert.equal(s.days.length, 14);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(s.days[13].date, today, 'hari terakhir = hari ini');
  assert.equal(s.today.date, today);
  assert.equal(s.today.requests, s.days[13].requests);
  // Setiap hari punya field lengkap
  for (const d of s.days) {
    assert.ok(typeof d.requests === 'number');
    assert.ok(typeof d.bytesIn === 'number');
    assert.ok(typeof d.bytesOut === 'number');
  }
});

// ─── 6+7: auth & 404 ────────────────────────────────────────────────────────

test('stats endpoint: butuh admin; project tak dikenal → 404', async () => {
  const noAuth = await http('GET', `/api/admin/projects/${projectIdA}/stats`);
  assert.equal(noAuth.status, 401);

  const notFound = await http(
    'GET',
    '/api/admin/projects/projecthantu/stats',
    undefined,
    adminToken
  );
  assert.equal(notFound.status, 404);
});
