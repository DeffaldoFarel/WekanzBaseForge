// ============================================================================
// M42: TEST SECRETS STORE — `$env` untuk functions
//
// PROOF:
// 1. Set/list/delete secret lewat Admin API — nilai TIDAK pernah dikembalikan
// 2. $env masuk sandbox & terbaca sebagai string
// 3. $env FROZEN — function tidak bisa menulisnya balik
// 4. Enkripsi at-rest: nilai plaintext TIDAK ada di file DB
// 5. Isolasi per function: secret fn A tidak terlihat fn B
// 6. Key yang tidak diset → undefined (konvensi process.env), bukan error
// 7. Batas dipaksa: format key, >50 secrets ditolak, >8KB ditolak
// 8. Rotasi tanpa ubah kode: PUT ulang key → nilai baru langsung dipakai
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import nodeHttp from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initPlatformDb, closePlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs, getProjectDb } from '../src/core/projectDbManager.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';
import { createProjectAuthRouter } from '../src/api/authRoutes.js';
import { createPublicRouter } from '../src/api/publicRoutes.js';
import { createFunctionRouter } from '../src/api/functionRoutes.js';
import { Router } from '../src/core/router.js';
import { runFunctionCode } from '../src/core/functionRunner.js';
import { setSecret, getSecretsForFunction, encryptSecret } from '../src/core/secretsStore.js';

let server: nodeHttp.Server;
let baseURL = '';
const TEST_DATA_DIR = path.join(os.tmpdir(), `bf-m42-${Date.now()}`);

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
  process.env.JWT_SECRET = 'm42-jwt-secret-for-encryption';

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
  assert.equal(login.status, 200, 'admin login harus 200');
  adminToken = login.data.token;

  const proj = await http('POST', '/api/admin/projects', { name: 'm42' }, adminToken);
  assert.equal(proj.status, 201);
  pid = proj.data.project.id;

  const fn = await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'user_fn', code: 'return typeof $env;'
  }, adminToken);
  assert.equal(fn.status, 201, 'buat function user_fn harus 201');

  const fnB = await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'other_fn', code: 'return 1;'
  }, adminToken);
  assert.equal(fnB.status, 201);
});

after(async () => {
  closeAllProjectDbs();
  // Windows: rmSync gagal EPERM selama handle platform.db masih terbuka.
  closePlatformDb();
  server.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─── 1. Admin API: nilai TIDAK pernah dikembalikan ───────────────────────────

test('M42: set/list/delete via Admin API — nilai TIDAK pernah dikembalikan', async () => {
  const set = await http('PUT', `/api/admin/projects/${pid}/functions/user_fn/secrets`, {
    key: 'STRIPE_KEY', value: 'sk_live_SUPER_SECRET_123',
  }, adminToken);
  assert.equal(set.status, 200, `set secret harus 200, dapat ${set.status}`);
  assert.ok(!JSON.stringify(set.data).includes('sk_live_SUPER_SECRET_123'),
    'response set TIDAK boleh memuat nilai');

  const list = await http('GET', `/api/admin/projects/${pid}/functions/user_fn/secrets`, undefined, adminToken);
  assert.equal(list.status, 200);
  assert.equal(list.data.secrets.length, 1);
  assert.equal(list.data.secrets[0].key, 'STRIPE_KEY');
  assert.equal(list.data.secrets[0].hasValue, true);
  assert.ok(!JSON.stringify(list.data).includes('sk_live_SUPER_SECRET_123'),
    'list TIDAK boleh memuat nilai — hanya metadata');

  const del = await http('DELETE', `/api/admin/projects/${pid}/functions/user_fn/secrets/STRIPE_KEY`, undefined, adminToken);
  assert.equal(del.status, 200);
  const after = await http('GET', `/api/admin/projects/${pid}/functions/user_fn/secrets`, undefined, adminToken);
  assert.equal(after.data.secrets.length, 0, 'secret harus terhapus');
});

// ─── 2. $env masuk sandbox ───────────────────────────────────────────────────

test('M42: $env terbaca di sandbox sebagai string', async () => {
  const db = getProjectDb(pid);
  setSecret(db, 'user_fn', 'STRIPE_KEY', 'sk_live_ABC');

  const result = await runFunctionCode(
    `return { key: $env.STRIPE_KEY, type: typeof $env.STRIPE_KEY };`,
    { secrets: getSecretsForFunction(db, 'user_fn') }
  );
  assert.ok(result.ok, `run gagal: ${result.error}`);
  const r = result.result as { key: string; type: string };
  assert.equal(r.key, 'sk_live_ABC');
  assert.equal(r.type, 'string');
});

// ─── 3. $env FROZEN ──────────────────────────────────────────────────────────

test('M42: $env read-only — function tidak bisa menulisnya balik', async () => {
  const result = await runFunctionCode(
    `'use strict';
     let threw = false;
     try { $env.STRIPE_KEY = 'hacked'; } catch (e) { threw = /read-only/.test(e.message); }
     return { threw: threw, value: $env.STRIPE_KEY };`,
    { secrets: { STRIPE_KEY: 'original' } }
  );
  assert.ok(result.ok, `run gagal: ${result.error}`);
  const r = result.result as { threw: boolean; value: string };
  assert.equal(r.threw, true, 'write ke $env harus melempar read-only');
  assert.equal(r.value, 'original', 'nilai tidak boleh berubah');
});

// ─── 4. Enkripsi at-rest ─────────────────────────────────────────────────────

test('M42: nilai plaintext TIDAK ada di penyimpanan (terenkripsi)', async () => {
  const db = getProjectDb(pid);
  const SECRET = 'sk_live_NEVER_STORED_PLAIN';
  setSecret(db, 'user_fn', 'API_TOKEN', SECRET);

  // Baca mentah dari tabel — harus ciphertext, bukan plaintext
  const row = db
    .prepare(`SELECT value_enc FROM _function_secrets WHERE function_name = 'user_fn' AND key = 'API_TOKEN'`)
    .get() as { value_enc: string };
  assert.ok(row.value_enc.startsWith('v1:'), 'payload harus skema v1');
  assert.ok(!row.value_enc.includes(SECRET), 'plaintext TIDAK boleh muncul di kolom');

  // Seluruh DB di-scan: plaintext tidak boleh muncul di tabel manapun
  const anyRow = db
    .prepare(`SELECT COUNT(*) AS n FROM _function_secrets WHERE value_enc LIKE ?`)
    .get(`%${SECRET}%`) as { n: number };
  assert.equal(anyRow.n, 0, 'plaintext tidak boleh ada di tabel');

  // Round-trip: dekripsi mengembalikan nilai asli
  const got = getSecretsForFunction(db, 'user_fn');
  assert.equal(got.API_TOKEN, SECRET, 'dekripsi harus mengembalikan plaintext asli');
});

// ─── 5. Isolasi per function ─────────────────────────────────────────────────

test('M42: secret function A TIDAK terlihat function B', async () => {
  const db = getProjectDb(pid);
  setSecret(db, 'user_fn', 'PRIVATE_TO_A', 'secret-of-A');

  const secretsB = getSecretsForFunction(db, 'other_fn');
  assert.equal(secretsB.PRIVATE_TO_A, undefined, 'function B tidak boleh melihat secret A');

  const result = await runFunctionCode(
    `return { leaked: $env.PRIVATE_TO_A, has: 'PRIVATE_TO_A' in $env };`,
    { secrets: getSecretsForFunction(db, 'other_fn') }
  );
  assert.ok(result.ok);
  const r = result.result as { leaked: unknown; has: boolean };
  assert.equal(r.has, false, 'key milik A tidak boleh ada di $env B');
  assert.equal(r.leaked, undefined);
});

// ─── 6. Key yang tidak diset → undefined ─────────────────────────────────────

test('M42: key yang tidak diset → undefined (konvensi process.env)', async () => {
  const result = await runFunctionCode(
    `return { missing: $env.DOES_NOT_EXIST, check: $env.DOES_NOT_EXIST === undefined };`,
    { secrets: { EXISTING: 'yes' } }
  );
  assert.ok(result.ok, `run gagal: ${result.error}`);
  const r = result.result as { missing: unknown; check: boolean };
  assert.equal(r.missing, undefined);
  assert.equal(r.check, true, 'key hilang harus undefined, bukan error');
});

// ─── 7. Batas dipaksa ────────────────────────────────────────────────────────

test('M42: batas — format key, maks 50, maks 8KB', async () => {
  const db = getProjectDb(pid);

  // Format key
  for (const bad of ['lowercase', '1START_DIGIT', 'HAS-DASH', 'HAS SPACE', '']) {
    assert.throws(() => setSecret(db, 'user_fn', bad, 'v'), /Invalid secret key/,
      `key '${bad}' harus ditolak`);
  }

  // Maks 50 per function
  for (let i = 0; i < 50; i++) {
    setSecret(db, 'other_fn', `KEY_${i.toString().padStart(2, '0')}`, 'v');
  }
  assert.throws(
    () => setSecret(db, 'other_fn', 'KEY_51', 'v'),
    /at most 50/,
    'secret ke-51 harus ditolak'
  );

  // Maks 8 KB
  const tooBig = 'x'.repeat(8 * 1024 + 1);
  assert.throws(() => setSecret(db, 'user_fn', 'BIG', tooBig), /8 KB|exceeds/i,
    'nilai > 8KB harus ditolak');
});

// ─── 8. Rotasi tanpa ubah kode ───────────────────────────────────────────────

test('M42: rotasi — PUT ulang key mengubah nilai tanpa menyentuh kode', async () => {
  const db = getProjectDb(pid);
  const code = `return $env.WEBHOOK_TOKEN;`;

  setSecret(db, 'user_fn', 'WEBHOOK_TOKEN', 'token-v1');
  const run1 = await runFunctionCode(code, { secrets: getSecretsForFunction(db, 'user_fn') });
  assert.equal(run1.result, 'token-v1');

  // Rotasi: key sama, nilai baru — kode function TIDAK berubah
  setSecret(db, 'user_fn', 'WEBHOOK_TOKEN', 'token-v2');
  const run2 = await runFunctionCode(code, { secrets: getSecretsForFunction(db, 'user_fn') });
  assert.equal(run2.result, 'token-v2', 'nilai baru harus langsung dipakai');
});

// ─── 9. End-to-end via rute execute (invoke publik membawa secrets) ──────────

test('M42: rute execute membawa $env dari store', async () => {
  // Set secret lewat API
  const set = await http('PUT', `/api/admin/projects/${pid}/functions/user_fn/secrets`, {
    key: 'ENDPOINT_SECRET', value: 'from-store',
  }, adminToken);
  assert.equal(set.status, 200);

  // Update kode function untuk membaca secret
  const upd = await http('PATCH', `/api/admin/projects/${pid}/functions/user_fn`, {
    code: 'return { got: $env.ENDPOINT_SECRET, missing: $env.NOPE };'
  }, adminToken);
  assert.equal(upd.status, 200);

  // Execute lewat admin route — secrets harus otomatis didekripsi & disuntik
  const exec = await http('POST', `/api/admin/projects/${pid}/functions/user_fn/execute`, {}, adminToken);
  assert.equal(exec.status, 200, `execute harus 200, dapat ${exec.status}: ${JSON.stringify(exec.data)}`);
  assert.equal(exec.data.result.got, 'from-store', 'rute harus menyuntikkan secret dari store');
  assert.equal(exec.data.result.missing, undefined);
});
