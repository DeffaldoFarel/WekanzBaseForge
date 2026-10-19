// ============================================================================
// AUD-3-01..04 (FASE 3: Sandbox Functions & Isolasi) — repro & regression
//
// AUD-3-01 🔴 public execute TANPA rate limit (tiap call = 1 isolate V8 baru,
//          hingga 256MB/120s) → 30/menit per (project, IP), 429 RATE_LIMITED.
// AUD-3-02 🟡 scheduler tidak menyuntik onDbWrite → tulisan $d dari cron
//          TIDAK PERNAH memicu trigger (kontrak header bilang seharusnya bisa).
// AUD-3-03 🔵 Proxy $env "read-only" bisa dilewati via __envSource global.
// AUD-3-04 ⚪ pesan blok SSRF terbungkus "DNS lookup failed" (menyesatkan).
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import nodeHttp from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { initPlatformDb, closePlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs, getProjectDb } from '../src/core/projectDbManager.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';
import { createProjectAuthRouter } from '../src/api/authRoutes.js';
import { createPublicRouter } from '../src/api/publicRoutes.js';
import { createFunctionRouter } from '../src/api/functionRoutes.js';
import { Router } from '../src/core/router.js';
import { runFunctionCode } from '../src/core/functionRunner.js';
import { scheduler } from '../src/core/scheduler.js';
import { assertPublicHost } from '../src/core/httpSandbox.js';

// ─── Harness (pola m15a) ─────────────────────────────────────────────────────

let server: nodeHttp.Server;
let baseURL = '';
let pid: string;
let adminToken: string;
const TEST_DATA_DIR = path.join(process.env.TEMP ?? '/tmp', 'baseforge-aud3-test');

async function http(method: string, reqPath: string, body?: unknown, token?: string): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, baseURL);
    const req = nodeHttp.request(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bear' + 'er ' + token } : {}),
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
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function waitFor(predicate: () => boolean, maxMs = 4000): Promise<boolean> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > maxMs) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

before(async () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  process.env.DATA_DIR = TEST_DATA_DIR;
  process.env.ADMIN_EMAIL = 'admin@test.local';
  process.env.ADMIN_PASSWORD = 'admin-test-pass';

  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());
  router.merge(createProjectAuthRouter());
  router.merge(createPublicRouter());
  router.merge(createFunctionRouter());

  server = nodeHttp.createServer((req, res) => {
    router.handle(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });
  baseURL = `http://localhost:${(server.address() as { port: number }).port}`;

  const login = await http('POST', '/api/admin/auth/login', { email: 'admin@test.local', password: 'admin-test-pass' });
  adminToken = login.data.token;

  const proj = await http('POST', '/api/admin/projects', { name: 'aud3' }, adminToken);
  pid = proj.data.project.id;

  await http('POST', `/api/admin/projects/${pid}/collections`, { name: 'events', fields: [{ name: 'label', type: 'text' }] }, adminToken);
  await http('POST', `/api/admin/projects/${pid}/collections`, { name: 'marks', fields: [{ name: 'label', type: 'text' }] }, adminToken);
});

after(async () => {
  scheduler.stop();
  scheduler.resetRunHistory();
  closeAllProjectDbs();
  // Windows: rmSync gagal EPERM selama handle platform.db masih terbuka.
  closePlatformDb();
  server.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─── AUD-3-01: rate limit public execute ─────────────────────────────────────

test('AUD-3-01: public execute kena rate limit 30/menit per project+IP', async () => {
  const mk = await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'ping',
    code: `return 'pong';`,
    callable: true,
  }, adminToken);
  assert.equal(mk.status, 201);

  let ok200 = 0;
  let limited = 0;
  for (let i = 0; i < 35; i++) {
    const r = await http('POST', `/api/p/${pid}/functions/ping/execute`, { body: {} });
    if (r.status === 200) ok200++;
    else if (r.status === 429 && r.data?.error?.code === 'RATE_LIMITED') limited++;
    else throw new Error(`status tak terduga ${r.status}: ${JSON.stringify(r.data).slice(0, 120)}`);
  }
  assert.equal(ok200, 30, `tepat 30 panggilan pertama boleh lolos (dapat ${ok200})`);
  assert.equal(limited, 5, `panggilan 31-35 harus ditolak 429 RATE_LIMITED (dapat ${limited})`);
});

// ─── AUD-3-02: tulisan $db dari cron MEMICU trigger ──────────────────────────

test('AUD-3-02: tulisan $db dari function cron memicu trigger (reaksi menyala)', async () => {
  const c1 = await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'cron_w',
    code: `await $db.collection('events').create({ label: 'from-cron' }); return 'ok';`,
    schedule: '* * * * *',
    dbAccess: true,
    timeoutMs: 5000,
  }, adminToken);
  assert.equal(c1.status, 201);
  const c2 = await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'reactor',
    code: `await $db.collection('marks').create({ label: 'reacted' }); return 'ok';`,
    dbAccess: true,
    timeoutMs: 5000,
    triggers: [{ collection: 'events', actions: ['create'] }],
  }, adminToken);
  assert.equal(c2.status, 201);

  scheduler.start([() => getProjectDb(pid)]);
  scheduler.resetRunHistory();
  scheduler.forceTick();

  const db = getProjectDb(pid);
  const count = (t: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;

  const reacted = await waitFor(() => count('marks') === 1, 4000);
  assert.ok(
    reacted,
    `reaksi trigger harus menyala dari tulisan cron (events=${count('events')}, marks=${count('marks')}) — kontrak header scheduler: "tulisan $db BOLEH memicu trigger"`
  );
  assert.equal(count('events'), 1, 'cron menulis tepat satu event');

  // Anti double-fire tetap utuh: tick kedua di menit yang sama tidak menambah apa pun
  scheduler.forceTick();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(count('events'), 1, 'cron tidak boleh double-fire di menit yang sama');
  assert.equal(count('marks'), 1, 'reaksi tidak boleh jalan dua kali');

  scheduler.stop();
  scheduler.resetRunHistory();
});

// ─── AUD-3-03: $env read-only benar-benar read-only ──────────────────────────

test('AUD-3-03: $env read-only tidak bisa dilewati via __envSource', async () => {
  const r = await runFunctionCode(`
    let raw;
    try { raw = JSON.stringify(__envSource); } catch (e) { raw = 'ERR:' + String(e); }
    let writeThrough = 'n/a';
    try { __envSource.MARKER = 'PWNED'; writeThrough = $env.MARKER; } catch (e) { writeThrough = 'ERR:' + String(e); }
    return { raw, readViaProxy: $env.MARKER, writeThrough };
  `, { secrets: { MARKER: 'S3CRET-VALUE' } });
  assert.ok(r.ok, `function harus sukses: ${r.error}`);
  const res = r.result as { raw: string; readViaProxy: string; writeThrough: string };
  assert.equal(res.raw, '{}', `__envSource harus umpan kosong, bukan objek sekret (dapat ${res.raw})`);
  assert.equal(res.readViaProxy, 'S3CRET-VALUE', '$env tetap berfungsi lewat Proxy');
  assert.equal(res.writeThrough, 'S3CRET-VALUE', `tulis ke __envSource TIDAK boleh mengubah nilai $env (dapat ${res.writeThrough})`);
});

// ─── AUD-3-04: pesan blok SSRF tidak menyesatkan ─────────────────────────────

test('AUD-3-04: pesan blok SSRF murni + isPrivateIp mengenali IPv6 hex-mapped', async () => {
  // Bentuk TANPA kurung (jalur literal net.isIP): '::ffff:7f00:1' = 127.0.0.1
  // dalam hex — sebelumnya lolos sebagai "IP publik" karena isPrivateIp hanya
  // mengenali bentuk desimal ::ffff:127.0.0.1. Harus ditolak sebagai IP privat.
  await assert.rejects(
    assertPublicHost('::ffff:7f00:1', 80, []),
    (err: Error) => /private/i.test(err.message) && !err.message.includes('DNS lookup failed')
  );
  // Bentuk TERKURUNG (jalur nyata $http — URL.hostname menyertakan kurung):
  // harus ditolak sebagai IP privat dengan pesan blok MURNI — di SEMUA
  // platform. Dulu jalur ini bergantung pada getaddrinfo: Windows
  // menormalkan literal berkutub (→ "resolves to private IP"), Linux
  // menolaknya (→ terbungkus "DNS lookup failed"). Kini kurung di-strip
  // sebelum cek literal, jadi hasilnya identik mana-mana.
  await assert.rejects(
    assertPublicHost('[::ffff:7f00:1]', 80, []),
    (err: Error) => /private/i.test(err.message) && !err.message.includes('DNS lookup failed')
  );
  // Kontrol: kegagalan DNS betulan tetap dilaporkan sebagai kegagalan DNS.
  await assert.rejects(
    assertPublicHost('nonexistent-aud3.invalid', 80, []),
    /DNS lookup failed/
  );
});
