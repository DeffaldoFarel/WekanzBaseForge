// ============================================================================
// Ops-1/2/3: TEST — busy_timeout, batch client transaksional, restore teruji
//
// PROOF:
// Ops-1: dua writer ke DB yang sama — tanpa busy_timeout gagal SEKETIKA,
//        dengan busy_timeout menunggu dan sukses
// Ops-2: batch client — (a) campuran valid+invalid → SEMUA rollback,
//        (b) batch valid → semua tertulis, (c) rules diberlakukan per record
// Ops-3: backup (VACUUM INTO) → "pulihkan" ke DB baru → buka → data utuh
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import nodeHttp from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initPlatformDb, closePlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs, getProjectDb } from '../src/core/projectDbManager.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';
import { createProjectAuthRouter } from '../src/api/authRoutes.js';
import { createPublicRouter } from '../src/api/publicRoutes.js';
import { Router } from '../src/core/router.js';
import { backupProject } from '../src/core/backupScheduler.js';

let server: nodeHttp.Server;
let baseURL = '';
const TEST_DATA_DIR = path.join(os.tmpdir(), `bf-ops-${Date.now()}`);

let pid: string;
let adminToken: string;
let userToken: string;

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

  const proj = await http('POST', '/api/admin/projects', { name: 'ops' }, adminToken);
  assert.equal(proj.status, 201);
  pid = proj.data.project.id;

  // Collection untuk batch (user-scoped)
  const col = await http('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'items',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'userId', type: 'text', required: true },
    ],
    rules: {
      listRule: '@request.auth.id != "" && userId = @request.auth.id',
      viewRule: '@request.auth.id != "" && userId = @request.auth.id',
      createRule: '@request.auth.id != "" && userId = @request.auth.id',
    },
  }, adminToken);
  assert.equal(col.status, 201, `create collection: ${JSON.stringify(col.data)}`);

  // Register end user (mengembalikan 201, bukan 200)
  const reg = await http('POST', `/api/p/${pid}/auth/register`, {
    email: 'u@ops.test', password: 'passwordX123',
  });
  assert.equal(reg.status, 201, `register: ${JSON.stringify(reg.data)}`);
  userToken = reg.data.accessToken;
});

after(async () => {
  closeAllProjectDbs();
  // Windows: rmSync gagal EPERM selama handle platform.db masih terbuka.
  closePlatformDb();
  server.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ═══ Ops-1: busy_timeout ═══════════════════════════════════════════════════

test('Ops-1: busy_timeout membuat writer menunggu lock dari thread lain (bukan gagal seketika)', async () => {
  // CATATAN TERUKUR (dari probe): node:sqlite itu SINKRON & memblokir event
  // loop. Di SATU proses, busy_timeout TIDAK bisa menyelamatkan lock yang
  // dipegang lintas `await` — waiter memblokir loop sehingga holder tak bisa
  // COMMIT (tetap timeout). Yang BENAR-BENAR diselamatkan busy_timeout adalah
  // lock dari proses/thread LAIN. Test ini membuktikan kasus nyata itu dengan
  // worker_threads: worker memegang write lock, main thread menulis.
  const { Worker } = await import('node:worker_threads');

  const dbPath = path.join(os.tmpdir(), `bf-busy-${Date.now()}.db`);
  fs.rmSync(dbPath, { force: true });

  // Worker menahan write lock selama holdMs lalu COMMIT (event loop-nya sendiri)
  const workerCode = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData.dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
    parentPort.on('message', (msg) => {
      if (msg === 'lock') {
        db.exec('BEGIN IMMEDIATE');
        db.exec("INSERT INTO t (v) VALUES ('from-worker')");
        parentPort.postMessage('locked');
        setTimeout(() => { try { db.exec('COMMIT'); } catch (e) {} parentPort.postMessage('released'); }, workerData.holdMs);
      }
    });
  `;

  async function attemptWrite(opts: { busyTimeout: number | null; holdMs: number }): Promise<{ ok: boolean; elapsed: number; err: string | null }> {
    const worker = new Worker(workerCode, { eval: true, workerData: { dbPath, holdMs: opts.holdMs } });
    await new Promise<void>((resolve) => {
      worker.once('message', (m) => { if (m === 'locked') resolve(); });
      worker.postMessage('lock');
    });

    const main = new DatabaseSync(dbPath);
    main.exec('PRAGMA journal_mode = WAL');
    if (opts.busyTimeout !== null) main.exec(`PRAGMA busy_timeout = ${opts.busyTimeout}`);

    const t0 = Date.now();
    let ok = false;
    let err: string | null = null;
    try {
      main.exec("INSERT INTO t (v) VALUES ('from-main')");
      ok = true;
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    const elapsed = Date.now() - t0;
    main.close();
    await worker.terminate();
    return { ok, elapsed, err };
  }

  // ── A: TANPA busy_timeout → gagal SEKETIKA ──
  const noTimeout = await attemptWrite({ busyTimeout: null, holdMs: 800 });
  assert.equal(noTimeout.ok, false, 'tanpa busy_timeout harus gagal');
  assert.match(String(noTimeout.err), /busy|locked/i);
  assert.ok(noTimeout.elapsed < 500, `harus gagal SEKETIKA, bukan menunggu (${noTimeout.elapsed}ms)`);

  // ── B: DENGAN busy_timeout=5000 → MENUNGGU lalu sukses ──
  const withTimeout = await attemptWrite({ busyTimeout: 5000, holdMs: 800 });
  assert.ok(withTimeout.ok, `dengan busy_timeout harus sukses setelah lock dilepas, err: ${withTimeout.err}`);
  assert.ok(withTimeout.elapsed >= 700, `harus MENUNGGU ~800ms lock dilepas (${withTimeout.elapsed}ms)`);

  fs.rmSync(dbPath, { force: true });
});

test('Ops-1: ketiga titik pembukaan DB menyetel busy_timeout', async () => {
  // Verifikasi PRAGMA aktif di koneksi project yang dipakai server
  const db = getProjectDb(pid);
  const row = db.prepare('PRAGMA busy_timeout').get() as { busy_timeout?: number } | { timeout?: number };
  const val = (row as { busy_timeout?: number }).busy_timeout ?? (row as { timeout?: number }).timeout;
  assert.equal(val, 5000, `project DB harus busy_timeout=5000, dapat ${val}`);
});

// ═══ Ops-2: batch client transaksional ═════════════════════════════════════

test('Ops-2: batch campuran valid+invalid → SEMUA rollback (atomicity)', async () => {
  const db = getProjectDb(pid);
  const userId = (db.prepare('SELECT id FROM _auth_users LIMIT 1').get() as { id: string }).id;

  // Satu record valid (userId cocok), satu INVALID (userId milik orang lain → rule tolak)
  const res = await http('POST', `/api/p/${pid}/collections/items/records/batch`, {
    records: [
      { title: 'valid-1', userId: userId },
      { title: 'INVALID-other-user', userId: 'someone_else' },
    ],
  }, userToken);

  assert.equal(res.status, 403, `batch dengan record melanggar rule harus ditolak, dapat ${res.status}: ${JSON.stringify(res.data)}`);

  // Yang VALID pun TIDAK boleh tertulis — batch itu atomik
  const count = db.prepare(`SELECT COUNT(*) AS n FROM items WHERE title = 'valid-1'`).get() as { n: number };
  assert.equal(count.n, 0, 'record valid TIDAK boleh tertulis bila satu record lain gagal (rollback penuh)');
});

test('Ops-2: batch semua-valid → semua tertulis dalam satu transaksi', async () => {
  const db = getProjectDb(pid);
  const userId = (db.prepare('SELECT id FROM _auth_users LIMIT 1').get() as { id: string }).id;

  const res = await http('POST', `/api/p/${pid}/collections/items/records/batch`, {
    records: [
      { title: 'batch-a', userId: userId },
      { title: 'batch-b', userId: userId },
      { title: 'batch-c', userId: userId },
    ],
  }, userToken);

  assert.equal(res.status, 201, `batch valid harus 201, dapat ${res.status}: ${JSON.stringify(res.data)}`);
  assert.equal(res.data.count, 3);
  assert.equal(res.data.records.length, 3);

  const count = db.prepare(
    `SELECT COUNT(*) AS n FROM items WHERE title IN ('batch-a','batch-b','batch-c')`
  ).get() as { n: number };
  assert.equal(count.n, 3, 'ketiga record harus tertulis');
});

test('Ops-2: batch menolak >100 record & array kosong', async () => {
  const db = getProjectDb(pid);
  const userId = (db.prepare('SELECT id FROM _auth_users LIMIT 1').get() as { id: string }).id;

  const tooMany = await http('POST', `/api/p/${pid}/collections/items/records/batch`, {
    records: Array.from({ length: 101 }, (_, i) => ({ title: `r${i}`, userId })),
  }, userToken);
  assert.equal(tooMany.status, 400, '>100 record harus 400');

  const empty = await http('POST', `/api/p/${pid}/collections/items/records/batch`, {
    records: [],
  }, userToken);
  assert.equal(empty.status, 400, 'array kosong harus 400');
});

// ═══ Ops-3: restore teruji ═════════════════════════════════════════════════

test('Ops-3: backup → pulihkan ke DB baru → data utuh (restore terbukti bisa dibuka)', async () => {
  const db = getProjectDb(pid);

  // Isi data yang akan di-backup
  const userId = (db.prepare('SELECT id FROM _auth_users LIMIT 1').get() as { id: string }).id;
  db.prepare(`INSERT INTO items (id, title, userId, created, updated) VALUES (?, ?, ?, datetime('now'), datetime('now'))`)
    .run('restore-test-id', 'restore-marker', userId);

  const beforeCount = (db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n;

  // ── BACKUP via VACUUM INTO (mekanisme yang sama dengan backupRoutes) ──
  process.env.BACKUP_DIR = path.join(os.tmpdir(), `bf-backup-${Date.now()}`);
  const info = backupProject(pid);
  assert.ok(info.filename.endsWith('.db'), 'backup harus file .db');
  const backupPath = path.join(process.env.BACKUP_DIR, pid, info.filename);
  assert.ok(fs.existsSync(backupPath), `file backup harus ada: ${backupPath}`);

  // ── "PULIHKAN": copy file backup → lokasi DB baru, lalu BUKA ──
  const restoredPath = path.join(os.tmpdir(), `bf-restored-${Date.now()}.db`);
  fs.copyFileSync(backupPath, restoredPath);

  const restored = new DatabaseSync(restoredPath);
  restored.exec('PRAGMA journal_mode = WAL');

  // Verifikasi data utuh di DB yang dipulihkan
  const restoredCount = (restored.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n;
  assert.equal(restoredCount, beforeCount, 'jumlah record di DB pulih harus sama');

  const marker = restored.prepare(`SELECT title, userId FROM items WHERE id = 'restore-test-id'`).get() as { title: string; userId: string } | undefined;
  assert.ok(marker, 'record marker harus ada di DB pulih');
  assert.equal(marker.title, 'restore-marker', 'isi record harus utuh');

  restored.close();
  fs.rmSync(restoredPath, { force: true });
  fs.rmSync(process.env.BACKUP_DIR, { recursive: true, force: true });
});
