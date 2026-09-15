// ============================================================================
// M19: TEST AGGREGATE API — membuka pintu REST untuk modul core D7
//
// Fokus test ini BUKAN logika agregasi (itu sudah dites di d7-aggregates).
// Fokusnya: apakah agregasi BISA DIPANGGIL DARI LUAR lewat HTTP, dan apakah
// listRule membatasi baris yang ikut dihitung.
//
// Latar: audit menemukan aggregates.ts diimpor oleh 0 file produksi — test
// hijau tidak membuktikan fitur bisa dipakai klien.
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import nodeHttp from 'node:http';
import { initPlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { Router } from '../src/core/router.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';
import { createPublicRouter } from '../src/api/publicRoutes.js';
import { createProjectAuthRouter } from '../src/api/authRoutes.js';

const TEST_DATA_DIR = path.resolve('../data/m19-agg-test');

let server: nodeHttp.Server;
let baseURL: string;
let adminToken: string;
let projectId: string;
let userAToken: string;
let userBToken: string;

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
        let raw = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let data: any = null;
          try {
            data = JSON.parse(raw);
          } catch {
            data = raw;
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      }
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

before(async () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  process.env.DATA_DIR = TEST_DATA_DIR;
  process.env.STORAGE_DIR = path.join(TEST_DATA_DIR, 'storage');
  process.env.ADMIN_EMAIL = 'admin@m19.test';
  process.env.ADMIN_PASSWORD = 'm19-secret-pass';
  process.env.JWT_SECRET = 'm19-test-jwt-secret-key-long-enough';
  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());
  router.merge(createProjectAuthRouter());
  router.merge(createPublicRouter());

  server = nodeHttp.createServer((req, res) => router.handle(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseURL = `http://127.0.0.1:${port}`;

  // ── login admin ──
  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@m19.test',
    password: 'm19-secret-pass',
  });
  assert.equal(login.status, 200);
  adminToken = login.data.token;

  // ── project ──
  const proj = await http('POST', '/api/admin/projects', { name: 'm19-agg' }, adminToken);
  assert.equal(proj.status, 201);
  projectId = proj.data.project?.id ?? proj.data.id;
  assert.ok(projectId, 'projectId harus ada');

  const P = `/api/admin/projects/${projectId}`;

  // ── auth collection untuk 2 user (bukti isolasi) ──
  const usersCol = await http(
    'POST',
    `${P}/collections`,
    { name: 'users', type: 'auth', fields: [] },
    adminToken
  );
  assert.equal(usersCol.status, 201);

  // ── collection orders: listRule membatasi per pemilik ──
  const ordersCol = await http(
    'POST',
    `${P}/collections`,
    {
      name: 'orders',
      fields: [
        { name: 'owner', type: 'text' },
        { name: 'amount', type: 'number' },
        { name: 'status', type: 'text' },
      ],
      rules: { listRule: 'owner = @request.auth.id', viewRule: 'owner = @request.auth.id' },
    },
    adminToken
  );
  assert.equal(ordersCol.status, 201);

  // ── daftarkan 2 user lewat auth collection ──
  const regA = await http('POST', `/api/p/${projectId}/auth/register`, {
    email: 'a@m19.test',
    password: 'passwordA-123',
  });
  assert.equal(regA.status, 201, `register A gagal: ${JSON.stringify(regA.data)}`);
  // sendAuthSuccess mengirim { user, accessToken, refreshToken } — BUKAN { token }.
  userAToken = regA.data.accessToken;
  const userAId = regA.data.user?.id;

  const regB = await http('POST', `/api/p/${projectId}/auth/register`, {
    email: 'b@m19.test',
    password: 'passwordB-123',
  });
  assert.equal(regB.status, 201);
  userBToken = regB.data.accessToken;
  const userBId = regB.data.user?.id;

  assert.ok(userAToken && userBToken, 'kedua token harus ada');
  assert.ok(userAId && userBId, 'kedua user id harus ada');

  // ── seed orders: A punya 3 (total 600), B punya 2 (total 1500) ──
  const seed: Array<[string, number, string]> = [
    [userAId, 100, 'paid'],
    [userAId, 200, 'paid'],
    [userAId, 300, 'pending'],
    [userBId, 700, 'paid'],
    [userBId, 800, 'pending'],
  ];
  for (const [owner, amount, status] of seed) {
    const r = await http(
      'POST',
      `${P}/collections/orders/records`,
      { owner, amount, status },
      adminToken
    );
    assert.equal(r.status, 201, `seed order gagal: ${JSON.stringify(r.data)}`);
  }
});

after(() => {
  closeAllProjectDbs();
  server?.close();
  setTimeout(() => {
    try {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    } catch {
      /* best-effort: Windows kadang masih memegang file lock */
    }
  }, 100);
});

// ════════════════════════════════════════════════════════════════════════════
// ADMIN: agregasi dasar lewat HTTP
// ════════════════════════════════════════════════════════════════════════════

test('M19: rute agregasi admin ADA (sebelum M19 → 404)', async () => {
  const res = await http(
    'GET',
    `/api/admin/projects/${projectId}/collections/orders/aggregate?function=count`,
    undefined,
    adminToken
  );
  console.log('\n   🔢 admin COUNT →', res.status, JSON.stringify(res.data));
  assert.equal(res.status, 200, 'rute harus ada, bukan 404');
  assert.equal(res.data.value, 5);
});

test('M19: SUM lewat HTTP == hitung manual', async () => {
  const agg = await http(
    'GET',
    `/api/admin/projects/${projectId}/collections/orders/aggregate?function=sum&field=amount`,
    undefined,
    adminToken
  );
  assert.equal(agg.status, 200);

  // hitung manual dari list untuk membandingkan
  const list = await http(
    'GET',
    `/api/admin/projects/${projectId}/collections/orders/records?perPage=500`,
    undefined,
    adminToken
  );
  assert.equal(list.status, 200);
  const manual = list.data.items.reduce((s: number, r: any) => s + Number(r.amount ?? 0), 0);

  console.log(`   💰 SUM via REST: ${agg.data.value}  |  hitung manual: ${manual}`);
  assert.equal(agg.data.value, manual);
  assert.equal(agg.data.value, 2100);
});

test('M19: avg / min / max lewat HTTP', async () => {
  const base = `/api/admin/projects/${projectId}/collections/orders/aggregate`;
  const avg = await http('GET', `${base}?function=avg&field=amount`, undefined, adminToken);
  const min = await http('GET', `${base}?function=min&field=amount`, undefined, adminToken);
  const max = await http('GET', `${base}?function=max&field=amount`, undefined, adminToken);

  assert.equal(avg.status, 200);
  assert.equal(avg.data.value, 420); // 2100 / 5
  assert.equal(min.data.value, 100);
  assert.equal(max.data.value, 800);
  console.log(`   📊 avg=${avg.data.value} min=${min.data.value} max=${max.data.value}`);
});

test('M19: groupBy mengembalikan bentuk { groups: [...] }', async () => {
  const res = await http(
    'GET',
    `/api/admin/projects/${projectId}/collections/orders/aggregate?function=sum&field=amount&groupBy=status`,
    undefined,
    adminToken
  );
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.data.groups), 'harus ada array groups');
  const byStatus = Object.fromEntries(res.data.groups.map((g: any) => [g.group, g.value]));
  console.log('   🗂️  GROUP BY status →', JSON.stringify(byStatus));
  assert.equal(byStatus.paid, 1000); // 100 + 200 + 700
  assert.equal(byStatus.pending, 1100); // 300 + 800
});

test('M19: filter M04 ikut berlaku pada agregasi', async () => {
  const res = await http(
    'GET',
    `/api/admin/projects/${projectId}/collections/orders/aggregate?function=count&filter=${encodeURIComponent('amount>250')}`,
    undefined,
    adminToken
  );
  assert.equal(res.status, 200);
  console.log('   🔍 COUNT amount>250 →', res.data.value);
  assert.equal(res.data.value, 3); // 300, 700, 800
});

// ════════════════════════════════════════════════════════════════════════════
// VALIDASI: error harus 400, bukan 500
// ════════════════════════════════════════════════════════════════════════════

test('M19: function tidak dikenal → 400 (bukan 500)', async () => {
  const res = await http(
    'GET',
    `/api/admin/projects/${projectId}/collections/orders/aggregate?function=median&field=amount`,
    undefined,
    adminToken
  );
  console.log('   ⛔ function=median →', res.status, res.data?.error?.code);
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, 'BAD_REQUEST');
});

test('M19: function hilang → 400 dengan pesan jelas', async () => {
  const res = await http(
    'GET',
    `/api/admin/projects/${projectId}/collections/orders/aggregate`,
    undefined,
    adminToken
  );
  assert.equal(res.status, 400);
  assert.match(res.data.error.message, /function/i);
});

test('M19: sum tanpa field → 400, bukan 500', async () => {
  const res = await http(
    'GET',
    `/api/admin/projects/${projectId}/collections/orders/aggregate?function=sum`,
    undefined,
    adminToken
  );
  console.log('   ⛔ sum tanpa field →', res.status, res.data?.error?.code);
  assert.equal(res.status, 400, 'permintaan tak masuk akal = kesalahan klien, bukan server');
  assert.equal(res.data.error.code, 'BAD_REQUEST');
  assert.match(res.data.error.message, /field/i);
});

test('M19: agregasi tanpa token admin → 401', async () => {
  const res = await http(
    'GET',
    `/api/admin/projects/${projectId}/collections/orders/aggregate?function=count`
  );
  console.log('   🔒 tanpa token →', res.status);
  assert.equal(res.status, 401);
});

// ════════════════════════════════════════════════════════════════════════════
// KEAMANAN: listRule WAJIB membatasi agregasi end user
// ════════════════════════════════════════════════════════════════════════════

test('M19 KEAMANAN: end user hanya mengagregasi barisnya sendiri', async () => {
  const p = `/api/p/${projectId}/collections/orders/aggregate`;

  const aCount = await http('GET', `${p}?function=count`, undefined, userAToken);
  const bCount = await http('GET', `${p}?function=count`, undefined, userBToken);
  const aSum = await http('GET', `${p}?function=sum&field=amount`, undefined, userAToken);
  const bSum = await http('GET', `${p}?function=sum&field=amount`, undefined, userBToken);

  console.log(
    `\n   👤 user A → count=${aCount.data.value} sum=${aSum.data.value}` +
      `\n   👤 user B → count=${bCount.data.value} sum=${bSum.data.value}` +
      `\n   🔑 admin  → count=5 sum=2100 (bypass)`
  );

  assert.equal(aCount.status, 200);
  assert.equal(aCount.data.value, 3, 'A punya 3 order');
  assert.equal(aSum.data.value, 600, 'A: 100+200+300');

  assert.equal(bCount.data.value, 2, 'B punya 2 order');
  assert.equal(bSum.data.value, 1500, 'B: 700+800');

  // inti isolasi: tak satu pun user melihat total global
  assert.notEqual(aCount.data.value, 5, 'A TIDAK boleh melihat 5 baris');
  assert.notEqual(bSum.data.value, 2100, 'B TIDAK boleh melihat total global');
});

test('M19 KEAMANAN: anonim tidak bisa mengagregasi collection ber-rule', async () => {
  const res = await http(
    'GET',
    `/api/p/${projectId}/collections/orders/aggregate?function=count`
  );
  console.log('   👻 anonim → status', res.status, 'value', res.data?.value);
  // listRule butuh @request.auth.id; anonim tidak punya → 0 baris
  if (res.status === 200) {
    assert.equal(res.data.value, 0, 'anonim harus dapat 0, bukan total global');
  } else {
    assert.ok(res.status === 401 || res.status === 403);
  }
});

test('M19 KEAMANAN: groupBy end user juga terbatas rule', async () => {
  const res = await http(
    'GET',
    `/api/p/${projectId}/collections/orders/aggregate?function=sum&field=amount&groupBy=status`,
    undefined,
    userAToken
  );
  assert.equal(res.status, 200);
  const byStatus = Object.fromEntries(res.data.groups.map((g: any) => [g.group, g.value]));
  console.log('   🗂️  user A GROUP BY status →', JSON.stringify(byStatus));
  assert.equal(byStatus.paid, 300, 'A: 100+200 saja, bukan 1000');
  assert.equal(byStatus.pending, 300, 'A: 300 saja, bukan 1100');
});

// ════════════════════════════════════════════════════════════════════════════
// ANTI-REGRESI: modul tidak boleh jadi yatim lagi
// ════════════════════════════════════════════════════════════════════════════

test('M19 ANTI-REGRESI: aggregates.ts diimpor lapisan API, bukan hanya test', async () => {
  const apiDir = path.resolve('src/api');
  const files = fs.readdirSync(apiDir).filter((f) => f.endsWith('.ts'));
  const importers = files.filter((f) =>
    /from\s+['"].*aggregates\.js['"]/.test(fs.readFileSync(path.join(apiDir, f), 'utf-8'))
  );
  console.log('   🔗 aggregates.ts diimpor oleh:', importers);
  assert.ok(
    importers.length >= 2,
    'harus diimpor jalur admin DAN publik — kalau 0, fitur kembali tak terjangkau klien'
  );
});
