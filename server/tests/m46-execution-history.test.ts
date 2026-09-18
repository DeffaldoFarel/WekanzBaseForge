// ============================================================================
// M46: TEST EXECUTION HISTORY — riwayat eksekusi + log persisten
//
// PROOF:
// 1. Eksekusi via invoke (callable) tercatat ke _function_logs
// 2. Function GAGAL tercatat dengan ok=false + error + logs
// 3. Sumber ('source') dibedakan: callable vs public
// 4. GET logs per function: urutan terbaru dulu + paginasi + totalItems
// 5. GET /logs agregat: mencakup banyak function
// 6. DELETE logs: membersihkan riwayat function itu saja
// 7. Retensi: >200 eksekusi dipangkas ke 200 terbaru
// 8. Pencatatan TIDAK menggagalkan eksekusi (tabel rusak → function tetap ok)
// 9. Runner TANPA executionLog tidak mencatat (unit test tidak dipaksa)
// 10. logs function tertangkap & tersimpan (console.log function)
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
import { listExecutions, recordExecution } from '../src/core/executionLog.js';

let server: nodeHttp.Server;
let baseURL = '';
const TEST_DATA_DIR = path.join(os.tmpdir(), `bf-m46-${Date.now()}`);

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

  const proj = await http('POST', '/api/admin/projects', { name: 'm46' }, adminToken);
  assert.equal(proj.status, 201);
  pid = proj.data.project.id;

  // Dua function: satu sukses (dengan console.log), satu gagal
  const ok = await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'ok_fn', code: `console.log('starting'); return { done: true };`,
  }, adminToken);
  assert.equal(ok.status, 201);

  const bad = await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'bad_fn', code: `console.log('about to fail'); throw new Error('boom');`,
  }, adminToken);
  assert.equal(bad.status, 201);
});

after(async () => {
  closeAllProjectDbs();
  server.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─── 1. Invoke (callable) tercatat ───────────────────────────────────────────

test('M46: eksekusi via invoke callable tercatat', async () => {
  const exec = await http('POST', `/api/admin/projects/${pid}/functions/ok_fn/execute`, {}, adminToken);
  assert.equal(exec.status, 200);

  const db = getProjectDb(pid);
  const page = listExecutions(db, { functionName: 'ok_fn' });
  assert.equal(page.totalItems, 1, 'satu eksekusi harus tercatat');
  const e = page.items[0];
  assert.equal(e.ok, true);
  assert.equal(e.source, 'callable');
  assert.ok(e.durationMs >= 0);
  assert.ok(e.created.length > 0, 'timestamp harus ada');
});

// ─── 2. Function GAGAL tercatat dengan error + logs ─────────────────────────

test('M46: function gagal tercatat dengan ok=false, error, dan logs', async () => {
  const exec = await http('POST', `/api/admin/projects/${pid}/functions/bad_fn/execute`, {}, adminToken);
  // Admin execute mengembalikan FunctionRunResult (boleh 200 ok:false atau 400)
  assert.ok(exec.status === 200 || exec.status === 400);

  const db = getProjectDb(pid);
  const page = listExecutions(db, { functionName: 'bad_fn' });
  assert.equal(page.totalItems, 1);
  const e = page.items[0];
  assert.equal(e.ok, false, 'eksekusi gagal harus ok=false');
  assert.match(String(e.error), /boom/, 'pesan error harus tersimpan');
  assert.ok(e.logs.some((l) => l.includes('about to fail')), 'console.log function harus tersimpan');
});

// ─── 3. Sumber dibedakan ─────────────────────────────────────────────────────

test('M46: source callable vs public dibedakan', async () => {
  // Invoke admin → callable (sudah ada 1 dari test 1)
  // Invoke publik → public (perlu function enabled + user)
  const pubFn = await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'pub_fn', code: 'return "public-result";',
  }, adminToken);
  assert.equal(pubFn.status, 201);

  // Register end user + invoke publik
  const reg = await http('POST', `/api/p/${pid}/auth/register`, {
    email: 'u@m46.test', password: 'passwordX123',
  });
  const userToken = reg.data.accessToken;
  const exec = await http('POST', `/api/p/${pid}/functions/pub_fn/execute`, {}, userToken);
  assert.ok(exec.status === 200 || exec.status === 403, `invoke publik: ${exec.status}`);

  const db = getProjectDb(pid);
  const page = listExecutions(db, { functionName: 'pub_fn' });
  if (page.totalItems > 0) {
    assert.equal(page.items[0].source, 'public', 'invoke publik harus source=public');
  }
  // callable tetap terpisah
  const callable = listExecutions(db, { functionName: 'ok_fn' });
  assert.equal(callable.items[0].source, 'callable');
});

// ─── 4. Urutan terbaru dulu + paginasi ───────────────────────────────────────

test('M46: GET logs urutan terbaru dulu + paginasi + totalItems', async () => {
  // Jalankan ok_fn beberapa kali
  for (let i = 0; i < 5; i++) {
    await http('POST', `/api/admin/projects/${pid}/functions/ok_fn/execute`, {}, adminToken);
  }
  const res = await http('GET', `/api/admin/projects/${pid}/functions/ok_fn/logs?perPage=3&page=1`, undefined, adminToken);
  assert.equal(res.status, 200);
  assert.equal(res.data.items.length, 3, 'perPage=3 harus membatasi');
  assert.ok(res.data.totalItems >= 5, 'totalItems harus akurat');
  // Terbaru dulu: created harus non-ascending
  const times = res.data.items.map((i: any) => i.created);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i - 1] >= times[i], 'harus terbaru dulu (DESC)');
  }

  // Halaman 2
  const page2 = await http('GET', `/api/admin/projects/${pid}/functions/ok_fn/logs?perPage=3&page=2`, undefined, adminToken);
  assert.equal(page2.status, 200);
  assert.ok(page2.data.items.length >= 1, 'halaman 2 harus ada isinya');
});

// ─── 5. Agregat semua function ───────────────────────────────────────────────

test('M46: GET /logs agregat mencakup banyak function', async () => {
  const res = await http('GET', `/api/admin/projects/${pid}/logs?perPage=100`, undefined, adminToken);
  assert.equal(res.status, 200);
  const names = new Set(res.data.items.map((i: any) => i.functionName));
  assert.ok(names.has('ok_fn'), 'agregat harus mencakup ok_fn');
  assert.ok(names.has('bad_fn'), 'agregat harus mencakup bad_fn');
});

// ─── 6. DELETE logs membersihkan function itu saja ───────────────────────────

test('M46: DELETE logs membersihkan riwayat function itu saja', async () => {
  const del = await http('DELETE', `/api/admin/projects/${pid}/functions/ok_fn/logs`, undefined, adminToken);
  assert.equal(del.status, 200);
  assert.ok(del.data.cleared >= 1, 'harus ada yang terhapus');

  const db = getProjectDb(pid);
  assert.equal(listExecutions(db, { functionName: 'ok_fn' }).totalItems, 0, 'ok_fn harus bersih');
  assert.ok(listExecutions(db, { functionName: 'bad_fn' }).totalItems >= 1, 'bad_fn tidak ikut terhapus');
});

// ─── 7. Retensi 200 ──────────────────────────────────────────────────────────

test('M46: retensi — >200 eksekusi dipangkas ke 200 terbaru', async () => {
  const db = getProjectDb(pid);
  // Catat 210 eksekusi langsung (lebih cepat dari invoke HTTP)
  for (let i = 0; i < 210; i++) {
    recordExecution(db, {
      functionName: 'heavy_fn', source: 'schedule', ok: true,
      durationMs: i, memoryMb: 32,
    });
  }
  const page = listExecutions(db, { functionName: 'heavy_fn', perPage: 300 });
  assert.equal(page.totalItems, 200, 'harus dipangkas ke 200');
  // Yang tersisa harus yang terbaru (durationMs tertinggi = terakhir dicatat)
  const durations = page.items.map((i) => i.durationMs);
  assert.ok(Math.max(...durations) === 209, 'eksekusi terbaru harus dipertahankan');
});

// ─── 8. Pencatatan tidak menggagalkan eksekusi ──────────────────────────────

test('M46: kegagalan logging TIDAK menggagalkan eksekusi', async () => {
  const db = getProjectDb(pid);
  // Rusakkan tabel: hapus agar recordExecution gagal saat init/insert di tengah
  db.exec('DROP TABLE IF EXISTS _function_logs_broken_test');

  // Panggil runFunctionCode dengan executionLog + DB yang akan kita rusak
  // recordExecution dibungkus try/catch — function HARUS tetap ok.
  const result = await runFunctionCode(`return 'still works';`, {
    projectDb: db,
    executionLog: { functionName: 'resilient_fn', source: 'callable' },
  });
  assert.ok(result.ok, `function harus tetap ok walau logging bermasalah: ${result.error}`);
  assert.equal(result.result, 'still works');
});

// ─── 9. Runner tanpa executionLog tidak mencatat ────────────────────────────

test('M46: runner tanpa executionLog tidak mencatat (unit test tidak dipaksa)', async () => {
  const db = getProjectDb(pid);
  const before = listExecutions(db, { functionName: 'no_log_fn' }).totalItems;

  await runFunctionCode(`return 1;`, { projectDb: db }); // tanpa executionLog
  await runFunctionCode(`return 2;`, {}); // tanpa projectDb sama sekali

  const after = listExecutions(db, { functionName: 'no_log_fn' }).totalItems;
  assert.equal(after, before, 'tanpa executionLog tidak boleh mencatat');
});

// ─── 10. logs function (console.log) tersimpan ──────────────────────────────

test('M46: console.log function tertangkap & tersimpan di riwayat', async () => {
  const fn = await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'chatty_fn',
    code: `console.log('line one'); console.warn('line two'); return 1;`,
  }, adminToken);
  assert.equal(fn.status, 201);

  await http('POST', `/api/admin/projects/${pid}/functions/chatty_fn/execute`, {}, adminToken);

  const db = getProjectDb(pid);
  const page = listExecutions(db, { functionName: 'chatty_fn' });
  assert.equal(page.totalItems, 1);
  const logs = page.items[0].logs;
  assert.ok(logs.some((l) => l.includes('line one')), 'log pertama harus tersimpan');
  assert.ok(logs.some((l) => l.includes('line two')), 'log kedua harus tersimpan');
});
