// ============================================================================
// SECURITY: realtime endpoint hardening — temuan audit FASE 0 (2026-10)
//
// AUD-0-01 — GET /api/p/:pid/realtime/stats:
//   Sebelumnya TANPA auth dan :pid diabaikan sama sekali → siapa pun
//   (anonymous) bisa membaca jumlah client+subscription GLOBAL lintas
//   project (info leak permukaan platform). Endpoint tidak punya konsumen
//   (dashboard/SDK/tests tidak memanggilnya) → kini admin-only dan
//   project-scoped (realtimeHub.statsForProject).
//
// AUD-0-02 — POST /api/p/:pid/realtime/unsubscribe:
//   Sebelumnya langsung realtimeHub.unsubscribe(clientId, subId) TANPA cek
//   project — berbeda dari sync/subscribe yang ber-guard audit F-05
//   (getClientForProject). Pemanggil dari route project asing yang
//   mengetahui/menebak clientId+subId bisa mematikan subscription milik
//   project lain (cross-project DoS). Kini: guard yang sama → 404.
//
// AUD-0-03 — admin record writes di databaseRoutes.ts tanpa realtime publish:
//   create/update/delete/batch-delete/batch via route admin HANYA menjalankan
//   webhook + trigger — realtimeHub.publish tidak pernah dipanggil (komentar
//   lama bahkan mengklaim "webhook + trigger + realtime untuk admin API juga").
//   Akibatnya edit dari Database Studio tidak pernah sampai ke subscriber SSE
//   (invariant fan-out DB → realtime → webhook → trigger rusai di jalur admin).
//   Kini semua jalur tulis admin broadcast seperti route publik.
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import nodeHttp from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { initPlatformDb, closePlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';
import { createRealtimeRouter } from '../src/api/realtimeRoutes.js';
import { Router } from '../src/core/router.js';

let server: nodeHttp.Server;
let baseURL = '';
const TEST_DATA_DIR = path.resolve('../data/sec-rt-endpoints-test');

let pidA: string;
let pidB: string;
let adminToken: string;

async function http(method: string, reqPath: string, body?: unknown, token?: string): Promise<{ status: number; data: any }> {
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
        try { data = JSON.parse(text); } catch { /* stream */ }
        resolve({ status: res.statusCode ?? 0, data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

interface SseEvent { event: string; data: any }

function openSse(reqPath: string, token?: string): { events: SseEvent[]; req: nodeHttp.ClientRequest } {
  const events: SseEvent[] = [];
  const url = new URL(reqPath, baseURL);
  const req = nodeHttp.request(url, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  req.end();
  req.on('response', (res) => {
    let buffer = '';
    res.setEncoding('utf-8');
    res.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const evMatch = frame.match(/event: (.+)/);
        const dataMatch = frame.match(/data: (.+)/);
        if (evMatch) {
          let data: any = null;
          try { data = JSON.parse(dataMatch?.[1] ?? 'null'); } catch { data = dataMatch?.[1] ?? null; }
          events.push({ event: evMatch[1].trim(), data });
        }
      }
    });
  });
  return { events, req };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  process.env.DATA_DIR = TEST_DATA_DIR;
  process.env.ADMIN_EMAIL = 'admin@test.local';
  process.env.ADMIN_PASSWORD = 'admin-test-pass';
  process.env.STORAGE_DIR = path.join(TEST_DATA_DIR, 'storage');

  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());
  router.merge(createRealtimeRouter());

  server = nodeHttp.createServer((req, res) => { router.handle(req, res); });
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      baseURL = `http://localhost:${addr.port}`;
      resolve();
    });
  });

  const login = await http('POST', '/api/admin/auth/login', { email: 'admin@test.local', password: 'admin-test-pass' });
  adminToken = login.data.token;

  const projA = await http('POST', '/api/admin/projects', { name: 'sec-rt-ep-A' }, adminToken);
  pidA = projA.data.project.id;
  const projB = await http('POST', '/api/admin/projects', { name: 'sec-rt-ep-B' }, adminToken);
  pidB = projB.data.project.id;

  for (const pid of [pidA, pidB]) {
    await http('POST', `/api/admin/projects/${pid}/collections`, {
      name: 'posts',
      fields: [{ name: 'title', type: 'text', required: true }],
    }, adminToken);
  }
});

after(async () => {
  closeAllProjectDbs();
  closePlatformDb();
  server.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test('AUD-0-02: unsubscribe dari route project lain ditolak (404), subscription tetap hidup', async () => {
  const sse = openSse(`/api/p/${pidA}/realtime`);
  await sleep(200);
  const clientId = sse.events[0]?.data?.clientId;
  assert.ok(clientId, 'PB_CONNECT harus datang lebih dulu');

  const sub = await http('POST', `/api/p/${pidA}/realtime/subscribe`, { clientId, collection: 'posts' }, adminToken);
  assert.equal(sub.status, 200, JSON.stringify(sub.data));
  const subId = sub.data.subscriptions[0];
  assert.ok(subId, 'subscribe harus mengembalikan subId');

  // ── Serangan: unsubscribe subscription project A lewat route project B ──
  // (sebelum fix: 200 + success:true → subscription benar-benar mati)
  const foreign = await http('POST', `/api/p/${pidB}/realtime/unsubscribe`, { clientId, subId });
  assert.equal(foreign.status, 404, 'unsubscribe lintas project HARUS 404');

  // Subscription harus tetap hidup: create record di A → PB_CREATE tetap sampai
  const rec = await http('POST', `/api/admin/projects/${pidA}/collections/posts/records`, { title: 'masih-hidup' }, adminToken);
  assert.equal(rec.status, 201, JSON.stringify(rec.data));
  await sleep(500);
  sse.req.destroy();
  await sleep(100);

  const got = sse.events.filter((e) => e.event === 'PB_CREATE' && e.data?.record?.title === 'masih-hidup');
  assert.equal(got.length, 1, 'subscription tidak boleh mati oleh unsubscribe dari project asing');
});

test('AUD-0-02 regression: unsubscribe dari project sendiri tetap bekerja', async () => {
  const sse = openSse(`/api/p/${pidA}/realtime`);
  await sleep(200);
  const clientId = sse.events[0]?.data?.clientId;
  assert.ok(clientId);

  const sub = await http('POST', `/api/p/${pidA}/realtime/subscribe`, { clientId, collection: 'posts' }, adminToken);
  const subId = sub.data.subscriptions[0];

  const own = await http('POST', `/api/p/${pidA}/realtime/unsubscribe`, { clientId, subId });
  assert.equal(own.status, 200, JSON.stringify(own.data));
  assert.equal(own.data.success, true, 'unsubscribe di project yang sama harus sukses');

  // idempotent: subId yang sama lagi → success:false, bukan error
  const again = await http('POST', `/api/p/${pidA}/realtime/unsubscribe`, { clientId, subId });
  assert.equal(again.status, 200);
  assert.equal(again.data.success, false, 'unsubscribe kedua kali → success:false (idempotent)');

  sse.req.destroy();
  await sleep(100);
});

test('AUD-0-03: admin writes (create/update/batch/delete) broadcast ke SSE subscribers', async () => {
  const sse = openSse(`/api/p/${pidA}/realtime`);
  await sleep(200);
  const clientId = sse.events[0]?.data?.clientId;
  assert.ok(clientId, 'PB_CONNECT harus datang lebih dulu');
  await http('POST', `/api/p/${pidA}/realtime/subscribe`, { clientId, collection: 'posts' }, adminToken);

  // create via route admin
  const c1 = await http('POST', `/api/admin/projects/${pidA}/collections/posts/records`, { title: 'admin-create' }, adminToken);
  assert.equal(c1.status, 201, JSON.stringify(c1.data));
  const recId = c1.data.record.id;

  // update via route admin
  const u = await http('PATCH', `/api/admin/projects/${pidA}/collections/posts/records/${recId}`, { title: 'admin-update' }, adminToken);
  assert.equal(u.status, 200, JSON.stringify(u.data));

  // batch create via route admin
  const b = await http('POST', `/api/admin/projects/${pidA}/collections/posts/records/batch`, { records: [{ title: 'admin-batch' }] }, adminToken);
  assert.equal(b.status, 201, JSON.stringify(b.data));

  // delete via route admin
  const d = await http('DELETE', `/api/admin/projects/${pidA}/collections/posts/records/${recId}`, undefined, adminToken);
  assert.equal(d.status, 200, JSON.stringify(d.data));

  await sleep(600);
  sse.req.destroy();
  await sleep(100);

  const title = (e: SseEvent) => e.data?.record?.title;
  assert.ok(
    sse.events.some((e) => e.event === 'PB_CREATE' && title(e) === 'admin-create'),
    'admin create harus broadcast PB_CREATE (sebelumnya: tidak pernah)'
  );
  assert.ok(
    sse.events.some((e) => e.event === 'PB_UPDATE' && title(e) === 'admin-update'),
    'admin update harus broadcast PB_UPDATE (sebelumnya: tidak pernah)'
  );
  assert.ok(
    sse.events.some((e) => e.event === 'PB_CREATE' && title(e) === 'admin-batch'),
    'admin batch create harus broadcast PB_CREATE per record (sebelumnya: tidak pernah)'
  );
  assert.ok(
    sse.events.some((e) => e.event === 'PB_DELETE' && e.data?.record?.id === recId),
    'admin delete harus broadcast PB_DELETE dengan payload M38 (sebelumnya: tidak pernah)'
  );
});

test('AUD-0-01: stats tanpa token ditolak (anonymous → 401)', async () => {
  const anon = await http('GET', `/api/p/${pidA}/realtime/stats`);
  assert.equal(anon.status, 401, 'anonymous tidak boleh membaca stats realtime (sebelumnya: 200 + angka global)');
});

test('AUD-0-01: stats admin-only DAN project-scoped', async () => {
  // 2 koneksi di A (1 subscription) + 1 koneksi di B
  const sseA1 = openSse(`/api/p/${pidA}/realtime`);
  const sseA2 = openSse(`/api/p/${pidA}/realtime`);
  const sseB = openSse(`/api/p/${pidB}/realtime`);
  await sleep(300);
  const idA1 = sseA1.events[0]?.data?.clientId;
  const idA2 = sseA2.events[0]?.data?.clientId;
  const idB = sseB.events[0]?.data?.clientId;
  assert.ok(idA1 && idA2 && idB, 'PB_CONNECT semua koneksi harus diterima');

  await http('POST', `/api/p/${pidA}/realtime/subscribe`, { clientId: idA1, collection: 'posts' }, adminToken);

  const statsA = await http('GET', `/api/p/${pidA}/realtime/stats`, undefined, adminToken);
  assert.equal(statsA.status, 200, JSON.stringify(statsA.data));
  assert.equal(statsA.data.clients, 2, 'stats project A hanya menghitung koneksi project A');
  assert.equal(statsA.data.subscriptions, 1, 'stats project A hanya menghitung subscription project A');

  const statsB = await http('GET', `/api/p/${pidB}/realtime/stats`, undefined, adminToken);
  assert.equal(statsB.status, 200, JSON.stringify(statsB.data));
  assert.equal(statsB.data.clients, 1, 'stats project B hanya menghitung koneksi project B (sebelumnya: angka global)');
  assert.equal(statsB.data.subscriptions, 0, 'stats project B tidak melihat subscription project A');

  sseA1.req.destroy();
  sseA2.req.destroy();
  sseB.req.destroy();
  await sleep(150);
});
