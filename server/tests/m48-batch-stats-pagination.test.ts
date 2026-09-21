// ============================================================================
// M48: TEST — batch stats + paginasi daftar project
//
// Masalah yang diperbaiki: halaman /projects memanggil satu endpoint
// /stats PER KARTU (400 project = 400 request HTTP) dan mengambil SELURUH
// registry project di setiap kunjungan.
//
// Fokus test:
//  1. GET /api/admin/stats/projects?ids= — ringkasan banyak project 1 request
//  2. Angka batch IDENTIK dengan endpoint single-project (tidak ada dua
//     versi kebenaran)
//  3. Project tanpa data metrics tetap dikembalikan (nol), bukan hilang
//  4. Validasi: ids kosong → 400, > MAX_STATS_BATCH → 400, butuh admin
//  5. Endpoint batch TIDAK menambah metrics dirinya sendiri (observer effect)
//  6. Paginasi: perPage/page, meta benar, tidak ada project dobel/hilang
//  7. Search & sort dikerjakan server (termasuk case-insensitive)
//  8. LIKE wildcard di input user di-escape (cari "%" tidak mengembalikan semua)
//  9. Backward compat: tanpa perPage, respons tetap seluruh project tanpa meta
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import nodeHttp from 'node:http';

// ─── PENTING: DATA_DIR harus diset SEBELUM modul src di-import ──────────────
//
// `platformDb.ts` menghitung `const DATA_DIR = path.resolve(process.env.DATA_DIR
// ?? '../data')` pada level MODUL — nilainya dibekukan saat import, bukan saat
// dipanggil. Static import di ESM dievaluasi sebelum badan modul ini jalan,
// jadi menyetel env di dalam before() SUDAH TERLAMBAT: modul sudah memegang
// path `../data` (data produksi).
//
// Test ini memakai dynamic import setelah env diset. Test lain di repo ini
// masih memakai pola lama dan karena itu menulis ke data/ produksi — lihat
// catatan di akhir file.
const TEST_DATA_DIR = path.resolve('../data/m48-batch-test');
fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.ADMIN_EMAIL = 'admin@m48.test';
process.env.ADMIN_PASSWORD = 'm48-secret-pass';
process.env.JWT_SECRET = 'm48-test-jwt-secret-key-long-enough';

const { initPlatformDb, resetPlatformDbForTests } = await import('../src/core/platformDb.js');
const { closeAllProjectDbs } = await import('../src/core/projectDbManager.js');
const { Router } = await import('../src/core/router.js');
const { createAdminRouter } = await import('../src/api/adminRoutes.js');
const { createDatabaseRouter } = await import('../src/api/databaseRoutes.js');
const { createPublicRouter } = await import('../src/api/publicRoutes.js');
const { createStatsRouter } = await import('../src/api/statsRoutes.js');
const { flushMetrics, metricsProjectId, MAX_STATS_BATCH } = await import(
  '../src/core/metrics.js'
);

let server: nodeHttp.Server;
let baseURL: string;
let adminToken: string;

/** id project yang dibuat di before(), urut sesuai urutan pembuatan */
const created: { id: string; name: string }[] = [];

function http(
  method: string,
  p: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; data: any; raw: string }> {
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
          const raw = Buffer.concat(chunks).toString('utf-8');
          let data: any = {};
          try {
            data = JSON.parse(raw || '{}');
          } catch {}
          resolve({ status: res.statusCode ?? 0, data, raw });
        });
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

before(async () => {
  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());
  router.merge(createPublicRouter());
  router.merge(createStatsRouter());

  server = nodeHttp.createServer((rq, rs) => router.handle(rq, rs));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  baseURL = `http://127.0.0.1:${addr.port}`;

  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@m48.test',
    password: 'm48-secret-pass',
  });
  assert.equal(login.status, 200);
  adminToken = login.data.token;

  // 7 project dengan nama yang sengaja dirancang untuk menguji search & sort:
  //  - campuran huruf besar/kecil → uji COLLATE NOCASE
  //  - satu nama mengandung '%' → uji escape LIKE
  const names = [
    'alpha-service',
    'Beta-Service',
    'gamma-api',
    'delta-api',
    'epsilon',
    'zeta-100%-done',
    'Alpha-Backup',
  ];
  for (const name of names) {
    const res = await http('POST', '/api/admin/projects', { name }, adminToken);
    assert.equal(res.status, 201, res.raw);
    created.push({ id: res.data.project.id, name });
    // created timestamp harus BERBEDA agar urutan deterministik
    await new Promise((r) => setTimeout(r, 5));
  }

  // Traffic nyata di project pertama saja — sisanya harus tetap muncul (nol).
  const col = await http(
    'POST',
    `/api/admin/projects/${created[0].id}/collections`,
    { name: 'items', fields: [{ name: 'title', type: 'text' }], rules: { listRule: '' } },
    adminToken
  );
  assert.equal(col.status, 201, col.raw);
  for (let i = 0; i < 3; i++) {
    await http('GET', `/api/p/${created[0].id}/collections/items/records`);
  }
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  closeAllProjectDbs();
  // Handle platform.db harus dilepas juga — tanpa ini rmSync gagal EPERM di
  // Windows dan direktori test menumpuk diam-diam tiap run.
  resetPlatformDbForTests();
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* best-effort — jangan gagalkan suite yang assertion-nya sudah lulus */
  }
});

// ─── 1 & 2: batch stats konsisten dengan single-project ─────────────────────

test('batch stats: satu request mengembalikan ringkasan semua project', async () => {
  const ids = created.map((p) => p.id);
  const res = await http(
    'GET',
    `/api/admin/stats/projects?ids=${ids.join(',')}`,
    undefined,
    adminToken
  );
  assert.equal(res.status, 200, res.raw);

  // Project tanpa metrics TETAP ada di respons (nol) — klien tidak perlu
  // membedakan "belum ada data" vs "tidak dikirim server".
  assert.equal(Object.keys(res.data.stats).length, ids.length);
  for (const id of ids) {
    const s = res.data.stats[id];
    assert.ok(s, `project ${id} harus ada di respons`);
    assert.equal(typeof s.today.requests, 'number');
    assert.equal(typeof s.totals.requests, 'number');
  }

  // Project dengan traffic punya angka > 0
  assert.ok(
    res.data.stats[created[0].id].totals.requests > 0,
    'project dengan traffic harus punya requests > 0'
  );
  // Project tanpa traffic = nol bersih
  assert.equal(res.data.stats[created[4].id].totals.requests, 0);
});

test('batch stats: angka IDENTIK dengan endpoint single-project (sebelum & sesudah flush)', async () => {
  const id = created[0].id;

  const before1 = await http('GET', `/api/admin/projects/${id}/stats`, undefined, adminToken);
  const batch1 = await http('GET', `/api/admin/stats/projects?ids=${id}`, undefined, adminToken);
  assert.equal(before1.status, 200);
  assert.equal(batch1.status, 200);
  assert.equal(
    batch1.data.stats[id].totals.requests,
    before1.data.totals.requests,
    'buffer in-memory harus ikut dihitung di batch (real-time)'
  );
  assert.equal(batch1.data.stats[id].today.requests, before1.data.today.requests);
  assert.equal(batch1.data.stats[id].today.bytesOut, before1.data.today.bytesOut);

  // Setelah flush, angka tidak boleh berubah maupun terhitung dua kali
  // (DB + buffer di-merge, bukan dijumlah ganda).
  flushMetrics();

  const after1 = await http('GET', `/api/admin/projects/${id}/stats`, undefined, adminToken);
  const batch2 = await http('GET', `/api/admin/stats/projects?ids=${id}`, undefined, adminToken);
  assert.equal(batch2.data.stats[id].totals.requests, after1.data.totals.requests);
  assert.ok(
    after1.data.totals.requests >= before1.data.totals.requests,
    'flush tidak boleh menghilangkan data'
  );
});

test('batch stats: id duplikat tidak menggandakan angka', async () => {
  const id = created[0].id;
  const single = await http('GET', `/api/admin/stats/projects?ids=${id}`, undefined, adminToken);
  const dup = await http(
    'GET',
    `/api/admin/stats/projects?ids=${id},${id},${id}`,
    undefined,
    adminToken
  );
  assert.equal(dup.status, 200);
  assert.equal(Object.keys(dup.data.stats).length, 1);
  assert.equal(dup.data.stats[id].totals.requests, single.data.stats[id].totals.requests);
});

// ─── 4: validasi & auth ──────────────────────────────────────────────────────

test('batch stats: ids kosong → 400', async () => {
  const res = await http('GET', '/api/admin/stats/projects', undefined, adminToken);
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, 'BAD_REQUEST');
});

test('batch stats: id melebihi batas → 400 (bukan diam-diam dipotong)', async () => {
  const many = Array.from({ length: MAX_STATS_BATCH + 1 }, (_, i) => `id${i}`).join(',');
  const res = await http('GET', `/api/admin/stats/projects?ids=${many}`, undefined, adminToken);
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, 'TOO_MANY_IDS');
});

test('batch stats: butuh admin token', async () => {
  const res = await http('GET', `/api/admin/stats/projects?ids=${created[0].id}`);
  assert.equal(res.status, 401);
});

test('batch stats: id tak dikenal dikembalikan sebagai nol, bukan 404', async () => {
  const res = await http(
    'GET',
    `/api/admin/stats/projects?ids=tidak-ada-sama-sekali`,
    undefined,
    adminToken
  );
  assert.equal(res.status, 200);
  assert.equal(res.data.stats['tidak-ada-sama-sekali'].totals.requests, 0);
});

// ─── 5: observer effect ──────────────────────────────────────────────────────

test('batch stats: endpoint sendiri TIDAK diatribusikan ke metrics', () => {
  // Kalau ikut dihitung, tiap pembukaan dashboard menambah traffic ke
  // project yang sedang dilihat — feedback loop + test non-deterministik.
  assert.equal(metricsProjectId('/api/admin/stats/projects'), null);
});

// ─── 6: paginasi ─────────────────────────────────────────────────────────────

test('paginasi: perPage membatasi hasil & meta melaporkan total sebenarnya', async () => {
  const res = await http('GET', '/api/admin/projects?perPage=3&page=1', undefined, adminToken);
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.data.projects.length, 3);
  assert.equal(res.data.meta.page, 1);
  assert.equal(res.data.meta.perPage, 3);
  assert.equal(res.data.meta.total, created.length, 'total = SEMUA yang cocok, bukan isi halaman');
  assert.equal(res.data.meta.totalPages, Math.ceil(created.length / 3));
});

test('paginasi: menelusuri semua halaman = setiap project muncul TEPAT sekali', async () => {
  const seen: string[] = [];
  const perPage = 2;
  const totalPages = Math.ceil(created.length / perPage);
  for (let page = 1; page <= totalPages; page++) {
    const res = await http(
      'GET',
      `/api/admin/projects?perPage=${perPage}&page=${page}`,
      undefined,
      adminToken
    );
    assert.equal(res.status, 200);
    for (const p of res.data.projects) seen.push(p.id);
  }
  assert.equal(seen.length, created.length, 'tidak ada project yang hilang');
  assert.equal(new Set(seen).size, created.length, 'tidak ada project yang dobel antar halaman');
});

test('paginasi: page di luar jangkauan → array kosong, bukan error', async () => {
  const res = await http('GET', '/api/admin/projects?perPage=5&page=999', undefined, adminToken);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.projects, []);
  assert.equal(res.data.meta.total, created.length);
});

test('paginasi: perPage/page tidak valid dijepit ke rentang aman', async () => {
  const zero = await http('GET', '/api/admin/projects?perPage=0&page=0', undefined, adminToken);
  assert.equal(zero.status, 200);
  assert.ok(zero.data.meta.perPage >= 1);
  assert.equal(zero.data.meta.page, 1);

  const huge = await http('GET', '/api/admin/projects?perPage=99999', undefined, adminToken);
  assert.ok(huge.data.meta.perPage <= 100, 'perPage harus dibatasi agar tidak jadi jalan DoS');

  const junk = await http('GET', '/api/admin/projects?perPage=abc', undefined, adminToken);
  assert.equal(junk.status, 200, 'input sampah tidak boleh 500');
});

// ─── 7 & 8: search + sort di server ──────────────────────────────────────────

test('search: cocokkan nama, case-insensitive', async () => {
  const res = await http(
    'GET',
    '/api/admin/projects?perPage=50&search=service',
    undefined,
    adminToken
  );
  assert.equal(res.status, 200);
  const names = res.data.projects.map((p: any) => p.name).sort();
  // 'alpha-service' + 'Beta-Service' — huruf besar tidak boleh terlewat
  assert.deepEqual(names, ['Beta-Service', 'alpha-service'].sort());
  assert.equal(res.data.meta.total, 2);
});

test('search: cocokkan id juga', async () => {
  const target = created[2];
  const res = await http(
    'GET',
    `/api/admin/projects?perPage=50&search=${target.id}`,
    undefined,
    adminToken
  );
  assert.equal(res.data.projects.length, 1);
  assert.equal(res.data.projects[0].id, target.id);
});

test('search: wildcard LIKE di input user di-escape', async () => {
  // Tanpa ESCAPE, '%' adalah wildcard SQL → mencocokkan SEMUA project.
  const res = await http('GET', '/api/admin/projects?perPage=50&search=%25', undefined, adminToken);
  assert.equal(res.status, 200);
  assert.equal(res.data.meta.total, 1, "'%' harus dicari sebagai karakter literal");
  assert.equal(res.data.projects[0].name, 'zeta-100%-done');

  // '_' juga wildcard (cocok satu karakter apa pun)
  const underscore = await http(
    'GET',
    '/api/admin/projects?perPage=50&search=_',
    undefined,
    adminToken
  );
  assert.equal(underscore.data.meta.total, 0, "'_' literal tidak ada di nama mana pun");
});

test('search: tidak ada yang cocok → kosong dengan total 0', async () => {
  const res = await http(
    'GET',
    '/api/admin/projects?perPage=50&search=zzz-tidak-ada',
    undefined,
    adminToken
  );
  assert.deepEqual(res.data.projects, []);
  assert.equal(res.data.meta.total, 0);
  assert.equal(res.data.meta.totalPages, 1, 'totalPages minimal 1 agar UI tidak membagi nol');
});

test('sort: newest / oldest berlawanan, name urut alfabet case-insensitive', async () => {
  const newest = await http(
    'GET',
    '/api/admin/projects?perPage=50&sort=newest',
    undefined,
    adminToken
  );
  const oldest = await http(
    'GET',
    '/api/admin/projects?perPage=50&sort=oldest',
    undefined,
    adminToken
  );
  const newestIds = newest.data.projects.map((p: any) => p.id);
  const oldestIds = oldest.data.projects.map((p: any) => p.id);
  assert.deepEqual(newestIds, [...oldestIds].reverse());
  // Project pertama yang dibuat harus paling awal di 'oldest'
  assert.equal(oldestIds[0], created[0].id);

  const byName = await http(
    'GET',
    '/api/admin/projects?perPage=50&sort=name',
    undefined,
    adminToken
  );
  const names = byName.data.projects.map((p: any) => p.name);
  // COLLATE NOCASE: 'Alpha-Backup' harus mendahului 'alpha-service',
  // dan 'Beta-Service' TIDAK boleh melompat ke depan hanya karena kapital.
  assert.deepEqual(
    names,
    [...names].sort((a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase()))
  );
  assert.equal(names[0].toLowerCase(), 'alpha-backup');
});

test('sort: nilai tak dikenal jatuh ke default, bukan error', async () => {
  const res = await http(
    'GET',
    '/api/admin/projects?perPage=50&sort=; DROP TABLE projects',
    undefined,
    adminToken
  );
  assert.equal(res.status, 200);
  assert.equal(res.data.projects.length, created.length, 'tabel harus utuh — sort di-whitelist');
});

// ─── 9: backward compatibility ───────────────────────────────────────────────

test('kompatibilitas: tanpa perPage, respons tetap seluruh project tanpa meta', async () => {
  // CLI & test lama memanggil endpoint ini tanpa parameter apa pun. Diam-diam
  // memotong hasil mereka jadi 24 adalah bug yang sangat sulit dilacak.
  const res = await http('GET', '/api/admin/projects', undefined, adminToken);
  assert.equal(res.status, 200);
  assert.equal(res.data.projects.length, created.length);
  assert.equal(res.data.meta, undefined, 'bentuk respons lama tidak berubah');
});
