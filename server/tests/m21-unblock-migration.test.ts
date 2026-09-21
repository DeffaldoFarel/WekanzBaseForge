// M21 — Test regresi untuk tiga blocker migrasi yang ditemukan di M20.
//
// B1: nama field camelCase (userId, namaTagihan) ditolak → 48% skema Wekanz
//     Dashboard tidak bisa dibuat.
// B2: PUT collection membuang `rules` diam-diam → HTTP 200 tanpa perubahan.
// B3: field duplikat menghasilkan 500, bukan 400.
//
// Pelajaran M20 yang diterapkan di sini: setiap operasi tulis diverifikasi
// dengan GET ulang. Memeriksa status respons saja akan meloloskan B2 —
// endpoint itu memang selalu membalas 200.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert';
import nodeHttp from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from '../src/core/router.js';
import { initPlatformDb, closePlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';

const TEST_DATA_DIR = path.join(process.cwd(), 'data-test-m21');
let server: nodeHttp.Server;
let baseURL: string;
let adminToken: string;
let projectId: string;

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
            data = JSON.parse(raw || '{}');
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
  process.env.ADMIN_EMAIL = 'admin@m21.test';
  process.env.ADMIN_PASSWORD = 'm21-admin-password';
  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());

  server = nodeHttp.createServer((req, res) => router.handle(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address() as { port: number };
  baseURL = `http://127.0.0.1:${addr.port}`;

  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@m21.test',
    password: 'm21-admin-password',
  });
  assert.equal(login.status, 200);
  adminToken = login.data.token;

  const proj = await http('POST', '/api/admin/projects', { name: 'm21' }, adminToken);
  assert.equal(proj.status, 201);
  projectId = proj.data.project.id;
});

after(() => {
  closeAllProjectDbs();
  // Windows: rmSync gagal EPERM selama handle platform.db masih terbuka.
  closePlatformDb();
  server?.close();
  setTimeout(() => {
    try {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    } catch {
      /* Windows kadang masih memegang handle — kegagalan cleanup tidak boleh menggagalkan suite */
    }
  }, 100);
});

const P = () => `/api/admin/projects/${projectId}`;

describe('M21 B1 — nama field camelCase', () => {
  test('collection dengan field camelCase berhasil dibuat', async () => {
    const res = await http(
      'POST',
      `${P()}/collections`,
      {
        name: 'billings',
        fields: [
          { name: 'userId', type: 'text' },
          { name: 'namaTagihan', type: 'text' },
          { name: 'dueDate', type: 'text' },
          { name: 'googleEventId', type: 'text' },
          { name: 'nominal', type: 'number' },
        ],
      },
      adminToken
    );
    assert.equal(res.status, 201);
  });

  test('kapitalisasi nama terjaga apa adanya', async () => {
    const res = await http('GET', `${P()}/collections/billings`, undefined, adminToken);
    assert.equal(res.status, 200);
    const names = res.data.collection.fields.map((f: any) => f.name);
    assert.ok(names.includes('namaTagihan'), 'namaTagihan harus utuh, bukan namatagihan');
    assert.ok(names.includes('googleEventId'));
  });

  test('tulis + filter + agregasi memakai nama camelCase', async () => {
    const w = await http(
      'POST',
      `${P()}/collections/billings/records`,
      { userId: 'u1', namaTagihan: 'Listrik', dueDate: '2026-10-01', nominal: 350000 },
      adminToken
    );
    assert.equal(w.status, 201);

    const f = await http(
      'GET',
      `${P()}/collections/billings/records?filter=${encodeURIComponent("userId='u1'")}`,
      undefined,
      adminToken
    );
    assert.equal(f.status, 200);
    assert.equal(f.data.totalItems, 1, 'filter camelCase harus menemukan record');

    const a = await http(
      'GET',
      `${P()}/collections/billings/aggregate?function=sum&field=nominal`,
      undefined,
      adminToken
    );
    assert.equal(a.status, 200);
    assert.equal(a.data.value, 350000);
  });

  test('validasi keamanan TIDAK melonggar', async () => {
    // Nama field disisipkan langsung ke SQL — karakter berbahaya harus tetap ditolak.
    const berbahaya = ['user Id', 'user-Id', 'user;drop', "user'x", '1abc', 'user.id', 'user"q'];
    for (const nama of berbahaya) {
      const res = await http(
        'POST',
        `${P()}/collections`,
        { name: 'sec_probe', fields: [{ name: nama, type: 'text' }] },
        adminToken
      );
      assert.equal(res.status, 400, `nama '${nama}' harus ditolak`);
    }
  });

  test('field sistem ditolak tanpa memandang kapitalisasi', async () => {
    // SQLite menganggap "ID" dan "id" kolom yang sama — menolak hanya huruf
    // kecil akan meloloskan 'ID' lalu gagal sebagai 500 dari SQLite.
    for (const nama of ['id', 'ID', 'Id', 'created', 'CREATED', 'Updated']) {
      const res = await http(
        'POST',
        `${P()}/collections`,
        { name: 'sys_probe', fields: [{ name: nama, type: 'text' }] },
        adminToken
      );
      assert.equal(res.status, 400, `field sistem '${nama}' harus ditolak`);
    }
  });
});

describe('M21 B2 — PUT menyimpan rules', () => {
  const RULE = 'userId = @request.auth.id';

  test('PUT dengan rules benar-benar tersimpan (dibaca ulang)', async () => {
    const before = await http('GET', `${P()}/collections/billings`, undefined, adminToken);
    const fields = before.data.collection.fields;

    const put = await http(
      'PUT',
      `${P()}/collections/billings`,
      { fields, rules: { listRule: RULE } },
      adminToken
    );
    assert.equal(put.status, 200);

    // Inti test: status 200 saja TIDAK cukup — endpoint ini sudah selalu 200
    // bahkan ketika rules dibuang. Keadaan setelahnya yang menentukan.
    const after = await http('GET', `${P()}/collections/billings`, undefined, adminToken);
    assert.equal(after.data.collection.rules.listRule, RULE);
  });

  test('rule yang tidak dikirim dipertahankan (merge, bukan timpa-total)', async () => {
    const cur = await http('GET', `${P()}/collections/billings`, undefined, adminToken);
    const fields = cur.data.collection.fields;

    const put = await http(
      'PUT',
      `${P()}/collections/billings`,
      { fields, rules: { viewRule: RULE } },
      adminToken
    );
    assert.equal(put.status, 200);

    const after = await http('GET', `${P()}/collections/billings`, undefined, adminToken);
    assert.equal(after.data.collection.rules.viewRule, RULE, 'viewRule baru harus tersimpan');
    assert.equal(
      after.data.collection.rules.listRule,
      RULE,
      'listRule lama tidak boleh hilang saat hanya viewRule dikirim'
    );
  });

  test('rule yang menyebut field terhapus ditolak', async () => {
    const cur = await http('GET', `${P()}/collections/billings`, undefined, adminToken);
    const tanpaUserId = cur.data.collection.fields.filter((f: any) => f.name !== 'userId');

    const put = await http(
      'PUT',
      `${P()}/collections/billings`,
      { fields: tanpaUserId, rules: { listRule: 'userId = @request.auth.id' } },
      adminToken
    );
    assert.equal(put.status, 400, 'rule tidak boleh menyebut field yang baru dihapus');
  });

  test('PUT tanpa rules tidak mengubah rules yang ada', async () => {
    const cur = await http('GET', `${P()}/collections/billings`, undefined, adminToken);
    const put = await http(
      'PUT',
      `${P()}/collections/billings`,
      { fields: cur.data.collection.fields },
      adminToken
    );
    assert.equal(put.status, 200);

    const after = await http('GET', `${P()}/collections/billings`, undefined, adminToken);
    assert.equal(after.data.collection.rules.listRule, RULE);
  });
});

describe('M21 B3 — field duplikat menghasilkan 400', () => {
  test('duplikat identik ditolak dengan 400', async () => {
    const res = await http(
      'POST',
      `${P()}/collections`,
      {
        name: 'dup_a',
        fields: [
          { name: 'a', type: 'text' },
          { name: 'a', type: 'number' },
        ],
      },
      adminToken
    );
    assert.equal(res.status, 400, 'kesalahan input klien harus 4xx, bukan 500');
    assert.match(res.data.error.message, /Duplicate field name/i);
  });

  test('duplikat yang hanya beda kapitalisasi juga ditolak', async () => {
    // SQLite sendiri menolak ini ("duplicate column name") — tanpa validasi
    // di hulu, errornya keluar sebagai 500.
    const res = await http(
      'POST',
      `${P()}/collections`,
      {
        name: 'dup_b',
        fields: [
          { name: 'userId', type: 'text' },
          { name: 'userid', type: 'number' },
        ],
      },
      adminToken
    );
    assert.equal(res.status, 400);
    assert.match(res.data.error.message, /Duplicate field name/i);
  });

  test('duplikat pada PUT juga ditolak dengan 400', async () => {
    const res = await http(
      'PUT',
      `${P()}/collections/billings`,
      {
        fields: [
          { name: 'Order', type: 'number' },
          { name: 'order', type: 'text' },
        ],
      },
      adminToken
    );
    assert.equal(res.status, 400);
  });

  test('collection tetap utuh setelah penolakan duplikat', async () => {
    // Validasi harus terjadi SEBELUM SQL dijalankan — bukan setengah jalan.
    const res = await http('GET', `${P()}/collections/billings`, undefined, adminToken);
    assert.equal(res.status, 200);
    const names = res.data.collection.fields.map((f: any) => f.name);
    assert.ok(names.includes('namaTagihan'), 'skema lama harus tetap utuh');
  });
});
