// ============================================================================
// M33: TEST MONITORING/ALERTING — config CRUD, alert lifecycle, webhook
//
// Fokus test:
//  1. Config CRUD: default off → enable → update rules → get
//  2. Test alert: POST /alerts/test → alert firing dibuat + metadata benar
//  3. Alert list: GET /alerts → menampilkan firing + resolved
//  4. Acknowledge: POST /alerts/:id/acknowledge → acknowledged = true
//  5. Force check: POST /monitoring/check → mengevaluasi rules
//  6. Rule update: PUT threshold → config tersimpan
//  7. Webhook: alert dikirim ke mock webhook receiver
//  8. Cooldown: alert yang sama tidak re-trigger dalam cooldown window
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
import { createMonitorRouter } from '../src/api/monitorRoutes.js';

const TEST_DATA_DIR = path.resolve('../data/m33-monitor-test');

let server: nodeHttp.Server;
let baseURL: string;
let adminToken: string;

// Mock webhook receiver
let webhookServer: nodeHttp.Server;
let webhookPort: number;
let webhookReceived: Array<{ headers: Record<string, string>; body: string }> = [];

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
  process.env.ADMIN_EMAIL = 'admin@m33.test';
  process.env.ADMIN_PASSWORD = 'm33-secret-pass';
  process.env.JWT_SECRET = 'm33-test-jwt-secret-key-long-enough';
  initPlatformDb();

  // Reset monitoring config + clear alerts (platform.db mungkin punya state dari run sebelumnya)
  const { setAlertConfig, getAlertConfig } = await import('../src/core/monitor.js');
  const config = getAlertConfig();
  setAlertConfig({ enabled: false, webhookUrl: null, rules: config.rules });
  // Clear semua alert dari tabel
  const { getPlatformDb } = await import('../src/core/platformDb.js');
  const db = getPlatformDb();
  db.exec('DELETE FROM _alerts');

  // Mock webhook receiver
  webhookServer = nodeHttp.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
      }
      webhookReceived.push({ headers, body });
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise<void>((r) => webhookServer.listen(0, '127.0.0.1', r));
  webhookPort = (webhookServer.address() as { port: number }).port;

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createMonitorRouter());

  server = nodeHttp.createServer((rq, rs) => router.handle(rq, rs));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@m33.test',
    password: 'm33-secret-pass',
  });
  adminToken = login.data.token;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => webhookServer.close(() => r()));
  closeAllProjectDbs();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─── 1. Config CRUD ──────────────────────────────────────────────────────────

test('config: default off → enable dengan webhook → rules terlihat', async () => {
  const default1 = await http('GET', '/api/admin/settings/monitoring', undefined, adminToken);
  assert.equal(default1.status, 200);
  assert.equal(default1.data.enabled, false, 'default off');
  assert.equal(default1.data.rules.length, 4, '4 default rules');
  assert.equal(default1.data.stats.totalAlerts, 0);

  // Enable + set webhook
  const enable = await http(
    'PUT',
    '/api/admin/settings/monitoring',
    { enabled: true, webhookUrl: `http://127.0.0.1:${webhookPort}/alert` },
    adminToken
  );
  assert.equal(enable.status, 200);
  assert.equal(enable.data.enabled, true);
  assert.ok(enable.data.webhookUrl?.includes('127.0.0.1'));
  assert.match(enable.data.message, /enabled/i);

  // Get: config tersimpan
  const get = await http('GET', '/api/admin/settings/monitoring', undefined, adminToken);
  assert.equal(get.data.enabled, true);
  assert.equal(get.data.webhookUrl, `http://127.0.0.1:${webhookPort}/alert`);
});

// ─── 2. Test alert ───────────────────────────────────────────────────────────

test('test alert: POST /alerts/test → alert firing + metadata benar + webhook terkirim', async () => {
  webhookReceived = [];
  const test = await http('POST', '/api/admin/alerts/test', { rule: 'requests_per_minute' }, adminToken);
  assert.equal(test.status, 201, JSON.stringify(test.data));
  assert.ok(test.data.alert.id);
  assert.equal(test.data.alert.rule, 'requests_per_minute');
  assert.equal(test.data.alert.status, 'firing');
  assert.ok(test.data.alert.value > test.data.alert.threshold, 'value > threshold');
  assert.match(test.data.alert.message, /TEST/);

  // Webhook menerima notification
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(webhookReceived.length >= 1, `webhook received: ${webhookReceived.length}`);
  const wh = webhookReceived[webhookReceived.length - 1];
  const payload = JSON.parse(wh.body);
  assert.match(payload.text, /Alert/i);
  assert.ok(payload.attachments[0].fields.length >= 4);
});

// ─── 3. Alert list ───────────────────────────────────────────────────────────

test('list: GET /alerts menampilkan firing + filter status', async () => {
  // Buat beberapa test alert
  await http('POST', '/api/admin/alerts/test', { rule: 'bandwidth_per_minute_mb' }, adminToken);
  await http('POST', '/api/admin/alerts/test', { rule: 'disk_usage_percent' }, adminToken);

  // List semua
  const all = await http('GET', '/api/admin/alerts', undefined, adminToken);
  assert.equal(all.status, 200);
  assert.ok(all.data.alerts.length >= 3, 'minimal 3 alert');

  // Filter firing
  const firing = await http('GET', '/api/admin/alerts?status=firing', undefined, adminToken);
  assert.equal(firing.status, 200);
  assert.ok(firing.data.alerts.every((a: any) => a.status === 'firing'));
  assert.ok(firing.data.alerts.length >= 3);
});

// ─── 4. Acknowledge ──────────────────────────────────────────────────────────

test('acknowledge: POST /alerts/:id/acknowledge → acknowledged = true', async () => {
  const alerts = await http('GET', '/api/admin/alerts?status=firing', undefined, adminToken);
  const target = alerts.data.alerts[0];

  const ack = await http('POST', `/api/admin/alerts/${target.id}/acknowledge`, {}, adminToken);
  assert.equal(ack.status, 200);
  assert.equal(ack.data.ok, true);

  // Verifikasi: alert sekarang acknowledged
  const after = await http('GET', '/api/admin/alerts', undefined, adminToken);
  const updated = after.data.alerts.find((a: any) => a.id === target.id);
  assert.equal(updated.acknowledged, true);
});

// ─── 5. Force check ──────────────────────────────────────────────────────────

test('force check: POST /monitoring/check → evaluasi rules tanpa error', async () => {
  const check = await http('POST', '/api/admin/monitoring/check', {}, adminToken);
  assert.equal(check.status, 200);
  assert.ok('triggered' in check.data);
  assert.ok('resolved' in check.data);
  // Tanpa trafik, tidak ada yang trigger
  assert.equal(check.data.triggered, 0);
});

// ─── 6. Rule update ──────────────────────────────────────────────────────────

test('rule update: PUT threshold → tersimpan di config', async () => {
  const update = await http(
    'PUT',
    '/api/admin/settings/monitoring',
    {
      rules: [
        { name: 'requests_per_minute', threshold: 500 },
        { name: 'bandwidth_per_minute_mb', enabled: false },
      ],
    },
    adminToken
  );
  assert.equal(update.status, 200);

  const config = await http('GET', '/api/admin/settings/monitoring', undefined, adminToken);
  const reqRule = config.data.rules.find((r: any) => r.name === 'requests_per_minute');
  assert.equal(reqRule.threshold, 500);
  const bwRule = config.data.rules.find((r: any) => r.name === 'bandwidth_per_minute_mb');
  assert.equal(bwRule.enabled, false);
});

// ─── 7. Auth guard ───────────────────────────────────────────────────────────

test('monitoring endpoints: tanpa admin token → 401', async () => {
  const endpoints = [
    ['GET', '/api/admin/settings/monitoring'],
    ['GET', '/api/admin/alerts'],
    ['POST', '/api/admin/alerts/test'],
    ['POST', '/api/admin/monitoring/check'],
  ];
  for (const [method, p] of endpoints) {
    const r = await http(method as string, p);
    assert.equal(r.status, 401, `${method} ${p} harus 401`);
  }
});

// ─── 8. Invalid config ───────────────────────────────────────────────────────

test('config: webhook URL kosong → null; cooldown di-clamp 1-1440', async () => {
  const update = await http(
    'PUT',
    '/api/admin/settings/monitoring',
    { webhookUrl: '', cooldownMinutes: 2000 },
    adminToken
  );
  assert.equal(update.status, 200);
  assert.equal(update.data.webhookUrl, null);
  assert.equal(update.data.cooldownMinutes, 1440, 'clamped ke 1440 (24 jam)');
});
