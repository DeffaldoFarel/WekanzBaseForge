// ============================================================================
// M32: TEST SCHEDULED BACKUP — config CRUD, VACUUM INTO, retensi, download
//
// Fokus test:
//  1. Config CRUD: default off → set daily → get → delete → reset
//  2. Backup manual: POST /backup/run → file .db dibuat + metadata .json
//  3. Backup integrity: file .db bisa dibuka independen (data sama)
//  4. List backups: menampilkan metadata (size, duration, counts)
//  5. Retensi: buat 5 backup dengan retention=3 → hanya 3 tersisa
//  6. Download: GET /backup/download/:filename → Content-Type + size benar
//  7. Path traversal: download ../../etc/passwd → 404
//  8. Schedule validation: invalid schedule → default off
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import nodeHttp from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { initPlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { Router } from '../src/core/router.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';
import { createPublicRouter } from '../src/api/publicRoutes.js';
import { createBackupRouter } from '../src/api/backupRoutes.js';

const TEST_DATA_DIR = path.resolve('../data/m32-backup-test');

let server: nodeHttp.Server;
let baseURL: string;
let adminToken: string;
let projectId: string;

function http(
  method: string,
  p: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; data: any; headers: Record<string, string> }> {
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
          let data: any = {};
          try { data = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'); } catch {}
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
          }
          resolve({ status: res.statusCode ?? 0, data, headers });
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
  process.env.BACKUP_DIR = path.join(TEST_DATA_DIR, 'backups');
  process.env.ADMIN_EMAIL = 'admin@m32.test';
  process.env.ADMIN_PASSWORD = 'm32-secret-pass';
  process.env.JWT_SECRET = 'm32-test-jwt-secret-key-long-enough';
  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());
  router.merge(createPublicRouter()); // diperlukan untuk POST records
  router.merge(createBackupRouter());

  server = nodeHttp.createServer((rq, rs) => router.handle(rq, rs));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@m32.test',
    password: 'm32-secret-pass',
  });
  adminToken = login.data.token;

  const proj = await http('POST', '/api/admin/projects', { name: 'm32-backup' }, adminToken);
  projectId = proj.data.project.id;

  // Collection + data untuk backup test (rules publik agar anonymous POST bekerja)
  const col = await http(
    'POST',
    `/api/admin/projects/${projectId}/collections`,
    { name: 'items', fields: [{ name: 'title', type: 'text' }], rules: { listRule: '', viewRule: '', createRule: '' } },
    adminToken
  );
  assert.equal(col.status, 201);

  for (let i = 1; i <= 3; i++) {
    await http('POST', `/api/p/${projectId}/collections/items/records`, { title: `item ${i}` });
  }
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  closeAllProjectDbs();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─── 1. Config CRUD ──────────────────────────────────────────────────────────

test('config: default off → set daily → get → delete → reset', async () => {
  // Default: off
  const default1 = await http('GET', `/api/admin/projects/${projectId}/backup/config`, undefined, adminToken);
  assert.equal(default1.status, 200);
  assert.equal(default1.data.schedule, 'off');
  assert.equal(default1.data.retention, 7);

  // Set daily + retention 3
  const set = await http(
    'PUT',
    `/api/admin/projects/${projectId}/backup/config`,
    { schedule: 'daily', retention: 3 },
    adminToken
  );
  assert.equal(set.status, 200);
  assert.equal(set.data.schedule, 'daily');
  assert.equal(set.data.retention, 3);

  // Get: config tersimpan
  const get = await http('GET', `/api/admin/projects/${projectId}/backup/config`, undefined, adminToken);
  assert.equal(get.data.schedule, 'daily');
  assert.equal(get.data.retention, 3);

  // Delete: reset ke default
  const del = await http('DELETE', `/api/admin/projects/${projectId}/backup/config`, undefined, adminToken);
  assert.equal(del.status, 200);
  const after = await http('GET', `/api/admin/projects/${projectId}/backup/config`, undefined, adminToken);
  assert.equal(after.data.schedule, 'off');
});

test('config: schedule invalid → default off; retention clamped 1-30', async () => {
  const set = await http(
    'PUT',
    `/api/admin/projects/${projectId}/backup/config`,
    { schedule: 'hourly', retention: 100 },
    adminToken
  );
  assert.equal(set.status, 200);
  assert.equal(set.data.schedule, 'off', 'invalid → off');
  assert.equal(set.data.retention, 30, 'clamped ke 30');
});

// ─── 2. Backup manual ─────────────────────────────────────────────────────────

test('backup manual: POST /backup/run → file .db + metadata .json', async () => {
  const run = await http('POST', `/api/admin/projects/${projectId}/backup/run`, {}, adminToken);
  assert.equal(run.status, 201, JSON.stringify(run.data));
  assert.ok(run.data.backup.filename.endsWith('.db'));
  assert.ok(run.data.backup.size > 0);
  assert.ok(run.data.backup.durationMs >= 0);
  assert.equal(run.data.backup.collectionCount, 1); // items
  assert.equal(run.data.backup.recordCount, 3); // 3 items

  // File fisik ada di disk
  const backupDir = path.join(process.env.BACKUP_DIR!, projectId);
  assert.ok(fs.existsSync(path.join(backupDir, run.data.backup.filename)), 'file .db ada');
  assert.ok(fs.existsSync(path.join(backupDir, run.data.backup.filename.replace('.db', '.json'))), 'file .json ada');
});

// ─── 3. Backup integrity ─────────────────────────────────────────────────────

test('backup integrity: file .db bisa dibuka independen dengan data sama', async () => {
  const run = await http('POST', `/api/admin/projects/${projectId}/backup/run`, {}, adminToken);
  assert.equal(run.status, 201);

  const backupDir = path.join(process.env.BACKUP_DIR!, projectId);
  const backupPath = path.join(backupDir, run.data.backup.filename);

  // Buka backup sebagai database baru (TANPA WAL file — self-contained)
  const backupDb = new DatabaseSync(backupPath, { readOnly: true });
  const items = backupDb.prepare('SELECT * FROM items ORDER BY title').all() as { title: string }[];
  assert.equal(items.length, 3);
  assert.equal(items[0].title, 'item 1');
  assert.equal(items[2].title, 'item 3');
  backupDb.close();
});

// ─── 4. List backups ─────────────────────────────────────────────────────────

test('list: menampilkan metadata backup', async () => {
  const list = await http('GET', `/api/admin/projects/${projectId}/backup/list`, undefined, adminToken);
  assert.equal(list.status, 200);
  assert.ok(list.data.backups.length >= 2, 'minimal 2 backup dari test sebelumnya');
  assert.ok(list.data.totalSize > 0);
  assert.equal(list.data.config.schedule, 'off', 'config direset dari test 1');
  for (const b of list.data.backups) {
    assert.ok(b.filename.endsWith('.db'));
    assert.ok(b.size > 0);
    assert.ok(b.timestamp);
  }
});

// ─── 5. Retensi ───────────────────────────────────────────────────────────────

test('retensi: retention=3 → hanya 3 backup tersisa setelah buat 5', async () => {
  // Set retention ke 3
  await http(
    'PUT',
    `/api/admin/projects/${projectId}/backup/config`,
    { schedule: 'off', retention: 3 },
    adminToken
  );

  // Buat 5 backup
  for (let i = 0; i < 5; i++) {
    await http('POST', `/api/admin/projects/${projectId}/backup/run`, {}, adminToken);
  }

  // List: harus tepat 3 (retention menghapus yang lama)
  const list = await http('GET', `/api/admin/projects/${projectId}/backup/list`, undefined, adminToken);
  assert.equal(list.data.backups.length, 3, `expected 3, got ${list.data.backups.length}`);
  assert.equal(list.data.config.retention, 3);
});

// ─── 6. Download ─────────────────────────────────────────────────────────────

test('download: Content-Type + Content-Disposition + size benar', async () => {
  const list = await http('GET', `/api/admin/projects/${projectId}/backup/list`, undefined, adminToken);
  const latest = list.data.backups[0];

  const dl = await new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
    const req = nodeHttp.request(
      new URL(`/api/admin/projects/${projectId}/backup/download/${latest.filename}`, baseURL),
      { headers: { Authorization: `Bearer ${adminToken}` } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
          }
          resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks) });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });

  assert.equal(dl.status, 200);
  assert.equal(dl.headers['content-type'], 'application/x-sqlite3');
  assert.ok(dl.headers['content-disposition']?.includes('attachment'));
  assert.equal(dl.body.length, latest.size, 'body size = metadata size');
});

// ─── 7. Path traversal ───────────────────────────────────────────────────────

test('download: path traversal → 404', async () => {
  const dl = await http('GET', `/api/admin/projects/${projectId}/backup/download/..%2F..%2F..%2Fetc%2Fpasswd`, undefined, adminToken);
  assert.ok([404, 400].includes(dl.status), `expected 404/400, got ${dl.status}`);
});

// ─── 8. Auth guard ───────────────────────────────────────────────────────────

test('backup endpoints: tanpa admin token → 401', async () => {
  const endpoints = [
    ['GET', `/api/admin/projects/${projectId}/backup/config`],
    ['GET', `/api/admin/projects/${projectId}/backup/list`],
    ['POST', `/api/admin/projects/${projectId}/backup/run`],
  ];
  for (const [method, p] of endpoints) {
    const r = await http(method as string, p);
    assert.equal(r.status, 401, `${method} ${p} harus 401`);
  }
});
