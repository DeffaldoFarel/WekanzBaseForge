// ============================================================================
// M39: TEST CRON TIMEZONE — cronMatchesInTimezone + functionsStore timezone
//
// Fokus test:
//  1. Unit: cronMatchesInTimezone dengan "Asia/Jakarta" (UTC+7)
//  2. Unit: cronMatchesInTimezone dengan "America/New_York" (UTC-5/-4)
//  3. Unit: default UTC (tanpa timezone → cronMatches lama)
//  4. Unit: invalid timezone → throw error
//  5. Store: create function dengan timezone → tersimpan + terbaca kembali
//  6. Store: update timezone → berubah
//  7. Store: default UTC kalau tidak diisi
//  8. Scheduler: cron "0 0 * * *" + "Asia/Jakarta" → fire di 17:00 UTC
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeHttp from 'node:http';
import { initPlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { Router } from '../src/core/router.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';
import { createFunctionRouter } from '../src/api/functionRoutes.js';
import { cronMatches, cronMatchesInTimezone, validateTimezone } from '../src/core/cronParser.js';

const TEST_DATA_DIR = path.resolve('../data/m39-tz-test');

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
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let data: any = {};
          try { data = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'); } catch {}
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
  process.env.ADMIN_EMAIL = 'admin@m39.test';
  process.env.ADMIN_PASSWORD = 'm39-secret-pass';
  process.env.JWT_SECRET = 'm39-test-jwt-secret-key-short';
  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());
  router.merge(createFunctionRouter());

  server = nodeHttp.createServer((rq, rs) => router.handle(rq, rs));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@m39.test',
    password: 'm39-secret-pass',
  });
  adminToken = login.data.token;

  const proj = await http('POST', '/api/admin/projects', { name: 'm39-tz' }, adminToken);
  projectId = proj.data.project.id;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  closeAllProjectDbs();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─── 1-3: Unit tests ─────────────────────────────────────────────────────────

test('unit: Asia/Jakarta (UTC+7) — cron "0 0 * * *" matches di 17:00 UTC', () => {
  // Cron: midnight (00:00) setiap hari dalam Asia/Jakarta
  // 00:00 Jakarta = 17:00 UTC (hari sebelumnya)
  const expr = '0 0 * * *';

  // 17:00 UTC = midnight Jakarta → SHOULD match
  const utc17 = new Date('2026-01-15T17:00:00Z');
  assert.ok(cronMatchesInTimezone(expr, utc17, 'Asia/Jakarta'), '17:00 UTC = 00:00 Jakarta → match');

  // 00:00 UTC = 07:00 Jakarta → should NOT match
  const utc00 = new Date('2026-01-15T00:00:00Z');
  assert.ok(!cronMatchesInTimezone(expr, utc00, 'Asia/Jakarta'), '00:00 UTC = 07:00 Jakarta → no match');
});

test('unit: America/New_York (UTC-5 winter) — cron "0 12 * * *" matches di 17:00 UTC', () => {
  // Cron: noon (12:00) setiap hari dalam America/New_York
  // 12:00 NY (EST=UTC-5) = 17:00 UTC
  const expr = '0 12 * * *';

  // January = winter = EST = UTC-5
  const utc17Jan = new Date('2026-01-15T17:00:00Z');
  assert.ok(cronMatchesInTimezone(expr, utc17Jan, 'America/New_York'), '17:00 UTC = 12:00 EST → match');

  const utc12Jan = new Date('2026-01-15T12:00:00Z');
  assert.ok(!cronMatchesInTimezone(expr, utc12Jan, 'America/New_York'), '12:00 UTC = 07:00 EST → no match');
});

test('unit: default UTC — cronMatchesInTimezone(expr, date, "UTC") works correctly', () => {
  const expr = '0 0 * * *';

  // 00:00 UTC → match with UTC timezone
  const utc00 = new Date('2026-01-15T00:00:00Z');
  assert.ok(cronMatchesInTimezone(expr, utc00, 'UTC'), 'UTC explicit → match at 00:00 UTC');
  assert.ok(cronMatchesInTimezone(expr, utc00), 'UTC default (no arg) → match at 00:00 UTC');

  // 23:59 UTC → NOT match (not midnight)
  const utc2359 = new Date('2026-01-15T23:59:00Z');
  assert.ok(!cronMatchesInTimezone(expr, utc2359), 'UTC → no match at 23:59 UTC');
});

test('unit: invalid timezone → throw error', () => {
  assert.throws(() => validateTimezone('Not/Real/Zone'), /Unknown timezone/);
  assert.throws(() => validateTimezone('Invalid!Name'), /Invalid timezone format/);
  // Valid ones should NOT throw
  validateTimezone('Asia/Jakarta');
  validateTimezone('America/New_York');
  validateTimezone('UTC');
  validateTimezone('Europe/London');
});

// ─── 5-7: Store tests via HTTP ──────────────────────────────────────────────

test('store: create function dengan timezone → tersimpan + terbaca', async () => {
  const fn = await http(
    'POST',
    `/api/admin/projects/${projectId}/functions`,
    {
      name: 'tz_test_fn',
      code: 'return { ok: true, tz: req.scheduled ? "scheduled" : "callable" };',
      schedule: '5 0 * * *',
      timezone: 'Asia/Jakarta',
      enabled: true,
    },
    adminToken
  );
  assert.equal(fn.status, 201, JSON.stringify(fn.data));
  assert.equal(fn.data.function.timezone, 'Asia/Jakarta');
  assert.equal(fn.data.function.schedule, '5 0 * * *');
});

test('store: update timezone → berubah', async () => {
  const update = await http(
    'PATCH',
    `/api/admin/projects/${projectId}/functions/tz_test_fn`,
    { timezone: 'Europe/London' },
    adminToken
  );
  assert.equal(update.status, 200, JSON.stringify(update.data));
  assert.equal(update.data.function.timezone, 'Europe/London');
});

test('store: default UTC kalau tidak diisi', async () => {
  const fn = await http(
    'POST',
    `/api/admin/projects/${projectId}/functions`,
    {
      name: 'tz_default_fn',
      code: 'return { ok: true };',
      schedule: '0 0 * * *',
    },
    adminToken
  );
  assert.equal(fn.status, 201);
  assert.equal(fn.data.function.timezone, 'UTC');
});

test('store: invalid timezone → 400 dengan pesan jelas', async () => {
  const fn = await http(
    'POST',
    `/api/admin/projects/${projectId}/functions`,
    {
      name: 'tz_bad_fn',
      code: 'return { ok: true };',
      schedule: '0 0 * * *',
      timezone: 'Invalid/Zone',
    },
    adminToken
  );
  assert.equal(fn.status, 400);
  assert.match(fn.data.error.message, /timezone/i);
});
