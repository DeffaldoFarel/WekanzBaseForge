// ============================================================================
// SECURITY: API surface & authorization — temuan audit FASE 2 (2026-10)
//
// AUD-2-01 — evaluateRuleOnData (rules.ts) adalah evaluator regex yang
//   MENGABAIKAN TANDA KURUNG: rule `a && (b || c)` dievaluasi sebagai
//   `(a && b) || c` di jalur view/update/delete/create. Probe lama: user B
//   berhasil GET+PATCH+DELETE record milik user A (bypass penuh), sementara
//   LIST (parser SQL) menolak — dua jalur, dua keputusan. Kini rule dievaluasi
//   lewat parser AST ASLI — konsisten dengan jalur LIST.
//
// AUD-2-02 — expandRecords: (a) viewRule collection target tidak dicek —
//   record admin-only bocor via ?expand=; (b) target ditempel sebagai RAW ROW
//   tanpa deserializeRow → scrypt hash field password & password_hash
//   collection auth ikut ke response.
//
// AUD-2-03 — vectorSearch mengembalikan raw row (hash password bocor).
// AUD-2-04 — pesan error filter membocorkan daftar field skema.
// AUD-2-05 — vector-search tanpa rate limit (full-scan per request).
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
import { resetAllRateLimits, closeRateLimiter } from '../src/auth/rateLimiter.js';
import { Router } from '../src/core/router.js';

let server: nodeHttp.Server;
let baseURL = '';
const TEST_DATA_DIR = path.resolve('../data/sec-api-surface-test');

let pid: string;
let adminToken: string;
let tokenA: string;
let tokenB: string;
let userAId: string;
let docId: string;
let vaultId: string;
let memberId: string;
let vecDocId: string;

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
        try { data = JSON.parse(text); } catch { data = null; }
        resolve({ status: res.statusCode ?? 0, data });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

before(async () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  process.env.DATA_DIR = TEST_DATA_DIR;
  process.env.ADMIN_EMAIL = 'admin@test.local';
  process.env.ADMIN_PASSWORD = 'admin-test-pass';
  process.env.STORAGE_DIR = path.join(TEST_DATA_DIR, 'storage');

  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());
  router.merge(createProjectAuthRouter());
  router.merge(createPublicRouter());

  server = nodeHttp.createServer((req, res) => { router.handle(req, res); });
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      baseURL = `http://localhost:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });

  const login = await http('POST', '/api/admin/auth/login', { email: 'admin@test.local', password: 'admin-test-pass' });
  adminToken = login.data.token;
  const proj = await http('POST', '/api/admin/projects', { name: 'sec-api-surface' }, adminToken);
  pid = proj.data.project.id;

  // docs: rule ber-tanda kurung (ini jantung AUD-2-01)
  await http('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'docs',
    fields: [
      { name: 'title', type: 'text' },
      { name: 'userId', type: 'text' },
      { name: 'visibility', type: 'text' },
      { name: 'owner', type: 'relation', options: { collectionId: 'vault' } },
      { name: 'author', type: 'relation', options: { collectionId: 'members' } },
    ],
  }, adminToken);
  const PAREN_RULE = 'userId = @request.auth.id && (visibility = "public" || visibility = "shared")';
  await http('PATCH', `/api/admin/projects/${pid}/collections/docs/rules`, {
    listRule: PAREN_RULE, viewRule: PAREN_RULE, updateRule: PAREN_RULE, deleteRule: PAREN_RULE,
  }, adminToken);

  // vault: ADMIN-ONLY (viewRule null) + field password — target expand yang bocor
  await http('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'vault',
    fields: [{ name: 'name', type: 'text' }, { name: 'userPin', type: 'password' }],
  }, adminToken);

  // members: collection TIPE AUTH (punya kolom password_hash)
  await http('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'members', type: 'auth',
    fields: [{ name: 'name', type: 'text' }],
  }, adminToken);

  // vectors: publik + password field + vector (untuk AUD-2-03/05)
  await http('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'vectors',
    fields: [
      { name: 'label', type: 'text' },
      { name: 'pin', type: 'password' },
      { name: 'vec', type: 'vector', options: { dimensions: 3 } },
    ],
  }, adminToken);
  await http('PATCH', `/api/admin/projects/${pid}/collections/vectors/rules`, { listRule: '' }, adminToken);

  // Users
  const regA = await http('POST', `/api/p/${pid}/auth/register`, { email: 'a@surf.test', password: 'passwordA-123' });
  tokenA = regA.data.accessToken;
  userAId = regA.data.user.id;
  const regB = await http('POST', `/api/p/${pid}/auth/register`, { email: 'b@surf.test', password: 'passwordB-123' });
  tokenB = regB.data.accessToken;

  // Data
  const vaultRec = await http('POST', `/api/admin/projects/${pid}/collections/vault/records`,
    { name: 'vault-1', userPin: 'hunter2-secret' }, adminToken);
  vaultId = vaultRec.data.record.id;
  const memberRec = await http('POST', `/api/admin/projects/${pid}/collections/members/records`,
    { email: 'member@surf.test', password: 'member-pass-123', name: 'Anggota' }, adminToken);
  memberId = memberRec.data.record.id;
  const docRec = await http('POST', `/api/admin/projects/${pid}/collections/docs/records`,
    { title: 'milik A', userId: userAId, visibility: 'shared', owner: vaultId, author: memberId }, adminToken);
  docId = docRec.data.record.id;
  const vecRec = await http('POST', `/api/admin/projects/${pid}/collections/vectors/records`,
    { label: 'v1', pin: 'pin-secret-123', vec: [1, 0, 0] }, adminToken);
  vecDocId = vecRec.data.record.id;
});

after(async () => {
  await closeRateLimiter();
  closeAllProjectDbs();
  closePlatformDb();
  server.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test('AUD-2-01: rule ber-kurung konsisten — user B TIDAK bisa baca/ubah/hapus record A', async () => {
  // LIST (jalur SQL — sudah benar sejak awal, jadi invariant konsistensi)
  const list = await http('GET', `/api/p/${pid}/collections/docs/records`, undefined, tokenB);
  assert.equal(list.status, 200);
  assert.equal(list.data.totalItems, 0, 'LIST: user B tidak boleh melihat record A (parser SQL)');

  // GET (jalur evaluator — SEBELUM fix: 200 BYPASS)
  const get = await http('GET', `/api/p/${pid}/collections/docs/records/${docId}`, undefined, tokenB);
  assert.equal(get.status, 404, 'GET: user B harus ditolak (sebelumnya 200 — bypass kurung)');

  // PATCH (SEBELUM fix: 200 BYPASS)
  const patch = await http('PATCH', `/api/p/${pid}/collections/docs/records/${docId}`, { title: 'dirusak' }, tokenB);
  assert.equal(patch.status, 403, 'PATCH: user B harus ditolak (sebelumnya 200 — bypass kurung)');

  // Pemilik tetap bisa (regressi anti over-blocking)
  const own = await http('GET', `/api/p/${pid}/collections/docs/records/${docId}`, undefined, tokenA);
  assert.equal(own.status, 200, 'user A (pemilik) tetap bisa membaca record sendiri');
  assert.equal(own.data.record.title, 'milik A');
});

test('AUD-2-01: createRule ber-kurung — kedua arah evaluasi benar', async () => {
  // Rule: tag x selalu boleh; tag y hanya bila flag true.
  // Regex lama: (tag=x || tag=y) && flag → tag=x dengan flag=false DITOLAK (salah).
  // Parser benar: tag=x || (tag=y && flag) → BOLEH.
  await http('PATCH', `/api/admin/projects/${pid}/collections/docs/rules`, {
    createRule: 'visibility = "x" || (visibility = "y" && title = "flagged")',
  }, adminToken);

  const ok = await http('POST', `/api/p/${pid}/collections/docs/records`,
    { title: 'biasa', userId: userAId, visibility: 'x' }, tokenA);
  assert.equal(ok.status, 201, 'visibility=x harus lolos createRule walau title bukan "flagged" (sebelumnya salah ditolak)');

  const bad = await http('POST', `/api/p/${pid}/collections/docs/records`,
    { title: 'biasa', userId: userAId, visibility: 'y' }, tokenA);
  assert.equal(bad.status, 403, 'visibility=y TANPA title="flagged" harus ditolak (sebelumnya salah lolos)');

  const flagged = await http('POST', `/api/p/${pid}/collections/docs/records`,
    { title: 'flagged', userId: userAId, visibility: 'y' }, tokenA);
  assert.equal(flagged.status, 201, 'visibility=y DENGAN title="flagged" harus lolos');

  // restore rules untuk test berikutnya
  const PAREN_RULE = 'userId = @request.auth.id && (visibility = "public" || visibility = "shared")';
  await http('PATCH', `/api/admin/projects/${pid}/collections/docs/rules`, {
    createRule: PAREN_RULE, updateRule: PAREN_RULE, deleteRule: PAREN_RULE, viewRule: PAREN_RULE, listRule: PAREN_RULE,
  }, adminToken);
});

test('AUD-2-02: expand menegakkan viewRule target + record ter-deserialize (tanpa hash)', async () => {
  // Catatan: expand mendukung SATU relasi atau dot-notation ('a.b'), bukan
  // koma — jadi tiap relasi diuji dengan request terpisah (assertion tidak
  // boleh lolos secara kosong karena expand diabaikan).
  const direct = await http('GET', `/api/p/${pid}/collections/vault/records/${vaultId}`, undefined, tokenA);
  assert.equal(direct.status, 404, 'vault admin-only — akses langsung ditolak');

  // user A boleh baca doc (pemilik), tapi vault admin-only → expand.owner TIDAK BOLEH ada
  const expOwner = await http('GET', `/api/p/${pid}/collections/docs/records/${docId}?expand=owner`, undefined, tokenA);
  assert.equal(expOwner.status, 200, 'user A tetap bisa membaca doc miliknya');
  assert.equal((expOwner.data?.record?.expand ?? {}).owner, undefined,
    'expand.owner (collection admin-only) TIDAK boleh bocor (sebelumnya: record penuh + scrypt hash)');

  const expAuthor = await http('GET', `/api/p/${pid}/collections/docs/records/${docId}?expand=author`, undefined, tokenA);
  assert.equal((expAuthor.data?.record?.expand ?? {}).author, undefined,
    'expand.author (viewRule null di members) TIDAK boleh bocor (sebelumnya: password_hash terkirim)');

  // ADMIN: expand tetap jalan (bypass rules) TAPI hasil ter-deserialize —
  // field password hilang (bukan raw scrypt hash).
  const adminOwner = await http('GET', `/api/p/${pid}/collections/docs/records/${docId}?expand=owner`, undefined, adminToken);
  assert.equal(adminOwner.status, 200);
  const aOwner = adminOwner.data?.record?.expand ?? {};
  assert.ok(aOwner.owner, 'admin expand.owner tetap ada (bypass rules)');
  assert.equal(aOwner.owner.userPin, undefined, 'field password TIDAK boleh muncul di expand (sebelumnya: scrypt hash mentah)');

  const adminAuthor = await http('GET', `/api/p/${pid}/collections/docs/records/${docId}?expand=author`, undefined, adminToken);
  const aAuthor = adminAuthor.data?.record?.expand ?? {};
  assert.ok(aAuthor.author, 'admin expand.author tetap ada');
  assert.equal(aAuthor.author.password_hash, undefined, 'password_hash collection auth TIDAK boleh muncul (sebelumnya: bocor)');
  assert.equal(aAuthor.author.name, 'Anggota', 'field biasa tetap utuh setelah deserialize');
});

test('AUD-2-03: hasil vector-search ter-deserialize (tanpa hash password)', async () => {
  const vs = await http('POST', `/api/p/${pid}/collections/vectors/vector-search`, { vector: [1, 0, 0], k: 5 }, tokenA);
  assert.equal(vs.status, 200, JSON.stringify(vs.data));
  const rec = vs.data?.items?.[0]?.record;
  assert.ok(rec, 'hasil harus ada');
  assert.equal(rec.pin, undefined, 'field password TIDAK boleh muncul di record hasil (sebelumnya: scrypt hash bocor)');
  assert.equal(rec.label, 'v1', 'field biasa tetap ada');
  assert.deepEqual(rec.vec, [1, 0, 0], 'vector ter-parse sebagai array (bukan string JSON mentah)');
});

test('AUD-2-04: pesan error filter tidak membocorkan daftar field skema', async () => {
  const r = await http('GET', `/api/p/${pid}/collections/docs/records?filter=${encodeURIComponent('tidakada = 1')}`, undefined, tokenA);
  assert.equal(r.status, 400);
  const msg = String(r.data?.error?.message ?? '');
  assert.ok(!msg.includes('Available fields'), `daftar field tidak boleh bocor: ${msg}`);
  assert.ok(msg.includes("tidakada"), 'nama field yang salah tetap disebut (UX debugging)');
});

test('AUD-2-05: vector-search kena rate limit (30/menit per project+IP)', async () => {
  await resetAllRateLimits();
  let s429 = 0;
  for (let i = 0; i < 32; i++) {
    const r = await http('POST', `/api/p/${pid}/collections/vectors/vector-search`, { vector: [1, 0, 0] }, tokenA);
    if (r.status === 429) s429++;
  }
  assert.ok(s429 >= 2, `percobaan 31-32 harus 429 (dapat ${s429}) — sebelumnya TIDAK ADA limit`);
});

test('regresi: delete oleh pemilik tetap bisa; anonymous rule @request tetap 1=0', async () => {
  // Pemilik hapus record sendiri (viewRule/deleteRule ber-kurung harus lolos untuk pemilik)
  const del = await http('DELETE', `/api/p/${pid}/collections/docs/records/${docId}`, undefined, tokenA);
  assert.equal(del.status, 200, 'pemilik harus bisa menghapus record sendiri');

  // Anonymous + rule @request → LIST kosong (regresi 20c1268)
  const anon = await http('GET', `/api/p/${pid}/collections/docs/records`);
  assert.equal(anon.status, 200);
  assert.equal(anon.data.totalItems, 0, 'anonymous + rule @request harus 0 hasil');

  // Kontrol negatif: injection tetap aman
  const sortInj = await http('GET', `/api/p/${pid}/collections/docs/records?sort=${encodeURIComponent('created DESC; DROP TABLE docs')}`, undefined, tokenA);
  assert.equal(sortInj.status, 400, 'sort injection tetap ditolak');
});
