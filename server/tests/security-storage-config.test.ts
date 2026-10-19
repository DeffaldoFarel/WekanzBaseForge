// ============================================================================
// SECURITY: S3 storage config at-rest — temuan audit FASE 0 (2026-10)
//
// AUD-0-04 — secretAccessKey disimpan PLAINTEXT di platform.db:
//   saveStorageConfig menulis JSON konfigurasi storage ke tabel
//   _platform_settings dengan secretAccessKey apa adanya (TODO lama:
//   "encrypt at-rest"). Backup data/ atau dump SQLite membocorkan credential
//   S3/R2. Kini: secret disimpan terenkripsi (secretAccessKeyEnc, skema
//   AES-256-GCM secretsStore — sama dengan $env/MFA/mailer), payload legacy
//   plaintext tetap terbaca, dan resolveConfig mendekripsi hanya untuk
//   runtime adapter (tidak pernah dikembalikan ke API).
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import nodeHttp from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { initPlatformDb, closePlatformDb, getPlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs } from '../src/core/projectDbManager.js';
import {
  saveStorageConfig,
  getStorageAdapter,
  resetStorageAdapter,
} from '../src/core/storageAdapter.js';
import type { S3Config } from '../src/core/s3.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createStorageAdminRouter } from '../src/api/storageAdminRoutes.js';
import { Router } from '../src/core/router.js';

let server: nodeHttp.Server;
let baseURL = '';
const TEST_DATA_DIR = path.resolve('../data/sec-storage-cfg-test');

let adminToken: string;

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
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function storedStorageRow(): { value: string } {
  const db = getPlatformDb();
  return db.prepare("SELECT value FROM _platform_settings WHERE key = 'storage'").get() as { value: string };
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
  router.merge(createStorageAdminRouter());

  server = nodeHttp.createServer((req, res) => { router.handle(req, res); });
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      baseURL = `http://localhost:${addr.port}`;
      resolve();
    });
  });

  const login = await http('POST', '/api/admin/auth/login', { email: 'admin@test.local', password: 'admin-test-pass' });
  adminToken = login.data.token;
});

after(async () => {
  closeAllProjectDbs();
  closePlatformDb();
  server.close();
  resetStorageAdapter();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test('AUD-0-04: saveStorageConfig menyimpan secretAccessKey TERENKRIPSI, bukan plaintext', () => {
  saveStorageConfig({
    backend: 's3',
    s3: {
      endpoint: 'https://s3.example',
      region: 'us-east-1',
      bucket: 'sec-bkt',
      accessKeyId: 'AKIASECEXAMPLE',
      secretAccessKey: 'SUPER-SECRET-KEY-123',
      prefix: 'p',
    },
  });

  const row = storedStorageRow();
  const stored = JSON.parse(row.value);

  assert.equal(stored.backend, 's3');
  assert.equal(stored.s3.accessKeyId, 'AKIASECEXAMPLE', 'accessKeyId boleh plaintext (setengah-publik)');
  assert.ok(
    typeof stored.s3.secretAccessKeyEnc === 'string' && stored.s3.secretAccessKeyEnc.startsWith('v1:'),
    'secret harus tersimpan sebagai ciphertext v1:...'
  );
  assert.ok(!('secretAccessKey' in stored.s3), 'plaintext secretAccessKey TIDAK boleh ada di DB');
  assert.ok(
    !stored.s3.secretAccessKeyEnc.includes('SUPER-SECRET-KEY-123'),
    'ciphertext tidak boleh mengandung plaintext'
  );
});

test('AUD-0-04: resolveConfig mendekripsi kembali untuk runtime adapter (tanpa bocor ciphertext)', () => {
  // saveStorageConfig dari test sebelumnya sudah reset cache adapter internal
  const adapter = getStorageAdapter();
  assert.equal(adapter.backend, 's3');
  const cfg = (adapter as unknown as { config: S3Config }).config;
  assert.equal(cfg.secretAccessKey, 'SUPER-SECRET-KEY-123', 'runtime harus dapat plaintext hasil decrypt');
  assert.equal(cfg.accessKeyId, 'AKIASECEXAMPLE');
  assert.ok(!('secretAccessKeyEnc' in cfg), 'ciphertext tidak boleh bocor ke runtime config');
});

test('AUD-0-04: payload LEGACY (plaintext) tetap terbaca — migrasi saat admin save ulang', () => {
  // Simulasi platform.db lama: secretAccessKey plaintext TANPA secretAccessKeyEnc
  const db = getPlatformDb();
  const legacy = JSON.stringify({
    backend: 's3',
    s3: {
      endpoint: 'https://legacy.example',
      region: 'us-east-1',
      bucket: 'legacy-bkt',
      accessKeyId: 'LEGACYAKIA',
      secretAccessKey: 'legacy-plain-secret',
    },
  });
  db.prepare(
    `INSERT INTO _platform_settings (key, value) VALUES ('storage', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(legacy);

  resetStorageAdapter();
  const adapter = getStorageAdapter();
  assert.equal(adapter.backend, 's3', 'legacy plaintext config tetap dipakai');
  const cfg = (adapter as unknown as { config: S3Config }).config;
  assert.equal(cfg.secretAccessKey, 'legacy-plain-secret');
  assert.equal(cfg.endpoint, 'https://legacy.example');
});

test('AUD-0-04 (E2E): PUT /settings/storage → DB tanpa plaintext, GET info tetap masked', async () => {
  const put = await http('PUT', '/api/admin/settings/storage', {
    backend: 's3',
    s3: {
      endpoint: 'https://e2e.example',
      region: 'us-east-1',
      bucket: 'e2e-bkt',
      accessKeyId: 'E2EAKIA',
      secretAccessKey: 'e2e-very-secret-value',
      prefix: '',
    },
  }, adminToken);
  assert.equal(put.status, 200, JSON.stringify(put.data));

  const row = storedStorageRow();
  assert.ok(!row.value.includes('e2e-very-secret-value'), 'platform.db TIDAK boleh berisi plaintext secret');

  const info = await http('GET', '/api/admin/settings/storage', undefined, adminToken);
  assert.equal(info.status, 200, JSON.stringify(info.data));
  const text = JSON.stringify(info.data).toLowerCase();
  assert.ok(!text.includes('e2e-very-secret-value'), 'GET info tidak boleh membocorkan secret');
  assert.ok(!text.includes('secretaccesskey'), 'field secret tidak boleh muncul sama sekali');
  assert.equal(info.data.s3.hasCredentials, true);
  assert.equal(info.data.s3.bucket, 'e2e-bkt');

  // Adapter runtime tetap dapat plaintext hasil decrypt
  const adapter = getStorageAdapter();
  const cfg = (adapter as unknown as { config: S3Config }).config;
  assert.equal(cfg.secretAccessKey, 'e2e-very-secret-value');
});
