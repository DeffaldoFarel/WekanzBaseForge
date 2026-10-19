// ============================================================================
// AUD-5-01..05 (FASE 5: Realtime & SSE + Webhooks) — repro & regression
//
// AUD-5-01 🔴 backpressure: send()/ping abaikan return res.write() → buffer
//          unboundedly untuk subscriber yang tidak membaca (probe: 805 KB).
// AUD-5-02 🔴 webhook SSRF: guard hanya di create (update tanpa cek), literal
//          hostname saja ([::1] lolos), redirect diikuti fetch.
// AUD-5-03 🟡 tidak ada limit koneksi SSE (60/60 anonim diterima).
// AUD-5-04 🟡 subscribe inkremental tanpa cap + filter tak dibatasi.
// AUD-5-05 🔵 ?token=<JWT> dihargai di route POST/stats (leak via URL).
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import nodeHttp from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initPlatformDb, closePlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';
import { createProjectAuthRouter } from '../src/api/authRoutes.js';
import { createPublicRouter } from '../src/api/publicRoutes.js';
import { createRealtimeRouter } from '../src/api/realtimeRoutes.js';
import { createWebhookRouter } from '../src/api/webhookRoutes.js';
import { Router } from '../src/core/router.js';
import { realtimeHub } from '../src/core/realtime.js';

// ─── Harness ─────────────────────────────────────────────────────────────────

const SCRATCH = path.join(os.tmpdir(), 'baseforge-aud5-test');
let server: nodeHttp.Server;
let baseURL = '';
let pid = '';
let pid2 = '';
let adminToken = '';
let userToken = '';
let userId = '';

async function req(method: string, reqPath: string, body?: unknown, token?: string, queryToken?: string): Promise<{ status: number; data: any }> {
  const url = new URL(reqPath, baseURL);
  if (queryToken) url.searchParams.set('token', queryToken);
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = 'Bear' + 'er ' + token;
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* stream */ }
  return { status: res.status, data };
}

interface SseConn {
  sock: net.Socket;
  events: { event: string; data: any }[];
  clientId: string;
  destroy(): void;
}

function sseConnect(p: string, token?: string): Promise<SseConn> {
  return new Promise((resolve, reject) => {
    const port = Number(new URL(baseURL).port);
    const sock = net.connect(port, '127.0.0.1');
    const events: { event: string; data: any }[] = [];
    let buf = '';
    let clientId = '';
    let pending = { event: '', data: '' };
    let resolved = false;
    sock.on('connect', () => {
      const q = token ? `?token=${encodeURIComponent(token)}` : '';
      sock.write(`GET /api/p/${p}/realtime${q} HTTP/1.1\r\nHost: t\r\nAccept: text/event-stream\r\n\r\n`);
    });
    sock.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('event: ')) pending.event = line.slice(7).trim();
        else if (line.startsWith('data: ')) pending.data = line.slice(6);
        if (line === '' && pending.event) {
          try {
            const parsed = JSON.parse(pending.data);
            events.push({ event: pending.event, data: parsed });
            if (pending.event === 'PB_CONNECT' && !clientId) clientId = parsed.clientId;
          } catch { /* keepalive */ }
          pending = { event: '', data: '' };
        }
      }
      if (clientId && !resolved) {
        resolved = true;
        resolve({ sock, events, clientId, destroy: () => sock.destroy() });
      }
    });
    sock.on('error', (e) => { if (!resolved) { resolved = true; reject(e); } });
    setTimeout(() => { if (!resolved) { resolved = true; reject(new Error('SSE connect timeout')); } }, 4000);
  });
}

/** Status HTTP dari GET SSE tanpa menunggu stream (untuk tes limit koneksi). */
function sseStatus(p: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const port = Number(new URL(baseURL).port);
    const sock = net.connect(port, '127.0.0.1');
    let got = '';
    sock.on('connect', () => sock.write(`GET /api/p/${p}/realtime HTTP/1.1\r\nHost: t\r\n\r\n`));
    sock.on('data', (d) => {
      got += d.toString();
      const m = got.match(/^HTTP\/1\.[01] (\d{3})/);
      if (m) { sock.destroy(); resolve(parseInt(m[1], 10)); }
    });
    sock.on('error', reject);
    setTimeout(() => { sock.destroy(); reject(new Error('no status')); }, 3000);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.env.DATA_DIR = SCRATCH;
  process.env.ADMIN_EMAIL = 'admin@test.local';
  process.env.ADMIN_PASSWORD = 'admin-test-pass';

  initPlatformDb();
  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());
  router.merge(createProjectAuthRouter());
  router.merge(createPublicRouter());
  router.merge(createRealtimeRouter());
  router.merge(createWebhookRouter());
  server = nodeHttp.createServer((q, s) => router.handle(q, s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const login = await req('POST', '/api/admin/auth/login', { email: 'admin@test.local', password: 'admin-test-pass' });
  adminToken = login.data.token;
  const p1 = await req('POST', '/api/admin/projects', { name: 'aud5a' }, adminToken);
  pid = p1.data.project.id;
  const p2 = await req('POST', '/api/admin/projects', { name: 'aud5b' }, adminToken);
  pid2 = p2.data.project.id;

  await req('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'docs',
    fields: [{ name: 'body', type: 'text' }],
    rules: { createRule: '', updateRule: '', viewRule: '', listRule: '' },
  }, adminToken);
  await req('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'priv',
    fields: [{ name: 'userId', type: 'text' }],
    rules: { createRule: 'userId = @request.auth.id', updateRule: 'userId = @request.auth.id', viewRule: 'userId = @request.auth.id', listRule: 'userId = @request.auth.id' },
  }, adminToken);

  const reg = await req('POST', `/api/p/${pid}/auth/register`, { email: 'u@aud5.test', password: 'Passw0rd!234' });
  userToken = reg.data.accessToken;
  userId = reg.data.user?.id ?? reg.data.record?.id;
});

after(async () => {
  delete process.env.REALTIME_MAX_CONN_PER_PROJECT;
  delete process.env.WEBHOOK_ALLOW_PRIVATE;
  closeAllProjectDbs();
  closePlatformDb();
  server.close();
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

// ─── AUD-5-05: ?token= hanya untuk GET SSE ──────────────────────────────────

test('AUD-5-05: POST tidak lagi menghargai ?token= (JWT via URL = leak vector)', async () => {
  // Subscribe via query token TANPA header → post-fix token diabaikan:
  // koneksi tetap anonymous → event listRule-gated TIDAK sampai.
  const sse = await sseConnect(pid);
  const viaQuery = await req('POST', `/api/p/${pid}/realtime/subscribe`, { clientId: sse.clientId, collection: 'priv' }, undefined, userToken);
  assert.equal(viaQuery.status, 200, 'subscribe anonymous tetap sah');

  // user membuat record priv (auth via HEADER) → publish
  const created = await req('POST', `/api/p/${pid}/collections/priv/records`, { userId }, userToken);
  assert.equal(created.status, 201);
  await sleep(500);
  const leaked = sse.events.some((e) => e.event === 'PB_CREATE');
  assert.equal(leaked, false, 'query-token TIDAK boleh meng-upgrade auth koneksi (event priv bocor)');

  // Kontrol: HEADER Authorization → upgrade sah → event sampai
  const sse2 = await sseConnect(pid);
  await req('POST', `/api/p/${pid}/realtime/subscribe`, { clientId: sse2.clientId, collection: 'priv' }, userToken);
  await req('POST', `/api/p/${pid}/collections/priv/records`, { userId }, userToken);
  await sleep(500);
  assert.ok(sse2.events.some((e) => e.event === 'PB_CREATE'), 'header auth → event harus sampai (kontrol)');

  // Stats: ?token= admin tanpa header → 401 (GET biasa bisa kirim header)
  const statsQuery = await req('GET', `/api/p/${pid}/realtime/stats`, undefined, undefined, adminToken);
  assert.equal(statsQuery.status, 401, `stats ?token= harus 401 (dapat ${statsQuery.status})`);
  const statsHeader = await req('GET', `/api/p/${pid}/realtime/stats`, undefined, adminToken);
  assert.equal(statsHeader.status, 200, 'stats dengan header → 200 (kontrol)');

  sse.destroy(); sse2.destroy();
});

// ─── AUD-5-04: cap subscription + panjang filter ────────────────────────────

test('AUD-5-04: cap total subscription per klien + filter ≤ 1000 karakter', async () => {
  const sse = await sseConnect(pid);

  // filter raksasa → 400
  const bigFilter = 'body = "' + 'A'.repeat(1100) + '"';
  const filt = await req('POST', `/api/p/${pid}/realtime/subscribe`, { clientId: sse.clientId, collection: 'docs', filter: bigFilter }, adminToken);
  assert.equal(filt.status, 400, `filter 1100 karakter harus ditolak (dapat ${filt.status})`);

  // 120 subscribe inkremental → total subs TIDAK boleh melebihi 100
  for (let i = 0; i < 120; i++) {
    await req('POST', `/api/p/${pid}/realtime/subscribe`, { clientId: sse.clientId, collections: ['docs'] }, adminToken);
  }
  const stats = realtimeHub.statsForProject(pid);
  assert.ok(stats.subscriptions <= 100, `total subscription per klien ≤ 100 (dapat ${stats.subscriptions})`);

  sse.destroy();
});

// ─── AUD-5-01: backpressure — subscriber lambat diputus ─────────────────────

test('AUD-5-01: subscriber yang tidak membaca diputus sebelum buffer membesar', async () => {
  const paused = await sseConnect(pid);
  await req('POST', `/api/p/${pid}/realtime/subscribe`, { clientId: paused.clientId, collection: 'docs' }, adminToken);
  paused.sock.pause(); // berhenti membaca — meniru client lambat/malicious

  const reader = await sseConnect(pid);
  await req('POST', `/api/p/${pid}/realtime/subscribe`, { clientId: reader.clientId, collection: 'docs' }, adminToken);

  const blob = 'X'.repeat(100_000); // 100KB per record
  for (let i = 0; i < 60; i++) {
    await req('POST', `/api/p/${pid}/collections/docs/records`, { body: blob }, adminToken);
  }

  // Subscriber paused harus DIPUTUS (dihapus dari hub) — bukan menumpuk buffer
  const start = Date.now();
  let clientsNow = realtimeHub.statsForProject(pid).clients;
  while (clientsNow > 1 && Date.now() - start < 6000) {
    await sleep(100);
    clientsNow = realtimeHub.statsForProject(pid).clients;
  }
  assert.equal(clientsNow, 1, `subscriber lambat harus diputus (clients=${clientsNow}, buffer unbounded tanpa fix)`);

  // Pembaca aktif tetap hidup dan menerima event
  assert.ok(reader.events.filter((e) => e.event === 'PB_CREATE').length >= 50, 'pembaca aktif menerima event (kontrol)');
  reader.destroy(); paused.destroy();
});

// ─── AUD-5-02: webhook SSRF guard ────────────────────────────────────────────

test('AUD-5-02: guard webhook SSRF di create DAN update + IPv6 + tanpa redirect', async () => {
  const catcher: string[] = [];
  const catchSrv = nodeHttp.createServer((q, s) => { catcher.push(`${q.method} ${q.url}`); s.end('ok'); });
  await new Promise<void>((r) => catchSrv.listen(0, '127.0.0.1', () => r()));
  const catchPort = (catchSrv.address() as any).port;

  // Redirect server: 302 → catcher /target
  const redirSrv = nodeHttp.createServer((q, s) => {
    s.writeHead(302, { Location: `http://127.0.0.1:${catchPort}/target` });
    s.end();
  });
  await new Promise<void>((r) => redirSrv.listen(0, '127.0.0.1', () => r()));
  const redirPort = (redirSrv.address() as any).port;

  process.env.WEBHOOK_ALLOW_PRIVATE = 'false';

  // create ke 127.0.0.1 → 400 (guard create — regresi, sudah bekerja)
  const c1 = await req('POST', `/api/admin/projects/${pid}/webhooks`, { name: 'w1', url: `http://127.0.0.1:${catchPort}/x`, events: ['docs.*'] }, adminToken);
  assert.equal(c1.status, 400, 'create ke loopback (env=false) harus 400');

  // create ke [::1] → 400 (sebelumnya lolos — literal check tidak kenal IPv6)
  const c2 = await req('POST', `/api/admin/projects/${pid}/webhooks`, { name: 'w2', url: `http://[::1]:${catchPort}/x`, events: ['docs.*'] }, adminToken);
  assert.equal(c2.status, 400, `create ke [::1] harus 400 (dapat ${c2.status})`);

  // create ke ::ffff:7f00:1 (127.0.0.1 hex-mapped) → 400
  const c3 = await req('POST', `/api/admin/projects/${pid}/webhooks`, { name: 'w3', url: `http://[::ffff:7f00:1]:${catchPort}/x`, events: ['docs.*'] }, adminToken);
  assert.equal(c3.status, 400, `create ke [::ffff:7f00:1] harus 400 (dapat ${c3.status})`);

  // UPDATE bypass: buat dengan host publik (env=true), lalu PATCH ke loopback dengan env=false
  process.env.WEBHOOK_ALLOW_PRIVATE = 'true';
  const created = await req('POST', `/api/admin/projects/${pid}/webhooks`, { name: 'w4', url: 'https://example.com/hook', events: ['docs.*'] }, adminToken);
  const whId = created.data?.webhook?.id;
  process.env.WEBHOOK_ALLOW_PRIVATE = 'false';
  const patched = await req('PATCH', `/api/admin/projects/${pid}/webhooks/${whId}`, { url: `http://127.0.0.1:${catchPort}/pwned` }, adminToken);
  assert.equal(patched.status, 400, `PATCH ke loopback harus 400 — updateWebhook tanpa guard (dapat ${patched.status})`);

  // Redirect: env=true (dev mengizinkan loopback), webhook ke redirect server →
  // fetch TIDAK boleh mengikuti 302 ke target internal
  process.env.WEBHOOK_ALLOW_PRIVATE = 'true';
  const red = await req('POST', `/api/admin/projects/${pid}/webhooks`, { name: 'w5', url: `http://127.0.0.1:${redirPort}/red`, events: ['docs.*'] }, adminToken);
  assert.equal(red.status, 201);
  catcher.length = 0;
  await req('POST', `/api/p/${pid}/collections/docs/records`, { body: 'trigger-redirect' }, adminToken);
  await sleep(6500); // tunggu retry selesai (1s + 4s backoff)
  assert.equal(catcher.some((c) => c.includes('/target')), false,
    'redirect ke target internal TIDAK boleh diikuti (SSRF via redirect)');

  delete process.env.WEBHOOK_ALLOW_PRIVATE;
  catchSrv.close(); redirSrv.close();
});

// ─── AUD-5-03: limit koneksi SSE ─────────────────────────────────────────────

test('AUD-5-03: koneksi SSE dibatasi (per-project via env override)', async () => {
  process.env.REALTIME_MAX_CONN_PER_PROJECT = '5';
  const conns: SseConn[] = [];
  for (let i = 0; i < 5; i++) {
    conns.push(await sseConnect(pid2));
  }
  const stats = realtimeHub.statsForProject(pid2);
  assert.equal(stats.clients, 5, 'lima koneksi pertama diterima');

  // koneksi ke-6 → 429
  const status6 = await sseStatus(pid2);
  assert.equal(status6, 429, `koneksi ke-6 harus 429 (dapat ${status6})`);

  for (const c of conns) c.destroy();
  delete process.env.REALTIME_MAX_CONN_PER_PROJECT;
  await sleep(200);
});

test('AUD-5-03b: per-IP limit untuk IP publik; IP privat (proxy) diskip', async () => {
  // Fake ServerResponse — uji logika limit hub secara unit
  const fakes: { res: any; close(): void }[] = [];
  const mkFake = () => {
    const handlers: Record<string, () => void> = {};
    const res: any = {
      writeHead: () => {}, flushHeaders: () => {}, write: () => true,
      on: (ev: string, fn: () => void) => { handlers[ev] = fn; },
      destroy: () => { handlers['close']?.(); },
      writableLength: 0,
    };
    return { res, close: () => { handlers['close']?.(); } };
  };

  // IP publik: ke-11 ditolak (default 10)
  const PUBLIC_IP = '203.0.113.10';
  let accepted = 0;
  for (let i = 0; i < 12; i++) {
    const f = mkFake();
    const c = realtimeHub.connect(f.res, { auth: null }, 'aud5-unit-public', PUBLIC_IP);
    if (c) { accepted++; fakes.push(f); }
  }
  assert.equal(accepted, 10, `IP publik dibatasi 10 koneksi (dapat ${accepted})`);

  // IP privat (127.0.0.1 — skenario reverse proxy): per-IP diskip
  let acceptedPriv = 0;
  for (let i = 0; i < 12; i++) {
    const f = mkFake();
    const c = realtimeHub.connect(f.res, { auth: null }, 'aud5-unit-priv', '127.0.0.1');
    if (c) { acceptedPriv++; fakes.push(f); }
  }
  assert.equal(acceptedPriv, 12, 'IP privat/loopback (proxy) tidak dibatasi per-IP');

  for (const f of fakes) f.close();
});
