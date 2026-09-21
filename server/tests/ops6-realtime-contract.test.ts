// ============================================================================
// Ops-6: TEST REALTIME CONTRACT — bulk sync SDK + auth upgrade + fail-safe delete
//
// PROOF yang harus dihasilkan:
// 1. POST /api/p/:pid/realtime (contract SDK @wekanz/baseforge) → 200 (dulu 404)
//    + semantik REPLACE + topik collection/<recordId>
// 2. Auth SSE: upgrade via header Authorization di POST sync/subscribe,
//    plus ?token= di GET — user A menerima event miliknya, user B & anonymous
//    tidak (dulu: SSE browser selalu anonymous → event tidak pernah sampai)
// 3. Fail-safe delete: event delete TIDAK bocor ke user lain / anonymous
//    (dulu: payload full record dikirim ke semua subscriber)
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
const TEST_DATA_DIR = path.resolve('../data/ops6-test');

let pid: string;
let adminToken: string;
let userAId: string;
let tokenA: string;
let userBId: string;
let tokenB: string;

const OWN = 'user = @request.auth.id';

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

  // ID unik per run — platform.db global bertahan antar file dalam satu proses
  const proj = await http('POST', '/api/admin/projects', { name: 'ops6', id: 'ops6' + Date.now().toString(36) }, adminToken);
  pid = proj.data.project.id;

  await http('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'posts',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'user', type: 'text', required: true },
    ],
  }, adminToken);

  await http('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'notes',
    fields: [
      { name: 'body', type: 'text', required: true },
      { name: 'user', type: 'text', required: true },
    ],
  }, adminToken);

  // Owner-only rule di semua aksi posts
  await http('PATCH', `/api/admin/projects/${pid}/collections/posts/rules`, {
    listRule: OWN,
    viewRule: OWN,
    createRule: OWN,
    updateRule: OWN,
    deleteRule: OWN,
  }, adminToken);

  // Owner-only rule di notes juga — tanpa ini default null (admin-only) →
  // create user ditolak 403 → test REPLACE tidak pernah menerima event
  await http('PATCH', `/api/admin/projects/${pid}/collections/notes/rules`, {
    listRule: OWN,
    viewRule: OWN,
    createRule: OWN,
    updateRule: OWN,
    deleteRule: OWN,
  }, adminToken);

  const regA = await http('POST', `/api/p/${pid}/auth/register`, { email: 'a@ops6.test', password: 'passwordA123' });
  tokenA = regA.data.accessToken;
  userAId = regA.data.user.id;

  const regB = await http('POST', `/api/p/${pid}/auth/register`, { email: 'b@ops6.test', password: 'passwordB123' });
  tokenB = regB.data.accessToken;
  userBId = regB.data.user.id;
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
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── SSE helper (status ikut ditangkap — untuk uji 401) ──────────────────────

interface SseEvent {
  event: string;
  data: any;
}

function openSse(reqPath: string, headers: Record<string, string> = {}): { events: SseEvent[]; req: nodeHttp.ClientRequest; status: number } {
  const out = { events: [] as SseEvent[], req: null as unknown as nodeHttp.ClientRequest, status: 0 };
  const url = new URL(reqPath, baseURL);
  const req = nodeHttp.request(url, { method: 'GET', headers });
  out.req = req;
  req.end();
  req.on('response', (res) => {
    out.status = res.statusCode ?? 0;
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
          out.events.push({ event: evMatch[1].trim(), data });
        }
      }
    });
  });
  return out;
}

async function connectAnonymous(): Promise<{ sse: ReturnType<typeof openSse>; clientId: string }> {
  const sse = openSse(`/api/p/${pid}/realtime`);
  await sleep(250);
  const clientId = sse.events[0]?.data?.clientId;
  assert.ok(clientId, 'PB_CONNECT harus dulu');
  return { sse, clientId };
}

// Bulk sync ala SDK: POST /realtime {clientId, subscriptions}
async function bulkSync(clientId: string, subscriptions: string[], token?: string) {
  return http('POST', `/api/p/${pid}/realtime`, { clientId, subscriptions }, token);
}

async function createPost(title: string, token: string): Promise<string> {
  const res = await http('POST', `/api/p/${pid}/collections/posts/records`, { title, user: userIdOf(token) }, token);
  assert.equal(res.status, 201, 'create harus 201: ' + JSON.stringify(res.data));
  return res.data.record.id as string;
}

// User A membuat record → userId = userAId (dipakai semua test)
function userIdOf(_token: string): string {
  return userAId;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('Ops-6: SDK contract — POST /realtime 200 (dulu 404) + event sampai via auth upgrade', async () => {
  const { sse, clientId } = await connectAnonymous(); // EventSource browser: anonymous

  // SDK syncSubscriptions() persis: {clientId, subscriptions} + Authorization
  const sync = await bulkSync(clientId, ['posts/*'], tokenA);
  assert.equal(sync.status, 200, 'bulk sync harus 200 — ini contract SDK: ' + JSON.stringify(sync.data));
  assert.ok(Array.isArray(sync.data.subscriptions), 'respons harus punya subscriptions[]');
  assert.equal(sync.data.subscriptions[0].collection, 'posts');
  await sleep(200);

  const recId = await createPost('milik A via SDK', tokenA);
  await sleep(500);
  sse.req.destroy();

  const createEvents = sse.events.filter((e) => e.event === 'PB_CREATE');
  assert.equal(createEvents.length, 1, 'auth upgrade via POST → A harus menerima event miliknya');
  assert.equal(createEvents[0].data.record.title, 'milik A via SDK');
  assert.equal(createEvents[0].data.record.id, recId);
});

test('Ops-6: bulk sync semantik REPLACE — collection lama berhenti, baru aktif', async () => {
  const { sse, clientId } = await connectAnonymous();
  await bulkSync(clientId, ['posts/*'], tokenA);
  await sleep(200);

  // Ganti seluruh set: hanya notes
  const sync2 = await bulkSync(clientId, ['notes/*'], tokenA);
  assert.equal(sync2.status, 200);
  await sleep(200);

  await http('POST', `/api/p/${pid}/collections/posts/records`, { title: 'harus tidak sampai', user: userAId }, tokenA);
  await http('POST', `/api/p/${pid}/collections/notes/records`, { body: 'harus sampai', user: userAId }, tokenA);
  await sleep(500);
  sse.req.destroy();

  assert.equal(sse.events.filter((e) => e.event === 'PB_CREATE' && e.data.collection === 'posts').length, 0, 'posts sudah tidak di set → tidak boleh ada event');
  const noteEvents = sse.events.filter((e) => e.event === 'PB_CREATE' && e.data.collection === 'notes');
  assert.equal(noteEvents.length, 1, 'notes baru di set → harus ada event');
  assert.equal(noteEvents[0].data.record.body, 'harus sampai');
});

test('Ops-6: bulk sync array kosong = unsubscribe semua', async () => {
  const { sse, clientId } = await connectAnonymous();
  await bulkSync(clientId, ['posts/*'], tokenA);
  await sleep(200);

  const sync2 = await bulkSync(clientId, [], tokenA);
  assert.equal(sync2.status, 200);
  assert.equal(sync2.data.subscriptions.length, 0);
  await sleep(200);

  await createPost('setelah kosong', tokenA);
  await sleep(400);
  sse.req.destroy();

  assert.equal(sse.events.filter((e) => e.event === 'PB_CREATE').length, 0, 'set kosong → tidak boleh ada event');
});

test('Ops-6: topik collection/<recordId> — server memfilter per record', async () => {
  const recX = await createPost('target X', tokenA);
  const { sse, clientId } = await connectAnonymous();
  await bulkSync(clientId, ['posts/' + recX], tokenA);
  await sleep(200);

  // Update record lain → tidak boleh sampai
  const recY = await createPost('bukan target', tokenA);
  await http('PATCH', `/api/p/${pid}/collections/posts/records/${recY}`, { title: 'bukan target diubah' }, tokenA);
  // Update record target → harus sampai
  await http('PATCH', `/api/p/${pid}/collections/posts/records/${recX}`, { title: 'target X diubah' }, tokenA);
  await sleep(500);
  sse.req.destroy();

  assert.equal(sse.events.filter((e) => e.event === 'PB_CREATE').length, 0, 'create record lain → tidak boleh sampai');
  const updates = sse.events.filter((e) => e.event === 'PB_UPDATE');
  assert.equal(updates.length, 1, 'hanya update record target yang sampai');
  assert.equal(updates[0].data.record.id, recX);
  assert.equal(updates[0].data.record.title, 'target X diubah');
});

test('Ops-6: validasi bulk sync — 400/404 path', async () => {
  const { sse, clientId } = await connectAnonymous();

  assert.equal((await http('POST', `/api/p/${pid}/realtime`, {}, adminToken)).status, 400, 'tanpa clientId → 400');
  assert.equal((await bulkSync('tidakada123', ['posts/*'], adminToken)).status, 404, 'clientId tidak dikenal → 404');
  assert.equal((await http('POST', `/api/p/${pid}/realtime`, { clientId, subscriptions: 'bukan-array' }, adminToken)).status, 400, 'subscriptions bukan array → 400');
  assert.equal((await bulkSync(clientId, ['posts/*', 123 as unknown as string], adminToken)).status, 400, 'entri non-string → 400');
  assert.equal((await bulkSync(clientId, ['topik tidak!!valid'], adminToken)).status, 400, 'format topik salah → 400');
  assert.equal((await bulkSync(clientId, ['col_tidak_ada/*'], adminToken)).status, 400, 'collection tidak ada → 400');
  assert.equal((await bulkSync(clientId, Array.from({ length: 101 }, () => 'posts/*'), adminToken)).status, 400, '>100 topik → 400');
  assert.equal((await bulkSync(clientId, ['posts/*'], 'token-sampah')).status, 401, 'token invalid → 401 (SDK M37 auto-refresh mengandalkan ini)');

  sse.req.destroy();
});

test('Ops-6: auth upgrade via POST — isolasi antar user (A menerima, B tidak)', async () => {
  const a = await connectAnonymous();
  const b = await connectAnonymous();
  await bulkSync(a.clientId, ['posts/*'], tokenA);
  await bulkSync(b.clientId, ['posts/*'], tokenB);
  await sleep(200);

  await createPost('milik A saja', tokenA);
  await sleep(500);
  a.sse.req.destroy();
  b.sse.req.destroy();

  assert.equal(a.sse.events.filter((e) => e.event === 'PB_CREATE').length, 1, 'A menerima event miliknya');
  assert.equal(b.sse.events.filter((e) => e.event === 'PB_CREATE').length, 0, 'B TIDAK boleh menerima event milik A');
});

test('Ops-6: GET ?token= — auth dari query param (EventSource tanpa header)', async () => {
  // token valid via query param — koneksi langsung ter-auth sejak connect
  const sse = openSse(`/api/p/${pid}/realtime?token=${tokenA}`);
  await sleep(250);
  const clientId = sse.events[0]?.data?.clientId;
  assert.ok(clientId, 'PB_CONNECT harus tetap jalan');

  // sync TANPA token (anonymous POST) — auth koneksi tidak boleh ter-downgrade
  const sync = await bulkSync(clientId, ['posts/*']);
  assert.equal(sync.status, 200);
  await sleep(200);

  await createPost('via query token', tokenA);
  await sleep(500);
  sse.req.destroy();

  assert.equal(sse.events.filter((e) => e.event === 'PB_CREATE').length, 1, 'auth dari ?token= → event milik A sampai');

  // token invalid via query param → 401 keras (bukan diam-diam anonymous)
  const bad = openSse(`/api/p/${pid}/realtime?token=jwt-palsu`);
  await sleep(300);
  bad.req.destroy();
  assert.equal(bad.status, 401, 'token invalid → 401 (fail loud)');
  assert.equal(bad.events.length, 0, 'tidak boleh ada PB_CONNECT untuk token invalid');
});

test('Ops-6: fail-safe delete — TIDAK bocor ke user lain & anonymous', async () => {
  // Anonymous BERLANGGANAN via POST tanpa token (di sinilah dulu delete bocor)
  const anon = await connectAnonymous();
  await bulkSync(anon.clientId, ['posts/*']); // tanpa Authorization
  // B berlangganan dengan token
  const b = await connectAnonymous();
  await bulkSync(b.clientId, ['posts/*'], tokenB);
  // A berlangganan dengan token
  const a = await connectAnonymous();
  await bulkSync(a.clientId, ['posts/*'], tokenA);
  await sleep(200);

  const recId = await createPost('akan dihapus', tokenA);
  await sleep(300);
  const del = await http('DELETE', `/api/p/${pid}/collections/posts/records/${recId}`, undefined, tokenA);
  assert.equal(del.status, 200, 'A boleh hapus miliknya: ' + JSON.stringify(del.data));
  await sleep(500);
  anon.sse.req.destroy();
  b.sse.req.destroy();
  a.sse.req.destroy();

  const aDelete = a.sse.events.filter((e) => e.event === 'PB_DELETE');
  assert.equal(aDelete.length, 1, 'pemilik (A) menerima event delete miliknya');
  assert.equal(aDelete[0].data.record.id, recId);
  assert.equal(b.sse.events.filter((e) => e.event === 'PB_DELETE').length, 0, 'user B TIDAK boleh menerima delete record A (dulu bocor)');
  assert.equal(anon.sse.events.filter((e) => e.event === 'PB_DELETE').length, 0, 'anonymous TIDAK boleh menerima delete (dulu bocor)');
});

test('Ops-6: delete di collection publik tetap broadcast ke semua (regresi over-blocking)', async () => {
  // Rule publik: siapa pun boleh list → event untuk semua subscriber
  await http('PATCH', `/api/admin/projects/${pid}/collections/posts/rules`, { listRule: '' }, adminToken);

  const anon = await connectAnonymous();
  await bulkSync(anon.clientId, ['posts/*']);
  await sleep(200);

  const recId = await createPost('publik akan dihapus', tokenA);
  await sleep(300);
  await http('DELETE', `/api/p/${pid}/collections/posts/records/${recId}`, undefined, tokenA);
  await sleep(500);
  anon.sse.req.destroy();

  assert.equal(anon.sse.events.filter((e) => e.event === 'PB_DELETE').length, 1, 'rule publik → delete tetap sampai ke anonymous');

  // kembalikan rule owner untuk test berikutnya
  await http('PATCH', `/api/admin/projects/${pid}/collections/posts/rules`, { listRule: OWN }, adminToken);
});

test('Ops-6: backward-compat — /subscribe tunggal kini juga upgrade auth', async () => {
  const { sse, clientId } = await connectAnonymous();

  // Route lama + header Authorization → auth koneksi di-upgrade
  const sub = await http('POST', `/api/p/${pid}/realtime/subscribe`, { clientId, collection: 'posts' }, tokenA);
  assert.equal(sub.status, 200, 'route /subscribe tetap bekerja: ' + JSON.stringify(sub.data));
  await sleep(200);

  await createPost('via route lama', tokenA);
  await sleep(500);
  sse.req.destroy();

  assert.equal(sse.events.filter((e) => e.event === 'PB_CREATE').length, 1, 'upgrade auth di /subscribe → event milik A sampai');
});
