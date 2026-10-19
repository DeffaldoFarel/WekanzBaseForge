// ============================================================================
// AUD-4-01..05 (FASE 4: Storage & Upload) — repro & regression
//
// AUD-4-01 🔴 traversal WRITE di luar storage root: PATCH multipart memanggil
//          saveFile SEBELUM updateRecord memvalidasi rid (router mendecode
//          %2F) + LocalDiskAdapter.save TANPA guard traversal.
// AUD-4-02 🔴 stored XSS bucket serve: contentType client dipercaya + inline.
// AUD-4-03 🟡 Cache-Control: public pada file yang digerbang viewRule.
// AUD-4-04 🟡 tidak ada kuota storage per-project (disk exhaustion).
// AUD-4-05 🔵 traversal DELETE via admin storage delete route (guard adapter).
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import nodeHttp from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initPlatformDb, closePlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';
import { createProjectAuthRouter } from '../src/api/authRoutes.js';
import { createPublicRouter } from '../src/api/publicRoutes.js';
import { createStorageRouter } from '../src/api/storageRoutes.js';
import { createBucketRouter } from '../src/api/bucketRoutes.js';
import { Router } from '../src/core/router.js';

// ─── Harness ─────────────────────────────────────────────────────────────────

const SCRATCH = path.join(os.tmpdir(), 'baseforge-aud4-test');
const DATA_DIR = path.join(SCRATCH, 'data');
const STORAGE_DIR = path.join(SCRATCH, 'storage');

let server: nodeHttp.Server;
let baseURL = '';
let pid = '';
let adminToken = '';
let tokenA = '';
let tokenB = '';
let userIdA = '';

async function req(method: string, reqPath: string, body?: Buffer | unknown, token?: string, contentType?: string): Promise<{ status: number; headers: Record<string, string>; data: any }> {
  const url = new URL(reqPath, baseURL);
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = 'Bear' + 'er ' + token;
  let payload: Buffer | undefined;
  if (Buffer.isBuffer(body)) {
    payload = body;
    headers['Content-Type'] = contentType ?? 'application/octet-stream';
  } else if (body !== undefined) {
    payload = Buffer.from(JSON.stringify(body));
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { method, headers, body: payload as never });
  const text = Buffer.from(await res.arrayBuffer()).toString('utf-8');
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* biner */ }
  const h: Record<string, string> = {};
  res.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
  return { status: res.status, headers: h, data };
}

function multipart(parts: { name: string; filename?: string; contentType?: string; data: Buffer | string }[]): { body: Buffer; contentType: string } {
  const B = '----aud4' + Math.random().toString(36).slice(2);
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${B}\r\n`));
    if (p.filename) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n`));
      chunks.push(Buffer.from(`Content-Type: ${p.contentType ?? 'application/octet-stream'}\r\n\r\n`));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n`));
    }
    chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${B}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${B}` };
}

function countProjectFiles(): number {
  const dir = path.join(STORAGE_DIR, pid);
  try { return fs.readdirSync(dir).length; } catch { return 0; }
}

async function waitForExists(p: string, maxMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (!fs.existsSync(p)) {
    if (Date.now() - start > maxMs) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

let realRid = '';
let realFile = '';
let privRid = '';
let privFile = '';

before(async () => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.env.DATA_DIR = DATA_DIR;
  process.env.STORAGE_DIR = STORAGE_DIR;
  process.env.ADMIN_EMAIL = 'admin@test.local';
  process.env.ADMIN_PASSWORD = 'admin-test-pass';

  initPlatformDb();
  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());
  router.merge(createProjectAuthRouter());
  router.merge(createPublicRouter());
  router.merge(createStorageRouter());
  router.merge(createBucketRouter());
  server = nodeHttp.createServer((q, s) => router.handle(q, s));
  await new Promise<void>((r) => server.listen(0, () => r()));
  baseURL = `http://localhost:${(server.address() as { port: number }).port}`;

  const login = await req('POST', '/api/admin/auth/login', { email: 'admin@test.local', password: 'admin-test-pass' });
  adminToken = login.data.token;
  const proj = await req('POST', '/api/admin/projects', { name: 'aud4' }, adminToken);
  pid = proj.data.project.id;

  await req('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'docs',
    fields: [{ name: 'att', type: 'file', options: { maxSize: 5 * 1024 * 1024 } }],
    rules: { createRule: '', updateRule: '', viewRule: '' },
  }, adminToken);
  await req('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'priv',
    fields: [{ name: 'userId', type: 'text' }, { name: 'doc', type: 'file' }],
    rules: { createRule: 'userId = @request.auth.id', updateRule: 'userId = @request.auth.id', viewRule: 'userId = @request.auth.id' },
  }, adminToken);

  const regA = await req('POST', `/api/p/${pid}/auth/register`, { email: 'a@aud4.test', password: 'Passw0rd!234' });
  tokenA = regA.data.accessToken;
  userIdA = regA.data.user?.id ?? regA.data.record?.id;
  const regB = await req('POST', `/api/p/${pid}/auth/register`, { email: 'b@aud4.test', password: 'Passw0rd!234' });
  tokenB = regB.data.accessToken;

  // Record 'docs' nyata (untuk kontrol PATCH normal)
  const okBody = multipart([{ name: 'att', filename: 'normal.txt', contentType: 'text/plain', data: 'isi-normal' }]);
  const okCreate = await req('POST', `/api/p/${pid}/collections/docs/records`, okBody.body, undefined, okBody.contentType);
  realRid = okCreate.data?.record?.id;
  realFile = okCreate.data?.record?.att;

  // Record 'priv' milik A (untuk tes cache-private + PATCH tanpa izin)
  const privBody = multipart([
    { name: 'userId', data: String(userIdA) },
    { name: 'doc', filename: 'secret.txt', contentType: 'text/plain', data: 'RAHASIA' },
  ]);
  const pc = await req('POST', `/api/p/${pid}/collections/priv/records`, privBody.body, tokenA, privBody.contentType);
  privRid = pc.data?.record?.id;
  privFile = pc.data?.record?.doc;
  assert.ok(realRid && realFile && privRid && privFile, 'setup record harus sukses');
});

after(async () => {
  closeAllProjectDbs();
  closePlatformDb();
  server.close();
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

// ─── AUD-4-01: traversal write via multipart PATCH ──────────────────────────

test('AUD-4-01: PATCH rid traversal TIDAK menulis file di luar storage root', async () => {
  const pwn = multipart([{ name: 'att', filename: 'pwned.txt', contentType: 'text/plain', data: 'ESCAPED' }]);
  const r1 = await req('PATCH', `/api/p/${pid}/collections/docs/records/..%2FESCAPED_PWN`, pwn.body, undefined, pwn.contentType);
  assert.equal(r1.status, 404, `record tak ada harus 404 (dapat ${r1.status})`);
  assert.equal(fs.existsSync(path.join(STORAGE_DIR, 'ESCAPED_PWN_pwned.txt')), false,
    'TIDAK boleh ada file tertulis di luar folder project (traversal)');

  const deep = multipart([{ name: 'att', filename: 'deep.txt', contentType: 'text/plain', data: 'DEEP' }]);
  const r2 = await req('PATCH', `/api/p/${pid}/collections/docs/records/..%2F..%2FDEEP_PWN`, deep.body, undefined, deep.contentType);
  assert.equal(r2.status, 404);
  assert.equal(fs.existsSync(path.join(SCRATCH, 'DEEP_PWN_deep.txt')), false,
    'TIDAK boleh ada file di luar STORAGE_DIR sama sekali');

  // Kontrol: PATCH multipart pada record ASLI tetap bekerja & file di lokasi sah
  const ok = multipart([{ name: 'att', filename: 'ganti.txt', contentType: 'text/plain', data: 'ganti' }]);
  const r3 = await req('PATCH', `/api/p/${pid}/collections/docs/records/${realRid}`, ok.body, undefined, ok.contentType);
  assert.equal(r3.status, 200, `PATCH normal harus 200 (dapat ${r3.status}: ${JSON.stringify(r3.data)})`);
  const storedPath = path.join(STORAGE_DIR, pid, `${realRid}_${r3.data?.record?.att}`);
  assert.equal(fs.existsSync(storedPath), true, 'file PATCH normal harus tersimpan di dalam folder project');
});

test('AUD-4-01b: PATCH multipart divalidasi SEBELUM menyentuh disk', async () => {
  // rid well-formed tapi tidak ada → 404 TANPA menulis file apa pun
  const before = countProjectFiles();
  const ghost = multipart([{ name: 'att', filename: 'ghost.txt', contentType: 'text/plain', data: 'hantu' }]);
  const r1 = await req('PATCH', `/api/p/${pid}/collections/docs/records/ghostrecord12345`, ghost.body, undefined, ghost.contentType);
  assert.equal(r1.status, 404);
  assert.equal(countProjectFiles(), before, 'multipart tidak boleh diparse/ditulis untuk record yang tidak ada');

  // user B PATCH record priv milik A → 403 SEBELUM file tertulis (bukan orphan setelahnya)
  const r2 = multipart([{ name: 'doc', filename: 'stolen.txt', contentType: 'text/plain', data: 'bukan-milikku' }]);
  const before2 = countProjectFiles();
  const rB = await req('PATCH', `/api/p/${pid}/collections/priv/records/${privRid}`, r2.body, tokenB, r2.contentType);
  assert.equal(rB.status, 403, 'user B harus ditolak updateRule (403)');
  assert.equal(countProjectFiles(), before2, 'tidak boleh ada file orphan tertulis sebelum 403');
});

// ─── AUD-4-02: bucket serve pakai whitelist ekstensi (bukan ct client) ──────

test('AUD-4-02: bucket serve tidak mengeksekusi SVG/HTML aktif (whitelist + nosniff)', async () => {
  // 1) evil.svg + ct client image/svg+xml → HARUS disajikan inert
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  const up1 = multipart([{ name: 'file', filename: 'evil.svg', contentType: 'image/svg+xml', data: svg }]);
  const r1 = await req('POST', `/api/p/${pid}/storage/upload`, up1.body, tokenA, up1.contentType);
  assert.equal(r1.status, 201);
  const s1 = await req('GET', `/api/files/${pid}/bucket/${r1.data.fileId}`);
  assert.equal(s1.status, 200);
  assert.equal(s1.headers['content-type'], 'application/octet-stream',
    `SVG aktif tidak boleh disajikan image/svg+xml (dapat ${s1.headers['content-type']})`);
  assert.ok(String(s1.headers['content-disposition'] ?? '').startsWith('attachment'), 'SVG harus dipaksa download');
  assert.equal(s1.headers['x-content-type-options'], 'nosniff', 'header nosniff wajib ada');

  // 2) innocent.bin + ct client text/html → HARUS inert juga
  const up2 = multipart([{ name: 'file', filename: 'innocent.bin', contentType: 'text/html', data: '<script>alert(1)</script>' }]);
  const r2 = await req('POST', `/api/p/${pid}/storage/upload`, up2.body, tokenA, up2.contentType);
  assert.equal(r2.status, 201);
  const s2 = await req('GET', `/api/files/${pid}/bucket/${r2.data.fileId}`);
  assert.equal(s2.headers['content-type'], 'application/octet-stream',
    `spoof text/html tidak boleh lolos (dapat ${s2.headers['content-type']})`);
  assert.ok(String(s2.headers['content-disposition'] ?? '').startsWith('attachment'));

  // Kontrol: PNG sah tetap disajikan sebagai image/png inline (tidak over-block)
  const up3 = multipart([{ name: 'file', filename: 'safe.png', contentType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }]);
  const r3 = await req('POST', `/api/p/${pid}/storage/upload`, up3.body, tokenA, up3.contentType);
  assert.equal(r3.status, 201);
  const s3 = await req('GET', `/api/files/${pid}/bucket/${r3.data.fileId}`);
  assert.equal(s3.headers['content-type'], 'image/png', 'png tetap image/png');
  assert.ok(String(s3.headers['content-disposition'] ?? '').startsWith('inline'), 'png tetap inline');
  assert.equal(s3.headers['x-content-type-options'], 'nosniff');
});

// ─── AUD-4-03: cache privat untuk file yang digerbang viewRule ──────────────

test('AUD-4-03: file digerbang viewRule → Cache-Control private', async () => {
  const anon = await req('GET', `/api/files/${pid}/priv/${privRid}/${privFile}`);
  assert.equal(anon.status, 404, 'anonim tetap ditolak viewRule');
  const own = await req('GET', `/api/files/${pid}/priv/${privRid}/${privFile}`, undefined, tokenA);
  assert.equal(own.status, 200);
  assert.ok(String(own.headers['cache-control'] ?? '').startsWith('private'),
    `file privat tidak boleh public-cacheable (dapat ${own.headers['cache-control']})`);
  assert.equal(own.headers['x-content-type-options'], 'nosniff');
});

// ─── AUD-4-04: kuota storage per-project ────────────────────────────────────

test('AUD-4-04: kuota per-project dibatasi (bucket + record multipart)', async () => {
  // GET kuota default
  const q0 = await req('GET', `/api/admin/projects/${pid}/storage/quota`, undefined, adminToken);
  assert.equal(q0.status, 200, `route kuota harus ada (dapat ${q0.status})`);
  assert.equal(q0.data.quotaBytes, 1024 * 1024 * 1024, 'default 1 GB');
  assert.ok(q0.data.usageBytes > 0, 'usageBytes terhitung dari storage nyata');

  // set kuota kecil
  const set = await req('PUT', `/api/admin/projects/${pid}/storage/quota`, { quotaBytes: 512 * 1024 }, adminToken);
  assert.equal(set.status, 200);

  // bucket upload 1MB → 413 QUOTA_EXCEEDED
  const big = multipart([{ name: 'file', filename: 'big1.bin', contentType: 'application/octet-stream', data: Buffer.alloc(1024 * 1024, 7) }]);
  const b1 = await req('POST', `/api/p/${pid}/storage/upload`, big.body, tokenA, big.contentType);
  assert.equal(b1.status, 413, `bucket upload melebihi kuota harus 413 (dapat ${b1.status})`);
  assert.equal(b1.data?.error?.code, 'QUOTA_EXCEEDED');

  // record multipart 1MB (per-field maxSize 5MB → kuota yang menolak)
  const rec = multipart([{ name: 'att', filename: 'big2.txt', contentType: 'text/plain', data: Buffer.alloc(1024 * 1024, 7) }]);
  const b2 = await req('POST', `/api/p/${pid}/collections/docs/records`, rec.body, undefined, rec.contentType);
  assert.equal(b2.status, 413, `record multipart melebihi kuota harus 413 (dapat ${b2.status}: ${JSON.stringify(b2.data).slice(0, 120)})`);
  assert.equal(b2.data?.error?.code, 'QUOTA_EXCEEDED');

  // kuota 0 = unlimited → upload kecil lolos kembali
  const set0 = await req('PUT', `/api/admin/projects/${pid}/storage/quota`, { quotaBytes: 0 }, adminToken);
  assert.equal(set0.status, 200);
  const small = multipart([{ name: 'file', filename: 'small.bin', contentType: 'application/octet-stream', data: Buffer.alloc(2048, 1) }]);
  const b3 = await req('POST', `/api/p/${pid}/storage/upload`, small.body, tokenA, small.contentType);
  assert.equal(b3.status, 201, `kuota unlimited harus meloloskan upload (dapat ${b3.status}: ${JSON.stringify(b3.data).slice(0, 120)})`);
});

// ─── AUD-4-05: traversal DELETE admin storage route ─────────────────────────

test('AUD-4-05: admin delete rid traversal tidak menghapus file di luar project', async () => {
  const sentinel = path.join(STORAGE_DIR, 'SENTINEL_x.txt');
  fs.writeFileSync(sentinel, 'sentinel');

  const del = await req('DELETE', `/api/admin/projects/${pid}/storage/files/..%2FSENTINEL/x.txt`, undefined, adminToken);
  assert.ok([200, 400].includes(del.status), `route harus merespons (dapat ${del.status})`);
  assert.equal(fs.existsSync(sentinel), true, 'sentinel DI LUAR folder project TIDAK boleh terhapus');

  // Kontrol: delete file sah masih bekerja
  const delOk = await req('DELETE', `/api/admin/projects/${pid}/storage/files/${realRid}/${encodeURIComponent(realFile)}`, undefined, adminToken);
  assert.equal(delOk.status, 200);
  assert.equal(fs.existsSync(path.join(STORAGE_DIR, pid, `${realRid}_${realFile}`)), false, 'file sah harus terhapus');
  await waitForExists(path.join(STORAGE_DIR, pid), 1); // no-op — folder tetap ada
});
