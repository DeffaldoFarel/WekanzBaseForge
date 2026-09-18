// ============================================================================
// M44: TEST FUNCTION LIMITS — configurable + measured
//
// PROOF:
// 1. Plafon timeout 120s diterima; >120s ditolak; default 2000ms tak berubah
// 2. memory_mb configurable (16–256); di luar rentang ditolak; default 32
// 3. memoryMb tersimpan & dibulatkan lewat API
// 4. Isolate benar-benar dibatasi memory_mb kustom (alokasi besar OOM di 32MB,
//    sukses di 256MB)
// 5. Execute mengembalikan memoryMb (observability)
// 6. Fungsi berat nyata: agregasi dalam satu eksekusi masih di bawah plafon
// 7. Rute invoke memakai memory_mb milik function (bukan default runner)
// 8. PATCH timeoutMs ke 60s diterima (bukti plafon baru dipakai)
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import nodeHttp from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initPlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs, getProjectDb } from '../src/core/projectDbManager.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';
import { createProjectAuthRouter } from '../src/api/authRoutes.js';
import { createPublicRouter } from '../src/api/publicRoutes.js';
import { createFunctionRouter } from '../src/api/functionRoutes.js';
import { Router } from '../src/core/router.js';
import { runFunctionCode } from '../src/core/functionRunner.js';

let server: nodeHttp.Server;
let baseURL = '';
const TEST_DATA_DIR = path.join(os.tmpdir(), `bf-m44-${Date.now()}`);

let pid: string;
let adminToken: string;

const AUTH_HEADER = 'Authorization';
const bearer = (t: string): string => ['Bearer', t].join(' ');

async function http(method: string, reqPath: string, body?: unknown, token?: string): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers[AUTH_HEADER] = bearer(token);
    const req = nodeHttp.request(new URL(reqPath, baseURL), { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let data: any = null;
        try { data = JSON.parse(text); } catch { /* non-JSON */ }
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
  router.merge(createFunctionRouter());

  server = nodeHttp.createServer((req, res) => { router.handle(req, res); });
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      baseURL = `http://localhost:${addr.port}`;
      resolve();
    });
  });

  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@test.local', password: 'admin-test-pass',
  });
  assert.equal(login.status, 200);
  adminToken = login.data.token;

  const proj = await http('POST', '/api/admin/projects', { name: 'm44' }, adminToken);
  assert.equal(proj.status, 201);
  pid = proj.data.project.id;
});

after(async () => {
  closeAllProjectDbs();
  server.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─── 1. Plafon timeout 120s ──────────────────────────────────────────────────

test('M44: timeoutMs 120s diterima; >120s ditolak; default 2000ms tak berubah', async () => {
  const ok = await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'long_fn', code: 'return 1;', timeoutMs: 120_000,
  }, adminToken);
  assert.equal(ok.status, 201, `120s harus diterima, dapat ${ok.status}`);
  assert.equal(ok.data.function.timeoutMs, 120_000);

  const tooLong = await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'too_long_fn', code: 'return 1;', timeoutMs: 120_001,
  }, adminToken);
  assert.equal(tooLong.status, 400, '>120s harus 400');
  assert.match(String(tooLong.data.error.message), /120000/, 'pesan menyebut plafon baru');

  const def = await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'plain_fn', code: 'return 1;',
  }, adminToken);
  assert.equal(def.status, 201);
  assert.equal(def.data.function.timeoutMs, 2000, 'default tetap 2000ms — function biasa tak berubah');
});

// ─── 2. memory_mb configurable + validasi ────────────────────────────────────

test('M44: memoryMb 16–256 diterima; di luar rentang & non-integer ditolak; default 32', async () => {
  const ok256 = await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'big_fn', code: 'return 1;', memoryMb: 256,
  }, adminToken);
  assert.equal(ok256.status, 201);
  assert.equal(ok256.data.function.memoryMb, 256);

  const ok16 = await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'tiny_fn', code: 'return 1;', memoryMb: 16,
  }, adminToken);
  assert.equal(ok16.status, 201);
  assert.equal(ok16.data.function.memoryMb, 16);

  for (const [label, val] of [['8 MB (terlalu kecil)', 8], ['512 MB (terlalu besar)', 512], ['non-integer', 32.5]] as const) {
    const bad = await http('POST', `/api/admin/projects/${pid}/functions`, {
      name: `bad_${label.replace(/\W/g, '')}`, code: 'return 1;', memoryMb: val,
    }, adminToken);
    assert.equal(bad.status, 400, `${label} harus 400`);
  }

  const def = await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'defmem_fn', code: 'return 1;',
  }, adminToken);
  assert.equal(def.data.function.memoryMb, 32, 'default memoryMb harus 32');
});

// ─── 3. PATCH memoryMb & timeoutMs ───────────────────────────────────────────

test('M44: PATCH memoryMb & timeoutMs diteruskan; undefined tidak disentuh', async () => {
  const upd = await http('PATCH', `/api/admin/projects/${pid}/functions/plain_fn`, {
    memoryMb: 128, timeoutMs: 60_000,
  }, adminToken);
  assert.equal(upd.status, 200);
  assert.equal(upd.data.function.memoryMb, 128);
  assert.equal(upd.data.function.timeoutMs, 60_000, 'timeout 60s diterima (plafon baru)');

  const untouched = await http('PATCH', `/api/admin/projects/${pid}/functions/plain_fn`, {
    timeoutMs: 5_000,
  }, adminToken);
  assert.equal(untouched.data.function.memoryMb, 128, 'memoryMb tidak boleh berubah tanpa diminta');
});

// ─── 4. Isolate benar-benar dibatasi memory_mb ───────────────────────────────

test('M44: plafon memory_mb benar-benar diberlakukan (OOM di kecil, lolos di besar)', async () => {
  // Alokasi array-of-chunks (~80 MB) — BUKAN satu string raksasa, karena string
  // raksasa kena batas panjang V8 (konstan, bukan heap) sehingga tidak
  // mendiskriminasi plafon. Array besar kena plafon HEAP isolate.
  // Ini sekaligus membuktikan runner SELAMAT dari OOM sungguhan (tidak crash).
  const hungry = `const chunks = []; for (let i = 0; i < 10; i++) chunks.push(new Array(1024 * 1024).fill(i)); return chunks.length;`;

  const small = await runFunctionCode(hungry, { memoryLimitMb: 32, timeoutMs: 15_000 });
  assert.equal(small.ok, false, 'harus OOM pada plafon memori kecil');
  assert.equal(small.oom, true, 'harus ditandai oom');
  assert.match(String(small.error), /memory limit/i);
  assert.equal(small.memoryMb, 32, 'result harus mencatat plafon yang dipakai');

  const big = await runFunctionCode(hungry, { memoryLimitMb: 256, timeoutMs: 15_000 });
  assert.ok(big.ok, `harus lolos pada plafon memori besar, dapat: ${big.error}`);
  assert.equal(big.memoryMb, 256);
});

// ─── 5. Execute mengembalikan memoryMb ───────────────────────────────────────

test('M44: execute mengembalikan memoryMb untuk observability', async () => {
  const fn = await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'observe_fn', code: 'return 42;', memoryMb: 96,
  }, adminToken);
  assert.equal(fn.status, 201);

  const exec = await http('POST', `/api/admin/projects/${pid}/functions/observe_fn/execute`, {}, adminToken);
  assert.equal(exec.status, 200);
  assert.equal(exec.data.memoryMb, 96, 'execute harus mengembalikan memoryMb milik function');
});

// ─── 6. Fungsi berat nyata masih di bawah plafon ────────────────────────────

test('M44: agregasi $db dalam satu eksekusi selesai di bawah plafon default', async () => {
  const db = getProjectDb(pid);
  // Siapkan collection + 150 record
  await http('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'rows', fields: [{ name: 'n', type: 'number' }],
  }, adminToken);

  const seed = await runFunctionCode(
    `for (let i = 0; i < 150; i++) await $db.collection('rows').create({ n: i }); return 'seeded';`,
    { projectDb: db, dbAccess: true, maxDbCalls: 400, timeoutMs: 30_000 }
  );
  assert.ok(seed.ok, `seed gagal: ${seed.error}`);

  const agg = await runFunctionCode(
    `const res = await $db.collection('rows').list({ perPage: 500 });
     let s = 0; for (const r of res.items) s += r.n;
     return { sum: s, count: res.items.length };`,
    { projectDb: db, dbAccess: true, timeoutMs: 15_000, memoryLimitMb: 64 }
  );
  assert.ok(agg.ok, `agregasi gagal: ${agg.error}`);
  const r = agg.result as { sum: number; count: number };
  assert.equal(r.sum, 11175);
  assert.equal(r.count, 150);
  assert.ok(agg.durationMs < 15_000, `harus jauh di bawah plafon, durasi ${agg.durationMs}ms`);
});

// ─── 7. Invoke memakai memory_mb milik function ──────────────────────────────

test('M44: invoke memakai memory_mb milik function, bukan default runner', async () => {
  // Function dengan memory 64 MB yang mengalokasikan ~40 MB string.
  // Di 32 MB (default runner lama) ini gagal; di 64 MB harus lolos.
  const fn = await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'needsmem_fn',
    code: `const c = []; for (let i = 0; i < 5; i++) c.push(new Array(1024 * 1024).fill(i)); return c.length;`,
    memoryMb: 64,
    timeoutMs: 15_000,
  }, adminToken);
  assert.equal(fn.status, 201);

  const exec = await http('POST', `/api/admin/projects/${pid}/functions/needsmem_fn/execute`, {}, adminToken);
  // Admin execute mengembalikan FunctionRunResult apa adanya (200 bila ok,
  // 400 bila function error). Di 64MB harus sukses — bila invoke salah memakai
  // default 32MB, ini akan gagal (Invalid string length / OOM).
  assert.equal(exec.status, 200, `harus sukses di 64MB (bukan gagal di 32), dapat: ${JSON.stringify(exec.data).slice(0, 200)}`);
  assert.equal(exec.data.memoryMb, 64, 'invoke harus memakai memory_mb milik function');
});

// ─── 8. Plafon lama (30s) tidak lagi membatasi ───────────────────────────────

test('M44: timeoutMs 45s (di atas plafon lama 30s) diterima', async () => {
  const fn = await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'fortyfive_fn', code: 'return 1;', timeoutMs: 45_000,
  }, adminToken);
  assert.equal(fn.status, 201, 'plafon lama 30s tidak lagi membatasi');
  assert.equal(fn.data.function.timeoutMs, 45_000);
});
