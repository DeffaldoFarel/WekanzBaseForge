// ============================================================================
// M13: TEST REALTIME — SSE integration dengan HTTP nyata
//
// Skenario: collection posts dengan rule own-data 'user = @request.auth.id'.
// PROOF: user A hanya menerima event miliknya; anonymous tidak menerima
// event admin-only; admin menerima semua; filter bekerja.
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
import { createProjectAuthRouter } from '../src/api/authRoutes.js';
import { createPublicRouter } from '../src/api/publicRoutes.js';
import { createRealtimeRouter } from '../src/api/realtimeRoutes.js';
import { Router } from '../src/core/router.js';

// ─── State ───────────────────────────────────────────────────────────────────

let server: nodeHttp.Server;
let baseURL = '';
const TEST_DATA_DIR = path.resolve('../data/m13-test');

let pid: string;
let adminToken: string;
let userAId: string;
let tokenA: string;

// ─── Setup + teardown ────────────────────────────────────────────────────────

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
  router.merge(createProjectAuthRouter());
  router.merge(createPublicRouter());
  router.merge(createRealtimeRouter());

  server = nodeHttp.createServer((req, res) => {
    router.handle(req, res);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      baseURL = `http://localhost:${addr.port}`;
      resolve();
    });
  });

  const login = await http('POST', '/api/admin/auth/login', { email: 'admin@test.local', password: 'admin-test-pass' });
  adminToken = login.data.token;

  const proj = await http('POST', '/api/admin/projects', { name: 'm13' }, adminToken);
  pid = proj.data.project.id;

  await http('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'posts',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'user', type: 'text', required: true },
    ],
  }, adminToken);

  // listRule publik awal; createRule own-data
  await http('PATCH', `/api/admin/projects/${pid}/collections/posts/rules`, {
    listRule: '',
    viewRule: '',
    createRule: 'user = @request.auth.id',
  }, adminToken);

  const reg = await http('POST', `/api/p/${pid}/auth/register`, { email: 'a@m13.test', password: 'passwordA123' });
  tokenA = reg.data.accessToken;
  userAId = reg.data.user.id;
});

after(async () => {
  closeAllProjectDbs();
  // Windows: rmSync gagal EPERM selama handle platform.db masih terbuka.
  closePlatformDb();
  server.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─── HTTP helper ─────────────────────────────────────────────────────────────

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

// ─── SSE client helper ───────────────────────────────────────────────────────

interface SseEvent {
  event: string;
  data: any;
}

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

// ─── Tests ───────────────────────────────────────────────────────────────────

test('M13: SSE connect memberi PB_CONNECT clientId', async () => {
  const sse = openSse(`/api/p/${pid}/realtime`);
  await new Promise((r) => setTimeout(r, 300));
  sse.req.destroy();

  assert.ok(sse.events.length >= 1, 'harus ada minimal 1 event');
  assert.equal(sse.events[0].event, 'PB_CONNECT');
  assert.ok(sse.events[0].data.clientId);
});

test('M13: subscribe + create record → PB_CREATE diterima', async () => {
  const sse = openSse(`/api/p/${pid}/realtime`);
  await new Promise((r) => setTimeout(r, 200));
  const clientId = sse.events[0]?.data?.clientId;
  assert.ok(clientId, 'PB_CONNECT harus dulu');

  const sub = await http('POST', `/api/p/${pid}/realtime/subscribe`, { clientId, collection: 'posts' });
  assert.equal(sub.status, 200);
  await new Promise((r) => setTimeout(r, 200));

  const rec = await http('POST', `/api/p/${pid}/collections/posts/records`, { title: 'Hello Realtime', user: 'admin' }, adminToken);
  assert.equal(rec.status, 201);

  await new Promise((r) => setTimeout(r, 400));
  sse.req.destroy();

  const createEvents = sse.events.filter((e) => e.event === 'PB_CREATE');
  assert.equal(createEvents.length, 1, 'harus tepat 1 PB_CREATE');
  assert.equal(createEvents[0].data.collection, 'posts');
  assert.equal(createEvents[0].data.record.title, 'Hello Realtime');
});

test('M13: RULES saat publish — anonymous tidak menerima event admin-only', async () => {
  await http('PATCH', `/api/admin/projects/${pid}/collections/posts/rules`, { listRule: null }, adminToken);

  const sse = openSse(`/api/p/${pid}/realtime`); // anonymous
  await new Promise((r) => setTimeout(r, 200));
  const clientId = sse.events[0]?.data?.clientId;
  await http('POST', `/api/p/${pid}/realtime/subscribe`, { clientId, collection: 'posts' });
  await new Promise((r) => setTimeout(r, 200));

  await http('POST', `/api/p/${pid}/collections/posts/records`, { title: 'rahasia', user: 'admin' }, adminToken);
  await new Promise((r) => setTimeout(r, 400));
  sse.req.destroy();

  const createEvents = sse.events.filter((e) => e.event === 'PB_CREATE');
  assert.equal(createEvents.length, 0, 'anonymous + rule null = tidak boleh ada event');
});

test('M13: rules own-data — user A hanya menerima event miliknya', async () => {
  await http('PATCH', `/api/admin/projects/${pid}/collections/posts/rules`, { listRule: 'user = @request.auth.id' }, adminToken);

  const sseA = openSse(`/api/p/${pid}/realtime`, tokenA);
  await new Promise((r) => setTimeout(r, 200));
  const clientIdA = sseA.events[0]?.data?.clientId;
  await http('POST', `/api/p/${pid}/realtime/subscribe`, { clientId: clientIdA, collection: 'posts' });
  await new Promise((r) => setTimeout(r, 200));

  const recA = await http('POST', `/api/p/${pid}/collections/posts/records`, { title: 'milik A', user: userAId }, tokenA);
  assert.equal(recA.status, 201);

  await http('POST', `/api/p/${pid}/collections/posts/records`, { title: 'bukan milik A', user: 'orang_lain' }, adminToken);

  await new Promise((r) => setTimeout(r, 500));
  sseA.req.destroy();

  const createEvents = sseA.events.filter((e) => e.event === 'PB_CREATE');
  assert.equal(createEvents.length, 1, 'A hanya melihat miliknya');
  assert.equal(createEvents[0].data.record.title, 'milik A');
});

test('M13: PB_UPDATE dan PB_DELETE terkirim', async () => {
  await http('PATCH', `/api/admin/projects/${pid}/collections/posts/rules`, { listRule: '' }, adminToken);

  const rec = await http('POST', `/api/p/${pid}/collections/posts/records`, { title: 'awal', user: 'x' }, adminToken);
  const recId = rec.data.record.id;

  const sse = openSse(`/api/p/${pid}/realtime`, adminToken);
  await new Promise((r) => setTimeout(r, 200));
  const clientId = sse.events[0]?.data?.clientId;
  await http('POST', `/api/p/${pid}/realtime/subscribe`, { clientId, collection: 'posts' });
  await new Promise((r) => setTimeout(r, 200));

  await http('PATCH', `/api/p/${pid}/collections/posts/records/${recId}`, { title: 'diubah' }, adminToken);
  await http('DELETE', `/api/p/${pid}/collections/posts/records/${recId}`, undefined, adminToken);
  await new Promise((r) => setTimeout(r, 500));
  sse.req.destroy();

  assert.ok(sse.events.some((e) => e.event === 'PB_UPDATE' && e.data.record.title === 'diubah'), 'harus ada PB_UPDATE');
  assert.ok(sse.events.some((e) => e.event === 'PB_DELETE' && e.data.record.id === recId), 'harus ada PB_DELETE');
});

test('M13: unsubscribe menghentikan event', async () => {
  const sse = openSse(`/api/p/${pid}/realtime`, adminToken);
  await new Promise((r) => setTimeout(r, 200));
  const clientId = sse.events[0]?.data?.clientId;
  const sub = await http('POST', `/api/p/${pid}/realtime/subscribe`, { clientId, collection: 'posts' });
  const subId = sub.data.subscriptions[0];
  await http('POST', `/api/p/${pid}/realtime/unsubscribe`, { clientId, subId });
  await new Promise((r) => setTimeout(r, 200));

  await http('POST', `/api/p/${pid}/collections/posts/records`, { title: 'setelah unsub', user: 'x' }, adminToken);
  await new Promise((r) => setTimeout(r, 400));
  sse.req.destroy();

  const createEvents = sse.events.filter((e) => e.event === 'PB_CREATE' && e.data.record.title === 'setelah unsub');
  assert.equal(createEvents.length, 0, 'setelah unsubscribe tidak boleh ada event');
});

test('M13: subscribe dengan filter — hanya record yang cocok', async () => {
  const sse = openSse(`/api/p/${pid}/realtime`, adminToken);
  await new Promise((r) => setTimeout(r, 200));
  const clientId = sse.events[0]?.data?.clientId;
  await http('POST', `/api/p/${pid}/realtime/subscribe`, { clientId, collection: 'posts', filter: "title ~ 'penting'" });
  await new Promise((r) => setTimeout(r, 200));

  await http('POST', `/api/p/${pid}/collections/posts/records`, { title: 'halaman biasa', user: 'x' }, adminToken);
  await http('POST', `/api/p/${pid}/collections/posts/records`, { title: 'PENTING sekali', user: 'x' }, adminToken);
  await new Promise((r) => setTimeout(r, 500));
  sse.req.destroy();

  const createEvents = sse.events.filter((e) => e.event === 'PB_CREATE');
  assert.equal(createEvents.length, 1, 'hanya 1 record lolos filter');
  assert.equal(createEvents[0].data.record.title, 'PENTING sekali');
});
