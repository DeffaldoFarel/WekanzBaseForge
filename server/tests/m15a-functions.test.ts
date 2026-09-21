// ============================================================================
// M15a: TEST FUNCTIONS — sandbox vm + CRUD + execute via HTTP nyata
//
// PROOF keamanan & fungsi:
// 1. process/require TIDAK ADA di sandbox
// 2. while(true) dihentikan oleh timeout (bukan crash server!)
// 3. console.log tertangkap & dibatasi
// 4. req.body/query/auth masuk; return value keluar sebagai JSON
// 5. CRUD function + unique name + public hanya jika enabled
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
import { createFunctionRouter } from '../src/api/functionRoutes.js';
import { Router } from '../src/core/router.js';
import { runFunctionCode } from '../src/core/functionRunner.js';

// ─── State & server ──────────────────────────────────────────────────────────

let server: nodeHttp.Server;
let baseURL = '';
const TEST_DATA_DIR = path.resolve('../data/m15a-test');

let pid: string;
let adminToken: string;
let tokenA: string;

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
  router.merge(createRealtimeRouter());
  router.merge(createFunctionRouter());

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

  const proj = await http('POST', '/api/admin/projects', { name: 'm15a' }, adminToken);
  pid = proj.data.project.id;

  const reg = await http('POST', `/api/p/${pid}/auth/register`, { email: 'a@m15.test', password: 'passwordA123' });
  tokenA = reg.data.accessToken;
});

after(async () => {
  closeAllProjectDbs();
  // Windows: rmSync gagal EPERM selama handle platform.db masih terbuka.
  closePlatformDb();
  server.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─── Sandbox unit tests ──────────────────────────────────────────────────────

test('M15a: sandbox — process & require TIDAK ADA', async () => {
  const result = await runFunctionCode(`return typeof process + '/' + typeof require;`);
  assert.ok(result.ok);
  assert.equal(result.result, 'undefined/undefined', 'host harus tak terlihat!');
});

test('M15a: sandbox — globalThis bersih dari fs/os', async () => {
  const result = await runFunctionCode(`
    const keys = Object.getOwnPropertyNames(globalThis);
    return keys.filter(k => ['fs','os','child_process','process','require','Buffer','global'].includes(k));
  `);
  assert.ok(result.ok);
  assert.deepEqual(result.result, [], 'tidak boleh ada host globals yang bocor');
});

test('M15a: infinite loop dihentikan timeout (server selamat!)', async () => {
  const result = await runFunctionCode(`while(true) {}`, { timeoutMs: 300 });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.ok(/timeout/.test(result.error ?? ''));
  assert.ok(result.durationMs < 3000, 'timeout harus bekerja cepat');
});

test('M15a: console.log tertangkap & dibatasi', async () => {
  const result = await runFunctionCode(`
    for (let i = 0; i < 150; i++) console.log('baris', i);
    return 'selesai';
  `);
  assert.ok(result.ok);
  assert.equal(result.logs.length, 101); // 100 baris + 1 potongan
  assert.ok(result.logs[100].includes('truncated'));
});

test('M15a: req masuk, return keluar', async () => {
  const result = await runFunctionCode(`
    const total = (req.body.harga || 0) * (req.body.qty || 0);
    console.log('hitung', total);
    return { total, dari: req.query.sumber ?? 'tidak diketahui', user: req.auth?.email ?? 'anon' };
  `, {
    body: { harga: 5000, qty: 3 },
    query: { sumber: 'kasir' },
    auth: { id: 'u1', email: 'budi@x.com' },
  });
  assert.ok(result.ok);
  assert.deepEqual(result.result, { total: 15000, dari: 'kasir', user: 'budi@x.com' });
});

// ─── Integration: CRUD + execute via HTTP ────────────────────────────────────

test('M15a: admin buat function → tersimpan (schema-as-data)', async () => {
  const res = await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'hitung_total',
    code: `return { total: (req.body.harga||0) * (req.body.qty||0) };`,
  }, adminToken);
  assert.equal(res.status, 201);
  assert.equal(res.data.function.name, 'hitung_total');
  assert.equal(res.data.function.enabled, true);
});

test('M15a: nama duplikat → 409; nama invalid → 400', async () => {
  const dup = await http('POST', `/api/admin/projects/${pid}/functions`, { name: 'hitung_total', code: 'return 1;' }, adminToken);
  assert.equal(dup.status, 409);

  const invalid = await http('POST', `/api/admin/projects/${pid}/functions`, { name: 'Invalid-Name', code: 'return 1;' }, adminToken);
  assert.equal(invalid.status, 400);
});

test('M15a: execute via admin → hasil + logs', async () => {
  const res = await http('POST', `/api/admin/projects/${pid}/functions/hitung_total/execute`, { body: { harga: 10000, qty: 2 } }, adminToken);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.result, { total: 20000 });
});

test('M15a: execute via public (end user) → function enabled bisa dipanggil', async () => {
  const res = await http('POST', `/api/p/${pid}/functions/hitung_total/execute`, { body: { harga: 7000, qty: 1 } }, tokenA);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.result, { total: 7000 });
});

test('M15a: function disabled → public 403, admin tetap bisa', async () => {
  await http('POST', `/api/admin/projects/${pid}/functions`, { name: 'internal_only', code: 'return "rahasia";', enabled: false }, adminToken);

  const pub = await http('POST', `/api/p/${pid}/functions/internal_only/execute`, {}, tokenA);
  assert.equal(pub.status, 403, 'disabled → public ditolak');

  const adm = await http('POST', `/api/admin/projects/${pid}/functions/internal_only/execute`, {}, adminToken);
  assert.equal(adm.status, 200, 'admin tetap bisa (debug)');
  assert.equal(adm.data.result, 'rahasia');
});

test('M15a: error runtime → FUNCTION_ERROR dengan pesan jelas (server tetap hidup)', async () => {
  await http('POST', `/api/admin/projects/${pid}/functions`, { name: 'boom', code: `return undefinedVariable.lala;` }, adminToken);

  const res = await http('POST', `/api/p/${pid}/functions/boom/execute`, {}, tokenA);
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, 'FUNCTION_ERROR');
  assert.ok(/undefinedVariable/.test(res.data.error.message));
});

test('M15a: infinite loop via HTTP → error timeout (bukan hang)', async () => {
  await http('POST', `/api/admin/projects/${pid}/functions`, { name: 'loop', code: `while(true){}`, timeoutMs: 300 }, adminToken);

  const start = Date.now();
  const res = await http('POST', `/api/p/${pid}/functions/loop/execute`, {}, tokenA);
  const dur = Date.now() - start;

  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, 'FUNCTION_ERROR');
  assert.ok(/timeout/.test(res.data.error.message));
  assert.ok(dur < 5000, 'request harus selesai cepat, bukan hang');
});

test('M15a: PATCH ubah code & DELETE', async () => {
  await http('POST', `/api/admin/projects/${pid}/functions`, { name: 'editable', code: 'return "v1";' }, adminToken);

  const patched = await http('PATCH', `/api/admin/projects/${pid}/functions/editable`, { code: 'return "v2";' }, adminToken);
  assert.equal(patched.status, 200);

  const exec = await http('POST', `/api/admin/projects/${pid}/functions/editable/execute`, {}, adminToken);
  assert.equal(exec.data.result, 'v2');

  const del = await http('DELETE', `/api/admin/projects/${pid}/functions/editable`, undefined, adminToken);
  assert.equal(del.status, 200);
  const gone = await http('GET', `/api/admin/projects/${pid}/functions/editable`, undefined, adminToken);
  assert.equal(gone.status, 404);
});
