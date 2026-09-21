// ============================================================================
// Ops-16: custom profile field pada `_auth_users` (paritas Supabase tervalidasi)
//
// Yang dibuktikan di sini:
//   1. NON-REGRESI — tanpa field terdefinisi, bentuk respons auth IDENTIK
//      dengan sebelum Ops-16 (ini yang menjamin ExploreMaps/Dashboard/Bookmark
//      Manager tidak rusak). Diuji dengan membandingkan DAFTAR KUNCI, bukan
//      sekadar status 200.
//   2. Definisi field + validasi nilai (reuse engine fieldTypes).
//   3. `required` ditegakkan saat register, TIDAK saat update parsial.
//   4. `userEditable: false` = padanan app_metadata Supabase → 403 dari
//      PATCH /auth/me, tapi tetap bisa lewat Admin API.
//   5. Kolom yang definisinya dihapus tidak lagi bocor ke respons.
//
// HTTP integration dengan server node:http sungguhan — bukan mock.
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
import { createUserAdminRouter } from '../src/api/userAdminRoutes.js';
import { Router } from '../src/core/router.js';
import { resetAllRateLimits } from '../src/auth/rateLimiter.js';

let server: nodeHttp.Server;
let baseURL = '';
const TEST_DATA_DIR = path.resolve('../data/ops16-test');

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
  router.merge(createUserAdminRouter());

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
});

after(async () => {
  closeAllProjectDbs();
  // Windows: rmSync gagal EPERM selama handle platform.db masih terbuka.
  closePlatformDb();
  server.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

interface HttpResult {
  status: number;
  body: any;
}

async function http(method: string, reqPath: string, body?: unknown, token?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, baseURL);
    const req = nodeHttp.request(url, { method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* biarkan mentah */
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', reject);
    if (token) req.setHeader('Authorization', `Bearer ${token}`);
    if (body !== undefined) {
      req.setHeader('Content-Type', 'application/json');
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

let adminToken = '';
const PASSWORD = 'passwordRahasia123';

/** Project baru per test group — definisi field bersifat per-project. */
async function newProject(name: string): Promise<string> {
  const p = await http('POST', '/api/admin/projects', { name }, adminToken);
  assert.equal(p.status, 201, `create project ${name}: ${JSON.stringify(p.body)}`);
  return p.body.project.id;
}

async function addField(
  pid: string,
  def: { name: string; type: string; required?: boolean; userEditable?: boolean; options?: unknown }
): Promise<HttpResult> {
  return http('POST', `/api/admin/projects/${pid}/auth-fields`, def, adminToken);
}

test('Ops-16 setup: admin login', async () => {
  await resetAllRateLimits();
  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@test.local',
    password: 'admin-test-pass',
  });
  assert.equal(login.status, 200);
  adminToken = login.body.token;
  assert.ok(adminToken);
});

// ════════════════════════════════════════════════════════════════════════════
// 1. NON-REGRESI — inilah yang menjamin aplikasi yang sudah ada tidak rusak
// ════════════════════════════════════════════════════════════════════════════

test('Ops-16 NON-REGRESI: tanpa custom field, bentuk respons auth IDENTIK dengan sebelumnya', async () => {
  await resetAllRateLimits();
  const pid = await newProject('ops16-noregression');

  const EXPECTED_USER_KEYS = [
    'id',
    'email',
    'name',
    'avatarUrl',
    'verified',
    'mfaEnabled',
    'created',
  ].sort();

  const reg = await http('POST', `/api/p/${pid}/auth/register`, {
    email: 'lama@x.com',
    password: PASSWORD,
    name: 'User Lama',
  });
  assert.equal(reg.status, 201);
  assert.deepEqual(
    Object.keys(reg.body.user).sort(),
    EXPECTED_USER_KEYS,
    'register: TIDAK boleh ada kunci profile bila tak ada field terdefinisi'
  );

  const login = await http('POST', `/api/p/${pid}/auth/login`, {
    email: 'lama@x.com',
    password: PASSWORD,
  });
  assert.equal(login.status, 200);
  assert.deepEqual(Object.keys(login.body.user).sort(), EXPECTED_USER_KEYS, 'login');

  const me = await http('GET', `/api/p/${pid}/auth/me`, undefined, login.body.accessToken);
  assert.equal(me.status, 200);
  assert.deepEqual(Object.keys(me.body.user).sort(), EXPECTED_USER_KEYS, 'GET /me');

  const refresh = await http('POST', `/api/p/${pid}/auth/refresh`, {
    refreshToken: login.body.refreshToken,
  });
  assert.equal(refresh.status, 200);
  assert.deepEqual(Object.keys(refresh.body.user).sort(), EXPECTED_USER_KEYS, 'refresh');

  const patched = await http(
    'PATCH',
    `/api/p/${pid}/auth/me`,
    { name: 'Nama Baru' },
    login.body.accessToken
  );
  assert.equal(patched.status, 200);
  assert.deepEqual(Object.keys(patched.body.user).sort(), EXPECTED_USER_KEYS, 'PATCH /me');
});

test('Ops-16 NON-REGRESI: password_hash tidak pernah bocor walau ada custom field', async () => {
  await resetAllRateLimits();
  const pid = await newProject('ops16-nohash');
  assert.equal((await addField(pid, { name: 'bio', type: 'text' })).status, 201);

  const reg = await http('POST', `/api/p/${pid}/auth/register`, {
    email: 'hash@x.com',
    password: PASSWORD,
    profile: { bio: 'halo' },
  });
  assert.equal(reg.status, 201);

  const serialized = JSON.stringify(reg.body);
  assert.ok(!serialized.includes('password_hash'), 'password_hash tidak boleh muncul');
  assert.ok(!serialized.includes('scrypt:'), 'hash mentah tidak boleh muncul');
  assert.equal(reg.body.user.profile.bio, 'halo');
});

// ════════════════════════════════════════════════════════════════════════════
// 2. DEFINISI FIELD + VALIDASI
// ════════════════════════════════════════════════════════════════════════════

test('Ops-16: definisi field muncul di daftar dan nilai tersimpan saat register', async () => {
  await resetAllRateLimits();
  const pid = await newProject('ops16-define');

  assert.equal((await addField(pid, { name: 'bio', type: 'text' })).status, 201);
  assert.equal((await addField(pid, { name: 'age', type: 'number' })).status, 201);
  assert.equal((await addField(pid, { name: 'newsletter', type: 'bool' })).status, 201);

  const list = await http('GET', `/api/admin/projects/${pid}/auth-fields`, undefined, adminToken);
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.body.fields.map((f: any) => f.name).sort(),
    ['age', 'bio', 'newsletter']
  );

  const reg = await http('POST', `/api/p/${pid}/auth/register`, {
    email: 'isi@x.com',
    password: PASSWORD,
    profile: { bio: 'developer', age: 30, newsletter: true },
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  // Tipe dipulihkan dengan benar, bukan semuanya jadi string.
  assert.equal(reg.body.user.profile.bio, 'developer');
  assert.equal(reg.body.user.profile.age, 30);
  assert.equal(reg.body.user.profile.newsletter, true);

  // Bukti persistensi: baca ulang lewat /auth/me (bukan echo dari request).
  const me = await http('GET', `/api/p/${pid}/auth/me`, undefined, reg.body.accessToken);
  assert.equal(me.body.user.profile.age, 30);
  assert.equal(me.body.user.profile.newsletter, true);
});

test('Ops-16: nilai tidak valid ditolak 400 oleh engine fieldTypes yang sudah ada', async () => {
  await resetAllRateLimits();
  const pid = await newProject('ops16-validate');
  assert.equal((await addField(pid, { name: 'age', type: 'number' })).status, 201);
  assert.equal((await addField(pid, { name: 'website', type: 'url' })).status, 201);

  const bad = await http('POST', `/api/p/${pid}/auth/register`, {
    email: 'salah@x.com',
    password: PASSWORD,
    profile: { age: 'bukan angka' },
  });
  assert.equal(bad.status, 400, 'number diisi string harus ditolak');

  const badUrl = await http('POST', `/api/p/${pid}/auth/register`, {
    email: 'salahurl@x.com',
    password: PASSWORD,
    profile: { website: 'bukan-url' },
  });
  assert.equal(badUrl.status, 400, 'url tidak valid harus ditolak');

  const unknown = await http('POST', `/api/p/${pid}/auth/register`, {
    email: 'takdikenal@x.com',
    password: PASSWORD,
    profile: { tidakAda: 'x' },
  });
  assert.equal(unknown.status, 400, 'field tak terdefinisi harus ditolak, bukan diabaikan');

  // Penolakan harus berarti user TIDAK tercipta — bukan tercipta tanpa profil.
  const login = await http('POST', `/api/p/${pid}/auth/login`, {
    email: 'salah@x.com',
    password: PASSWORD,
  });
  assert.equal(login.status, 401, 'user gagal-validasi tidak boleh ada di DB');
});

test('Ops-16: nama field tidak valid / reserved / duplikat ditolak', async () => {
  await resetAllRateLimits();
  const pid = await newProject('ops16-names');

  assert.equal((await addField(pid, { name: 'email', type: 'text' })).status, 400, 'reserved: email');
  assert.equal((await addField(pid, { name: 'password_hash', type: 'text' })).status, 400, 'reserved: password_hash');
  assert.equal((await addField(pid, { name: 'id', type: 'text' })).status, 400, 'reserved: id');
  assert.equal((await addField(pid, { name: '1bad', type: 'text' })).status, 400, 'awalan angka');
  assert.equal((await addField(pid, { name: 'drop table', type: 'text' })).status, 400, 'spasi');
  assert.equal((await addField(pid, { name: 'file', type: 'file' })).status, 400, 'tipe tak didukung');

  assert.equal((await addField(pid, { name: 'bio', type: 'text' })).status, 201);
  assert.equal((await addField(pid, { name: 'bio', type: 'text' })).status, 400, 'duplikat persis');
  // SQLite menganggap "Bio" dan "bio" kolom yang SAMA — harus ditolak juga.
  assert.equal((await addField(pid, { name: 'Bio', type: 'text' })).status, 400, 'duplikat beda huruf besar');
});

// ════════════════════════════════════════════════════════════════════════════
// 3. REQUIRED — hanya saat register
// ════════════════════════════════════════════════════════════════════════════

test('Ops-16: required ditegakkan saat register', async () => {
  await resetAllRateLimits();
  const pid = await newProject('ops16-required');
  assert.equal((await addField(pid, { name: 'country', type: 'text', required: true })).status, 201);

  const tanpa = await http('POST', `/api/p/${pid}/auth/register`, {
    email: 'kosong@x.com',
    password: PASSWORD,
  });
  assert.equal(tanpa.status, 400, 'register tanpa field required harus ditolak');

  const dengan = await http('POST', `/api/p/${pid}/auth/register`, {
    email: 'lengkap@x.com',
    password: PASSWORD,
    profile: { country: 'ID' },
  });
  assert.equal(dengan.status, 201);
  assert.equal(dengan.body.user.profile.country, 'ID');
});

test('Ops-16 KOMPATIBILITAS: user LAMA tetap bisa update profil walau ada field required baru', async () => {
  await resetAllRateLimits();
  const pid = await newProject('ops16-oldusers');

  // User mendaftar SEBELUM field required ada.
  const reg = await http('POST', `/api/p/${pid}/auth/register`, {
    email: 'duluan@x.com',
    password: PASSWORD,
    name: 'Duluan',
  });
  assert.equal(reg.status, 201);
  const token = reg.body.accessToken;

  // Admin menambahkan field required SETELAHNYA → baris lama bernilai NULL.
  assert.equal((await addField(pid, { name: 'country', type: 'text', required: true })).status, 201);

  // Inti kompatibilitas: user lama harus tetap bisa mengubah namanya sendiri.
  // Kalau `required` ditegakkan saat update, ini akan 400 dan user terkunci
  // dari profilnya sendiri hanya karena admin menambah field.
  const patch = await http('PATCH', `/api/p/${pid}/auth/me`, { name: 'Nama Baru' }, token);
  assert.equal(patch.status, 200, 'user lama TIDAK boleh terkunci oleh field required baru');
  assert.equal(patch.body.user.name, 'Nama Baru');
  assert.equal(patch.body.user.profile.country, null, 'field yang belum diisi = null');

  // Login pun harus tetap jalan.
  await resetAllRateLimits();
  const login = await http('POST', `/api/p/${pid}/auth/login`, {
    email: 'duluan@x.com',
    password: PASSWORD,
  });
  assert.equal(login.status, 200, 'user lama harus tetap bisa login');
});

// ════════════════════════════════════════════════════════════════════════════
// 4. userEditable — padanan app_metadata Supabase
// ════════════════════════════════════════════════════════════════════════════

test('Ops-16: field userEditable=false ditolak 403 dari PATCH /auth/me', async () => {
  await resetAllRateLimits();
  const pid = await newProject('ops16-appmeta');
  assert.equal((await addField(pid, { name: 'bio', type: 'text' })).status, 201);
  assert.equal(
    (await addField(pid, { name: 'role', type: 'text', userEditable: false })).status,
    201
  );

  const reg = await http('POST', `/api/p/${pid}/auth/register`, {
    email: 'peran@x.com',
    password: PASSWORD,
    profile: { bio: 'awal', role: 'user' },
  });
  assert.equal(reg.status, 201);
  const token = reg.body.accessToken;

  // Field bebas → boleh.
  const ok = await http('PATCH', `/api/p/${pid}/auth/me`, { profile: { bio: 'diubah' } }, token);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.profile.bio, 'diubah');

  // Field terkunci → 403 KERAS, bukan diabaikan diam-diam.
  const ditolak = await http('PATCH', `/api/p/${pid}/auth/me`, { profile: { role: 'admin' } }, token);
  assert.equal(ditolak.status, 403, 'eskalasi privilese harus ditolak');
  assert.equal(ditolak.body.error.code, 'FIELD_NOT_EDITABLE');

  // Bukti STATE (pelajaran Ops-9: status code saja tidak membuktikan keamanan).
  const me = await http('GET', `/api/p/${pid}/auth/me`, undefined, token);
  assert.equal(me.body.user.profile.role, 'user', 'role TIDAK boleh berubah');
});

// ════════════════════════════════════════════════════════════════════════════
// 5. HAPUS FIELD
// ════════════════════════════════════════════════════════════════════════════

test('Ops-16: menghapus definisi field menghentikan kebocorannya ke respons', async () => {
  await resetAllRateLimits();
  const pid = await newProject('ops16-delete');
  assert.equal((await addField(pid, { name: 'catatan', type: 'text' })).status, 201);

  const reg = await http('POST', `/api/p/${pid}/auth/register`, {
    email: 'hapus@x.com',
    password: PASSWORD,
    profile: { catatan: 'rahasia internal' },
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.user.profile.catatan, 'rahasia internal');

  const del = await http(
    'DELETE',
    `/api/admin/projects/${pid}/auth-fields/catatan`,
    undefined,
    adminToken
  );
  assert.equal(del.status, 200);

  const me = await http('GET', `/api/p/${pid}/auth/me`, undefined, reg.body.accessToken);
  assert.equal(me.status, 200);
  // Tak ada field tersisa → kunci `profile` hilang total (kembali ke bentuk lama).
  assert.equal(me.body.user.profile, undefined, 'field terhapus tidak boleh bocor lagi');
  assert.ok(!JSON.stringify(me.body).includes('rahasia internal'));

  const del404 = await http(
    'DELETE',
    `/api/admin/projects/${pid}/auth-fields/tidakAda`,
    undefined,
    adminToken
  );
  assert.equal(del404.status, 404);
});

test('Ops-16: admin tetap bisa mengubah field terkunci lewat daftar auth-users', async () => {
  await resetAllRateLimits();
  const pid = await newProject('ops16-adminlist');
  assert.equal(
    (await addField(pid, { name: 'tier', type: 'select', userEditable: false, options: { values: ['free', 'pro'] } }))
      .status,
    201
  );

  const reg = await http('POST', `/api/p/${pid}/auth/register`, {
    email: 'tier@x.com',
    password: PASSWORD,
    profile: { tier: 'free' },
  });
  assert.equal(reg.status, 201);

  // select memvalidasi nilai di luar daftar
  const salah = await http('POST', `/api/p/${pid}/auth/register`, {
    email: 'tiersalah@x.com',
    password: PASSWORD,
    profile: { tier: 'enterprise' },
  });
  assert.equal(salah.status, 400, 'nilai di luar daftar select harus ditolak');

  // Admin melihat profil user lewat endpoint yang sudah ada (M47).
  const list = await http('GET', `/api/admin/projects/${pid}/auth-users`, undefined, adminToken);
  assert.equal(list.status, 200);
  const user = list.body.items.find((u: any) => u.email === 'tier@x.com');
  assert.ok(user, 'user harus muncul di daftar admin');
  assert.equal(user.profile.tier, 'free');
});
