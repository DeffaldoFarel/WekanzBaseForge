// ============================================================================
// M43: TEST MODULE REGISTRY — `$lib` untuk functions
//
// PROOF:
// 1. CRUD modul lewat Admin API
// 2. Modul JS (exports.x) terbaca sebagai $lib.<name>.x
// 3. Modul TS (export + interface + type annotation) di-strip & berfungsi
// 4. module.exports gaya CJS didukung
// 5. Dependensi antar-modul: modul B memakai modul A lewat $lib (urutan eval)
// 6. Kasus dashboard: domain.ts-like TS dengan interface + multi-export
// 7. Error jelas: modul tidak ditemukan, sintaks rusak
// 8. Batas dipaksa: format nama, >10 modul/function, >256KB ditolak
// 9. Rute execute membawa $lib dari registry
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
import { setModule } from '../src/core/moduleRegistry.js';

let server: nodeHttp.Server;
let baseURL = '';
const TEST_DATA_DIR = path.join(os.tmpdir(), `bf-m43-${Date.now()}`);

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

  const proj = await http('POST', '/api/admin/projects', { name: 'm43' }, adminToken);
  assert.equal(proj.status, 201);
  pid = proj.data.project.id;
});

after(async () => {
  closeAllProjectDbs();
  server.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─── 1. CRUD via Admin API ───────────────────────────────────────────────────

test('M43: CRUD modul via Admin API', async () => {
  const put = await http('PUT', `/api/admin/projects/${pid}/modules/mathx`, {
    code: 'exports.double = function(n) { return n * 2; };',
  }, adminToken);
  assert.equal(put.status, 200, `PUT modul harus 200, dapat ${put.status}`);

  const list = await http('GET', `/api/admin/projects/${pid}/modules`, undefined, adminToken);
  assert.equal(list.status, 200);
  const names = list.data.modules.map((m: any) => m.name);
  assert.ok(names.includes('mathx'), 'modul harus muncul di list');
  const meta = list.data.modules.find((m: any) => m.name === 'mathx');
  assert.ok(meta.sizeBytes > 0, 'sizeBytes harus diisi');

  const got = await http('GET', `/api/admin/projects/${pid}/modules/mathx`, undefined, adminToken);
  assert.equal(got.status, 200);
  assert.ok(got.data.module.code.includes('double'), 'GET satu modul mengembalikan kode');

  const del = await http('DELETE', `/api/admin/projects/${pid}/modules/mathx`, undefined, adminToken);
  assert.equal(del.status, 200);
  const after = await http('GET', `/api/admin/projects/${pid}/modules/mathx`, undefined, adminToken);
  assert.equal(after.status, 404, 'modul terhapus harus 404');
});

// ─── 2. Modul JS (exports.x) ─────────────────────────────────────────────────

test('M43: modul JS exports.x terbaca sebagai $lib.<name>.x', async () => {
  const db = getProjectDb(pid);
  setModule(db, 'mathx', 'exports.double = function(n) { return n * 2; }; exports.ANSWER = 42;');

  const result = await runFunctionCode(
    `return { doubled: $lib.mathx.double(21), answer: $lib.mathx.ANSWER };`,
    { projectDb: db, modules: ['mathx'], timeoutMs: 8000 }
  );
  assert.ok(result.ok, `run gagal: ${result.error}`);
  const r = result.result as { doubled: number; answer: number };
  assert.equal(r.doubled, 42);
  assert.equal(r.answer, 42);
});

// ─── 3. Modul TS (export + interface + tipe) di-strip ───────────────────────

test('M43: modul TS dengan interface + type annotation di-strip & berfungsi', async () => {
  const db = getProjectDb(pid);
  // Bentuk yang sama dengan shared/domain.ts dashboard: interface + fungsi bertipe
  setModule(db, 'domain_ts', `
export interface HabitData { name: string; selectedDays: number[]; }
export function calculateStreak(habit: HabitData, logs: number[]): number {
  let streak = 0;
  for (const d of logs) { if (habit.selectedDays.includes(d)) streak++; }
  return streak;
}
export const VERSION: string = '1.0.0';
  `);

  const result = await runFunctionCode(
    `const streak = $lib.domain_ts.calculateStreak({ name: 'gym', selectedDays: [1, 3, 5] }, [1, 3, 5, 7]);
     return { streak: streak, version: $lib.domain_ts.VERSION };`,
    { projectDb: db, modules: ['domain_ts'], timeoutMs: 8000 }
  );
  assert.ok(result.ok, `run gagal: ${result.error}`);
  const r = result.result as { streak: number; version: string };
  assert.equal(r.streak, 3, 'logika modul harus berjalan benar');
  assert.equal(r.version, '1.0.0');
});

// ─── 4. module.exports gaya CJS ──────────────────────────────────────────────

test('M43: module.exports gaya CJS didukung', async () => {
  const db = getProjectDb(pid);
  setModule(db, 'greeter', `module.exports = { hello: function(name) { return 'hi ' + name; } };`);

  const result = await runFunctionCode(
    `return $lib.greeter.hello('wekanz');`,
    { projectDb: db, modules: ['greeter'], timeoutMs: 8000 }
  );
  assert.ok(result.ok, `run gagal: ${result.error}`);
  assert.equal(result.result, 'hi wekanz');
});

// ─── 5. Dependensi antar-modul (urutan eval) ─────────────────────────────────

test('M43: modul B memakai modul A lewat $lib (urutan eval dipertahankan)', async () => {
  const db = getProjectDb(pid);
  setModule(db, 'base_lib', 'exports.triple = function(n) { return n * 3; };');
  setModule(db, 'derived_lib', 'exports.triplePlusOne = function(n) { return $lib.base_lib.triple(n) + 1; };');

  const result = await runFunctionCode(
    `return $lib.derived_lib.triplePlusOne(10);`,
    { projectDb: db, modules: ['base_lib', 'derived_lib'], timeoutMs: 8000 }
  );
  assert.ok(result.ok, `run gagal: ${result.error}`);
  assert.equal(result.result, 31, 'derived harus memakai base (3*10+1)');
});

// ─── 6. Kasus dashboard: multi-export domain ─────────────────────────────────

test('M43: kasus dashboard — satu modul domain dipakai banyak function', async () => {
  const db = getProjectDb(pid);
  setModule(db, 'billing', `
export function isBillVisible(bill: { startMonth: number }, currentMonth: number): boolean {
  return currentMonth >= bill.startMonth;
}
export function computeMonthlyBillSummary(bills: Array<{ amount: number }>): number {
  return bills.reduce(function(s, b) { return s + b.amount; }, 0);
}
  `);

  // Dua function berbeda memakai SATU modul yang sama — bukti tujuan M43
  const fn1 = await runFunctionCode(
    `const bills = [{ amount: 100 }, { amount: 250 }];
     return $lib.billing.computeMonthlyBillSummary(bills);`,
    { projectDb: db, modules: ['billing'], timeoutMs: 8000 }
  );
  const fn2 = await runFunctionCode(
    `return $lib.billing.isBillVisible({ startMonth: 3 }, 9);`,
    { projectDb: db, modules: ['billing'], timeoutMs: 8000 }
  );
  assert.ok(fn1.ok && fn2.ok);
  assert.equal(fn1.result, 350);
  assert.equal(fn2.result, true);
});

// ─── 7. Error jelas ──────────────────────────────────────────────────────────

test('M43: modul tidak ditemukan → error jelas', async () => {
  const db = getProjectDb(pid);
  const result = await runFunctionCode(
    `return 1;`,
    { projectDb: db, modules: ['does_not_exist'], timeoutMs: 8000 }
  );
  assert.equal(result.ok, false, 'harus gagal');
  assert.match(String(result.error), /not found/i, 'pesan harus menyebut modul tidak ditemukan');
});

test('M43: sintaks modul rusak → ditolak saat disimpan', async () => {
  const db = getProjectDb(pid);
  assert.throws(
    () => setModule(db, 'broken', 'export function unclosed( {'),
    /syntax error/i,
    'modul rusak harus ditolak saat setModule'
  );
});

// ─── 8. Batas dipaksa ────────────────────────────────────────────────────────

test('M43: batas — format nama, >10 modul/function, >256KB', async () => {
  const db = getProjectDb(pid);

  // Format nama
  for (const bad of ['Upper', '1digit', 'has-dash', 'has space']) {
    assert.throws(() => setModule(db, bad, 'exports.x = 1;'), /Invalid module name/,
      `nama '${bad}' harus ditolak`);
  }

  // >10 modul per function → error saat build prelude
  const many = Array.from({ length: 11 }, (_, i) => `m${i}`);
  for (const m of many) setModule(db, m, 'exports.x = 1;');
  const result = await runFunctionCode(`return 1;`, {
    projectDb: db, modules: many, timeoutMs: 8000,
  });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /at most 10/i);

  // >256 KB ditolak
  const tooBig = 'exports.x = "' + 'y'.repeat(256 * 1024) + '";';
  assert.throws(() => setModule(db, 'huge', tooBig), /256 KB|exceeds/i);
});

// ─── 9. Rute execute membawa $lib dari registry ──────────────────────────────

test('M43: rute execute membawa $lib dari registry', async () => {
  // Modul lewat API
  const put = await http('PUT', `/api/admin/projects/${pid}/modules/utilx`, {
    code: 'exports.shout = function(s) { return s.toUpperCase(); };',
  }, adminToken);
  assert.equal(put.status, 200);

  // Function yang menautkan modul
  const fn = await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'use_lib_fn',
    code: 'return $lib.utilx.shout("hello lib");',
    modules: ['utilx'],
  }, adminToken);
  assert.equal(fn.status, 201, `create function harus 201, dapat ${fn.status}: ${JSON.stringify(fn.data)}`);
  assert.deepEqual(fn.data.function.modules, ['utilx'], 'modules harus tersimpan');

  // Execute — $lib harus otomatis terisi dari registry
  const exec = await http('POST', `/api/admin/projects/${pid}/functions/use_lib_fn/execute`, {}, adminToken);
  assert.equal(exec.status, 200, `execute harus 200, dapat ${exec.status}: ${JSON.stringify(exec.data)}`);
  assert.equal(exec.data.result, 'HELLO LIB');
});
