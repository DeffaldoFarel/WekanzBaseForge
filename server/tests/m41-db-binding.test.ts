// ============================================================================
// M41: TEST $db BINDING — akses database in-process dari function
//
// PROOF:
// 1. $db OFF secara default (opt-in) — function lama tidak berubah perilaku
// 2. $db ON: list/get/create/update/delete bekerja tanpa jaringan
// 3. Collection sistem ('_auth_users') DITOLAK — tidak bisa eskalasi privilese
// 4. Budget panggilan dipaksa (maxDbCalls)
// 5. ANTI-REKURSI: tulis $db pada depth>=1 tidak memicu trigger
// 6. $db bypass API rules (identitas admin) — disengaja & didokumentasikan
// 7. Rute admin menerima & mempertahankan flag dbAccess
// 8. Agregasi nyata atas >100 record dalam SATU eksekusi (bukti kasus
//    investments-aggregates WekanzDashboard bisa jalan tanpa HTTP)
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
// Pitfall repo: TEST_DIR di ../data/ membuat data/ tumbuh selamanya.
// M41 memakai os.tmpdir() — dibersihkan OS walau after() gagal.
const TEST_DATA_DIR = path.join(os.tmpdir(), `bf-m41-${Date.now()}`);

let pid: string;
let adminToken: string;

const AUTH_HEADER = 'Authorization';
const bearer = (token: string): string => ['Bearer', token].join(' ');

async function http(
  method: string,
  reqPath: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, baseURL);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers[AUTH_HEADER] = bearer(token);
    const req = nodeHttp.request(url, { method, headers }, (res) => {
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
  adminToken = login.data.token;
  assert.equal(login.status, 200, 'admin login harus 200');

  const proj = await http('POST', '/api/admin/projects', { name: 'm41' }, adminToken);
  assert.equal(proj.status, 201, 'create project harus 201');
  pid = proj.data.project.id;

  // Collection data untuk diuji
  const col = await http('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'items',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'qty', type: 'number' },
      { name: 'owner', type: 'text' },
    ],
  }, adminToken);
  assert.equal(col.status, 201, 'create collection items harus 201');

  const log = await http('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'audit',
    fields: [{ name: 'note', type: 'text' }],
  }, adminToken);
  assert.equal(log.status, 201, 'create collection audit harus 201');
});

after(async () => {
  closeAllProjectDbs();
  server.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─── 1. Opt-in ───────────────────────────────────────────────────────────────

test('M41: $db OFF secara default — function lama tidak berubah perilaku', async () => {
  const db = getProjectDb(pid);
  const result = await runFunctionCode(
    `try { await $db.collection('items').list(); return 'NO_GUARD'; }
     catch (e) { return e.message; }`,
    { projectDb: db } // dbAccess tidak diset → harus off
  );
  assert.ok(result.ok, `run gagal: ${result.error}`);
  assert.match(String(result.result), /not enabled/i, 'harus menolak dengan pesan jelas');
});

// ─── 2. CRUD lengkap ─────────────────────────────────────────────────────────

test('M41: $db ON — create/get/update/list/delete tanpa jaringan', async () => {
  const db = getProjectDb(pid);
  const result = await runFunctionCode(
    `const made = await $db.collection('items').create({ title: 'apple', qty: 3, owner: 'u1' });
     const got  = await $db.collection('items').get(made.id);
     const upd  = await $db.collection('items').update(made.id, { qty: 10 });
     const list = await $db.collection('items').list({ filter: 'owner = "u1"', perPage: 50 });
     const del  = await $db.collection('items').delete(made.id);
     const after = await $db.collection('items').get(made.id);
     return {
       created: made.title, gotSame: got.id === made.id, qty: upd.qty,
       found: list.items.length, total: list.totalItems, deleted: del, afterNull: after === null,
     };`,
    { projectDb: db, dbAccess: true, timeoutMs: 8000 }
  );
  assert.ok(result.ok, `run gagal: ${result.error} | logs=${result.logs.join('|')}`);
  const r = result.result as Record<string, unknown>;
  assert.equal(r.created, 'apple');
  assert.equal(r.gotSame, true, 'get harus mengembalikan record yang sama');
  assert.equal(r.qty, 10, 'update harus tersimpan');
  assert.equal(r.found, 1, 'list harus menemukan 1 record');
  assert.equal(r.total, 1, 'totalItems harus 1');
  assert.equal(r.deleted, true, 'delete harus true');
  assert.equal(r.afterNull, true, 'record harus hilang setelah delete');
});

// ─── 3. Collection sistem ditolak ────────────────────────────────────────────

test('M41: collection sistem ditolak — tidak bisa eskalasi privilese', async () => {
  const db = getProjectDb(pid);
  const result = await runFunctionCode(
    `const out = [];
     for (const col of ['_auth_users', '_functions', '_collections']) {
       try { await $db.collection(col).list(); out.push(col + ':LEAK'); }
       catch (e) { out.push(col + ':blocked'); }
     }
     return out;`,
    { projectDb: db, dbAccess: true, timeoutMs: 8000 }
  );
  assert.ok(result.ok, `run gagal: ${result.error}`);
  const out = result.result as string[];
  assert.deepEqual(
    out,
    ['_auth_users:blocked', '_functions:blocked', '_collections:blocked'],
    'semua tabel sistem harus ditolak'
  );
});

// ─── 4. Budget panggilan ─────────────────────────────────────────────────────

test('M41: budget maxDbCalls dipaksa', async () => {
  const db = getProjectDb(pid);
  const result = await runFunctionCode(
    `let ok = 0;
     try {
       for (let i = 0; i < 20; i++) { await $db.collection('items').list({ perPage: 1 }); ok++; }
       return { ok: ok, blocked: false };
     } catch (e) { return { ok: ok, blocked: /budget/i.test(e.message) }; }`,
    { projectDb: db, dbAccess: true, maxDbCalls: 5, timeoutMs: 8000 }
  );
  assert.ok(result.ok, `run gagal: ${result.error}`);
  const r = result.result as { ok: number; blocked: boolean };
  assert.equal(r.ok, 5, 'tepat 5 panggilan boleh lolos');
  assert.equal(r.blocked, true, 'panggilan ke-6 harus diblokir oleh budget');
});

// ─── 5. Anti-rekursi ─────────────────────────────────────────────────────────

test('M41: depth>=1 — tulisan $db TIDAK memicu trigger (anti-rekursi)', async () => {
  const db = getProjectDb(pid);
  let triggerCalls = 0;

  // depth 1 = seperti dipanggil dari trigger. onWrite tidak boleh terpanggil.
  const deep = await runFunctionCode(
    `const r = await $db.collection('items').create({ title: 'from-trigger', qty: 1 });
     return r.title;`,
    {
      projectDb: db, dbAccess: true, depth: 1, timeoutMs: 8000,
      onDbWrite: () => { triggerCalls++; },
    }
  );
  assert.ok(deep.ok, `run gagal: ${deep.error}`);
  assert.equal(deep.result, 'from-trigger', 'tulisan harus tetap berhasil');
  assert.equal(triggerCalls, 0, 'pada depth 1 trigger TIDAK boleh dipicu');

  // depth 0 = pemanggil terluar. onWrite harus terpanggil.
  const shallow = await runFunctionCode(
    `const r = await $db.collection('items').create({ title: 'from-http', qty: 1 });
     return r.title;`,
    {
      projectDb: db, dbAccess: true, depth: 0, timeoutMs: 8000,
      onDbWrite: () => { triggerCalls++; },
    }
  );
  assert.ok(shallow.ok, `run gagal: ${shallow.error}`);
  assert.equal(triggerCalls, 1, 'pada depth 0 trigger HARUS dipicu tepat sekali');
});

// ─── 6. Bypass rules (disengaja) ─────────────────────────────────────────────

test('M41: $db bypass API rules — identitas admin (disengaja)', async () => {
  const db = getProjectDb(pid);
  // Kunci collection: listRule admin-only (null = admin saja)
  const locked = await http('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'secrets',
    fields: [{ name: 'value', type: 'text' }],
    rules: { listRule: null, viewRule: null, createRule: null },
  }, adminToken);
  assert.equal(locked.status, 201, 'create collection secrets harus 201');

  // Anonim lewat API publik TIDAK boleh melihat datanya.
  // Catatan perilaku (diverifikasi probe, records.ts:827-830): untuk end user
  // + listRule null, BaseForge menjawab 200 dengan 0 record — bukan 403.
  // Artinya "tidak bisa dibaca" dibuktikan oleh totalItems, bukan status code;
  // status saja akan menyembunyikan kebocoran. Tulis DI-TOLAK 403 (probe).
  const anon = await http('GET', `/api/p/${pid}/collections/secrets/records`);
  assert.equal(anon.data.totalItems, 0, 'anon tidak boleh melihat satu record pun');
  assert.equal(anon.data.items.length, 0, 'anon items harus kosong');

  const anonWrite = await http('POST', `/api/p/${pid}/collections/secrets/records`, {
    value: 'anon-wrote-this',
  });
  assert.equal(anonWrite.status, 403, 'anon tidak boleh menulis ke collection admin-only');

  // $db (admin) harus BISA — inilah gunanya function menulis field backend-managed
  const result = await runFunctionCode(
    `const made = await $db.collection('secrets').create({ value: 'backend-managed' });
     const list = await $db.collection('secrets').list();
     return { created: made.value, count: list.totalItems };`,
    { projectDb: db, dbAccess: true, timeoutMs: 8000 }
  );
  assert.ok(result.ok, `run gagal: ${result.error}`);
  const r = result.result as { created: string; count: number };
  assert.equal(r.created, 'backend-managed');
  assert.equal(r.count, 1, '$db harus melewati rules admin-only');
});

// ─── 7. Rute admin mempertahankan dbAccess ───────────────────────────────────

test('M41: POST/PATCH function mempertahankan flag dbAccess', async () => {
  const created = await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'agg_fn',
    code: 'return 1;',
    dbAccess: true,
  }, adminToken);
  assert.equal(created.status, 201, `create function harus 201, dapat ${created.status}`);
  assert.equal(created.data.function.dbAccess, true, 'dbAccess harus tersimpan true');

  const off = await http('PATCH', `/api/admin/projects/${pid}/functions/agg_fn`, {
    dbAccess: false,
  }, adminToken);
  assert.equal(off.status, 200);
  assert.equal(off.data.function.dbAccess, false, 'dbAccess harus bisa dimatikan');

  // undefined = tidak disentuh
  const untouched = await http('PATCH', `/api/admin/projects/${pid}/functions/agg_fn`, {
    timeoutMs: 3000,
  }, adminToken);
  assert.equal(untouched.status, 200);
  assert.equal(untouched.data.function.dbAccess, false, 'dbAccess tidak boleh berubah tanpa diminta');

  // Default: tanpa dbAccess → false
  const plain = await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'plain_fn', code: 'return 1;',
  }, adminToken);
  assert.equal(plain.status, 201);
  assert.equal(plain.data.function.dbAccess, false, 'default harus off (aman)');
});

// ─── 8. Agregasi nyata >100 record dalam satu eksekusi ───────────────────────

test('M41: agregasi 150 record dalam SATU eksekusi (kasus dashboard)', async () => {
  const db = getProjectDb(pid);

  // Seed 150 record lewat $db sendiri (sekaligus membuktikan tulis massal)
  const seed = await runFunctionCode(
    `let n = 0;
     for (let i = 0; i < 150; i++) {
       await $db.collection('items').create({ title: 'seed-' + i, qty: i, owner: 'agg' });
       n++;
     }
     return n;`,
    { projectDb: db, dbAccess: true, maxDbCalls: 400, timeoutMs: 25_000 }
  );
  assert.ok(seed.ok, `seed gagal: ${seed.error}`);
  assert.equal(seed.result, 150, 'harus menulis 150 record');

  // Agregasi: baca semua (perPage 500 > cap Appwrite 100) lalu jumlahkan
  const agg = await runFunctionCode(
    `const res = await $db.collection('items').list({ filter: 'owner = "agg"', perPage: 500 });
     let sum = 0;
     for (const it of res.items) sum += it.qty;
     return { fetched: res.items.length, total: res.totalItems, sum: sum };`,
    { projectDb: db, dbAccess: true, timeoutMs: 15_000 }
  );
  assert.ok(agg.ok, `agregasi gagal: ${agg.error}`);
  const r = agg.result as { fetched: number; total: number; sum: number };
  assert.equal(r.fetched, 150, 'satu panggilan harus mengambil 150 record (cap 500)');
  assert.equal(r.total, 150, 'totalItems harus 150');
  // 0+1+...+149 = 11175
  assert.equal(r.sum, 11175, 'agregasi harus benar');
});
