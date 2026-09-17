// ============================================================================
// M28: TEST WEBHOOKS — delivery, HMAC, retry, matching, delivery log
//
// Mock receiver HTTP server lokal (127.0.0.1) menangkap POST webhook:
//   /ok        → selalu 200 (delivery sukses)
//   /flaky     → 500 dua kali pertama, 200 ketiga (test retry)
//   /slow      → delay 500ms (timeout test — WEBHOOK_TIMEOUT diset 200ms via env? tidak — terima saja sukses lambat)
//   /record    → menyimpan semua request utk inspeksi (header + body)
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import nodeHttp from 'node:http';
import { initPlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { Router } from '../src/core/router.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';
import { createPublicRouter } from '../src/api/publicRoutes.js';
import { createWebhookRouter } from '../src/api/webhookRoutes.js';
import { signPayload } from '../src/core/webhooks.js';

const TEST_DATA_DIR = path.resolve('../data/m28-webhook-test');

let server: nodeHttp.Server;
let baseURL: string;
let adminToken: string;
let projectId: string;

// Mock receiver
let receiver: nodeHttp.Server;
let receiverURL: string;
let received: Array<{ path: string; headers: Record<string, string>; body: string }> = [];
let flakyCount = 0;

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

async function waitFor(fn: () => boolean, timeoutMs = 5000, label = ''): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

before(async () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  process.env.DATA_DIR = TEST_DATA_DIR;
  process.env.ADMIN_EMAIL = 'admin@m28.test';
  process.env.ADMIN_PASSWORD = 'm28-secret-pass';
  process.env.JWT_SECRET = 'm28-test-jwt-secret-key-long-enough';
  initPlatformDb();

  // Mock receiver (jangan blokir retry backoff lama — set env sebelum import modul webhooks? backoff tidak via env — biarkan default tapi test flaky pakai 3 attempt... backoff 1+4=5s, total wait ~5.5s, OK dalam 15s timeout)
  receiver = nodeHttp.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
      }
      received.push({ path: req.url ?? '/', headers, body });

      if ((req.url ?? '').startsWith('/flaky')) {
        flakyCount++;
        if (flakyCount <= 2) {
          res.writeHead(500);
          res.end('server error');
          return;
        }
        res.writeHead(200);
        res.end('ok');
        return;
      }
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  const rAddr = receiver.address() as { port: number };
  receiverURL = `http://127.0.0.1:${rAddr.port}`;

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());
  router.merge(createPublicRouter());
  router.merge(createWebhookRouter());

  server = nodeHttp.createServer((rq, rs) => router.handle(rq, rs));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  baseURL = `http://127.0.0.1:${addr.port}`;

  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@m28.test',
    password: 'm28-secret-pass',
  });
  assert.equal(login.status, 200);
  adminToken = login.data.token;

  const proj = await http('POST', '/api/admin/projects', { name: 'm28-web' }, adminToken);
  assert.equal(proj.status, 201);
  projectId = proj.data.project?.id ?? proj.data.id;

  // Collection posts + rules publik (semua operasi agar test CRUD bisa jalan tanpa auth)
  const col = await http(
    'POST',
    `/api/admin/projects/${projectId}/collections`,
    {
      name: 'posts',
      fields: [{ name: 'title', type: 'text' }],
      rules: { listRule: '', viewRule: '', createRule: '', updateRule: '', deleteRule: '' },
    },
    adminToken
  );
  assert.equal(col.status, 201, JSON.stringify(col.data));
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => receiver.close(() => r()));
  closeAllProjectDbs();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─── 1. Create webhook + HMAC signature ──────────────────────────────────────

test('create webhook → POST record → payload + HMAC signature sampai', async () => {
  const create = await http(
    'POST',
    `/api/admin/projects/${projectId}/webhooks`,
    { name: 'test-hook', url: `${receiverURL}/ok`, events: ['posts.create'] },
    adminToken
  );
  assert.equal(create.status, 201, JSON.stringify(create.data));
  assert.ok(create.data.webhook.secret.startsWith('whsec_'));
  const secret = create.data.webhook.secret as string;

  // Trigger: buat record
  const rec = await http('POST', `/api/p/${projectId}/collections/posts/records`, { title: 'hello webhook' });
  assert.equal(rec.status, 201);

  // Tunggu delivery (fire-and-forget)
  await waitFor(() => received.length >= 1, 3000, 'first delivery');

  const r = received[0];
  assert.equal(r.path, '/ok');
  assert.equal(r.headers['x-baseforge-event'], 'posts.create');
  assert.ok(r.headers['x-baseforge-signature']?.startsWith('sha256='));

  // Verifikasi HMAC: signature == HMAC(body, secret)
  const expected = signPayload(r.body, secret);
  assert.equal(
    crypto.timingSafeEqual(Buffer.from(r.headers['x-baseforge-signature']), Buffer.from(expected)),
    true,
    'signature harus cocok HMAC-SHA256(body, secret)'
  );

  // Payload format
  const payload = JSON.parse(r.body);
  assert.equal(payload.event, 'posts.create');
  assert.equal(payload.collection, 'posts');
  assert.equal(payload.record.title, 'hello webhook');
  assert.ok(payload.timestamp);
});

// ─── 2. Event matching ────────────────────────────────────────────────────────

test('matching: posts.* tidak terpicu oleh orders.create; * terpicu semua', async () => {
  // hook khusus orders.* → tidak menerima posts.create
  await http(
    'POST',
    `/api/admin/projects/${projectId}/webhooks`,
    { name: 'orders-only', url: `${receiverURL}/orders`, events: ['orders.*'] },
    adminToken
  );
  // hook wildcard
  await http(
    'POST',
    `/api/admin/projects/${projectId}/webhooks`,
    { name: 'catch-all', url: `${receiverURL}/all`, events: ['*'] },
    adminToken
  );

  received = []; // reset
  await http('POST', `/api/p/${projectId}/collections/posts/records`, { title: 'matching test' });

  await waitFor(() => received.length >= 2, 3000, 'two hooks fire');
  const paths = new Set(received.map((r) => r.path));
  assert.ok(paths.has('/ok'), 'posts.create hook terpicu');
  assert.ok(paths.has('/all'), 'catch-all terpicu');
  assert.ok(!paths.has('/orders'), 'orders.* TIDAK terpicu oleh posts.create');
});

// ─── 3. Update + previous ─────────────────────────────────────────────────────

test('update record → webhook menerima previous + record baru', async () => {
  // hook khusus posts.update
  await http(
    'POST',
    `/api/admin/projects/${projectId}/webhooks`,
    { name: 'update-hook', url: `${receiverURL}/update`, events: ['posts.update'] },
    adminToken
  );

  const rec = await http('POST', `/api/p/${projectId}/collections/posts/records`, { title: 'before' });
  const rid = rec.data.record.id;

  received = [];
  const upd = await http('PATCH', `/api/p/${projectId}/collections/posts/records/${rid}`, { title: 'after' });
  assert.equal(upd.status, 200);

  await waitFor(() => received.some((r) => r.path === '/update'), 3000, 'update hook');
  const r = received.find((x) => x.path === '/update')!;
  const payload = JSON.parse(r.body);
  assert.equal(payload.action, 'update');
  assert.equal(payload.record.title, 'after');
  assert.equal(payload.previous?.title, 'before');
});

// ─── 4. Retry dengan backoff ──────────────────────────────────────────────────

test('flaky endpoint (500×2) → retry → sukses di attempt ke-3', async () => {
  await http(
    'POST',
    `/api/admin/projects/${projectId}/webhooks`,
    { name: 'flaky-hook', url: `${receiverURL}/flaky`, events: ['posts.delete'] },
    adminToken
  );

  const rec = await http('POST', `/api/p/${projectId}/collections/posts/records`, { title: 'to delete' });
  const rid = rec.data.record.id;

  flakyCount = 0;
  const beforeFlaky = flakyCount;
  await http('DELETE', `/api/p/${projectId}/collections/posts/records/${rid}`);

  // 3 attempt dengan backoff 1s + 4s = ~5s
  await waitFor(() => flakyCount >= 3, 10_000, 'flaky retry ×3');
  assert.equal(flakyCount, 3, 'tepat 3 attempt (2 gagal + 1 sukses)');

  // Delivery log harus menunjukkan attempt 3 = ok
  const list = await http('GET', `/api/admin/projects/${projectId}/webhooks`, undefined, adminToken);
  const flaky = (list.data.webhooks as any[]).find((w) => w.name === 'flaky-hook');
  const deliveries = await http(
    'GET',
    `/api/admin/projects/${projectId}/webhooks/${flaky.id}/deliveries`,
    undefined,
    adminToken
  );
  const logs = deliveries.data.deliveries as any[];
  assert.ok(logs.length >= 3, '3 delivery tercatat');
  assert.equal(logs[0].ok, true, 'attempt terakhir ok');
  assert.equal(logs[0].attempt, 3);
  assert.equal(logs[1].ok, false, 'attempt 2 gagal');
});

// ─── 5. Disabled webhook tidak terpicu ────────────────────────────────────────

test('disabled webhook tidak menerima delivery', async () => {
  const create = await http(
    'POST',
    `/api/admin/projects/${projectId}/webhooks`,
    { name: 'disabled-hook', url: `${receiverURL}/disabled`, events: ['*'] },
    adminToken
  );
  const wid = create.data.webhook.id;

  // disable
  await http('PATCH', `/api/admin/projects/${projectId}/webhooks/${wid}`, { enabled: false }, adminToken);

  received = [];
  await http('POST', `/api/p/${projectId}/collections/posts/records`, { title: 'no fire' });
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(!received.some((r) => r.path === '/disabled'), 'hook disabled tidak terpicu');
});

// ─── 6. CRUD admin + secret masking ──────────────────────────────────────────

test('list menampilkan secretHint (bukan penuh); GET by ID menampilkan penuh; delete bekerja', async () => {
  const create = await http(
    'POST',
    `/api/admin/projects/${projectId}/webhooks`,
    { name: 'secret-check', url: `${receiverURL}/secret`, events: ['*'] },
    adminToken
  );
  const fullSecret = create.data.webhook.secret;
  const wid = create.data.webhook.id;

  // list → masked
  const list = await http('GET', `/api/admin/projects/${projectId}/webhooks`, undefined, adminToken);
  const entry = (list.data.webhooks as any[]).find((w) => w.name === 'secret-check');
  assert.ok(entry);
  assert.ok(!('secret' in entry), 'list tidak boleh memuat secret penuh');
  assert.ok(entry.secretHint.startsWith('whsec_'));

  // GET by ID → full secret
  const detail = await http('GET', `/api/admin/projects/${projectId}/webhooks/${wid}`, undefined, adminToken);
  assert.equal(detail.data.webhook.secret, fullSecret);

  // delete
  const del = await http('DELETE', `/api/admin/projects/${projectId}/webhooks/${wid}`, undefined, adminToken);
  assert.equal(del.status, 200);
  const del2 = await http('DELETE', `/api/admin/projects/${projectId}/webhooks/${wid}`, undefined, adminToken);
  assert.equal(del2.status, 404);
});

// ─── 7. Validasi ──────────────────────────────────────────────────────────────

test('validasi: URL non-http ditolak; event format salah ditolak; tanpa admin → 401', async () => {
  const bad1 = await http(
    'POST',
    `/api/admin/projects/${projectId}/webhooks`,
    { name: 'x', url: 'ftp://bad.example', events: ['*'] },
    adminToken
  );
  assert.equal(bad1.status, 400);
  assert.match(bad1.data.error.message, /http/);

  const bad2 = await http(
    'POST',
    `/api/admin/projects/${projectId}/webhooks`,
    { name: 'x', url: `${receiverURL}/ok`, events: ['bad-format'] },
    adminToken
  );
  assert.equal(bad2.status, 400);
  assert.match(bad2.data.error.message, /Invalid webhook event/);

  const noAuth = await http('GET', `/api/admin/projects/${projectId}/webhooks`);
  assert.equal(noAuth.status, 401);
});

// ─── 8. Test send (admin) ────────────────────────────────────────────────────

test('POST test → payload _test.create dikirim ke endpoint', async () => {
  const create = await http(
    'POST',
    `/api/admin/projects/${projectId}/webhooks`,
    { name: 'test-send', url: `${receiverURL}/testsend`, events: ['*'] },
    adminToken
  );
  const wid = create.data.webhook.id;

  received = [];
  const test = await http('POST', `/api/admin/projects/${projectId}/webhooks/${wid}/test`, {}, adminToken);
  assert.equal(test.status, 200);

  await waitFor(() => received.some((r) => r.path === '/testsend'), 3000, 'test delivery');
  const r = received.find((x) => x.path === '/testsend')!;
  assert.equal(r.headers['x-baseforge-event'], '_test.create');
  const payload = JSON.parse(r.body);
  assert.equal(payload.record.message, 'Test delivery from BaseForge');
});
