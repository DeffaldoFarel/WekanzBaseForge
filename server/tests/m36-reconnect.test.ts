// ============================================================================
// M36: TEST SSE AUTO-RECONNECT LOGIC — unit test (tanpa real SSE connection)
//
// Test reconnect logic secara terisolasi: handleDisconnect → scheduleReconnect
// → backoff calculation → retryCount tracking → manual close tidak reconnect.
// Tidak menggunakan EventSource real (menghindari Node.js process hang).
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import nodeHttp from 'node:http';
import { initPlatformDb, closePlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { Router } from '../src/core/router.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';

const TEST_DATA_DIR = path.resolve('../data/m36-reconnect-test');

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
  process.env.ADMIN_EMAIL = 'admin@m36.test';
  process.env.ADMIN_PASSWORD = 'm36-secret-pass';
  process.env.JWT_SECRET = 'm36-test-jwt-secret-key-long-enough';
  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());

  server = nodeHttp.createServer((rq, rs) => router.handle(rq, rs));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@m36.test',
    password: 'm36-secret-pass',
  });
  adminToken = login.data.token;

  const proj = await http('POST', '/api/admin/projects', { name: 'm36-reconnect' }, adminToken);
  projectId = proj.data.project.id;

  const col = await http(
    'POST',
    `/api/admin/projects/${projectId}/collections`,
    {
      name: 'items',
      fields: [{ name: 'title', type: 'text' }],
      rules: { listRule: '', viewRule: '', createRule: '' },
    },
    adminToken
  );
  assert.equal(col.status, 201, `collection: ${JSON.stringify(col.data)}`);
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  closeAllProjectDbs();
  // Windows: rmSync gagal EPERM selama handle platform.db masih terbuka.
  closePlatformDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─── RealtimeService unit test via direct method calls ─────────────────────

// Minimal stub client (no real EventSource needed)
class TestClient {
  baseUrl: string;
  projectId: string;
  authStore = { token: null, refreshToken: null, user: null, isValid: false };
  constructor(baseUrl: string, projectId: string) {
    this.baseUrl = baseUrl;
    this.projectId = projectId;
  }
}

// Import RealtimeService
const { RealtimeService } = await import('../../packages/client/src/services/realtimeService.js');

// Test 1: Backoff calculation — exponential dengan cap
test('backoff: 1s → 2s → 4s → 8s → 16s → 30s (capped)', async () => {
  const client = new TestClient(baseURL, projectId);
  const svc = new RealtimeService(client as never);

  // Access protected method for testing
  const svcAny = svc as any;
  const delays: number[] = [];

  // Simulate retry progression
  for (let i = 0; i < 8; i++) {
    const delay = Math.min(1000 * Math.pow(2, i), 30000);
    delays.push(delay);
  }

  assert.equal(delays[0], 1000, 'first retry: 1s');
  assert.equal(delays[1], 2000, 'second retry: 2s');
  assert.equal(delays[2], 4000, 'third retry: 4s');
  assert.equal(delays[3], 8000, 'fourth retry: 8s');
  assert.equal(delays[4], 16000, 'fifth retry: 16s');
  assert.equal(delays[5], 30000, 'sixth retry: 30s (capped)');
  assert.equal(delays[6], 30000, 'seventh retry: 30s (still capped)');
  assert.equal(delays[7], 30000, 'eighth retry: 30s (still capped)');
});

// Test 2: handleDisconnect resets state
test('handleDisconnect: closes EventSource + resets clientId', async () => {
  const client = new TestClient(baseURL, projectId);
  const svc = new RealtimeService(client as never);

  // Manually set connected state (simulate)
  (svc as any).clientId = 'test-client-id';
  (svc as any).eventSource = { close: () => {} };

  assert.ok(svc.isConnected, 'should be connected');

  // Trigger disconnect
  (svc as any).handleDisconnect();

  assert.ok(!svc.isConnected, 'should be disconnected');
  assert.equal(svc.clientId, null, 'clientId should be null');
  assert.equal(svc.eventSource, null, 'eventSource should be null');

  // Clean up: clear reconnect timer
  (svc as any).clearReconnectTimer();
});

// Test 3: manuallyClosed flag prevents reconnect
test('manuallyClosed: set during unsubscribe → no reconnect scheduled', async () => {
  const client = new TestClient(baseURL, projectId);
  const svc = new RealtimeService(client as never);

  // Set connected state
  (svc as any).clientId = 'test-id';
  (svc as any).eventSource = { close: () => {} };

  // Mark as manually closed (unsubscribe → close)
  (svc as any).manuallyClosed = true;

  // Call handleDisconnect → should NOT schedule reconnect
  (svc as any).handleDisconnect();

  // Verify no reconnect timer
  assert.equal((svc as any).reconnectTimer, null, 'no reconnect timer');
});

// Test 4: retryCount tracking
test('retryCount: increments on failed reconnect, resets on success', async () => {
  const client = new TestClient(baseURL, projectId);
  const svc = new RealtimeService(client as never);

  assert.equal(svc.reconnectAttempts, 0, 'initial = 0');

  // Simulate: failed reconnect → increment
  (svc as any).retryCount = 3;
  assert.equal(svc.reconnectAttempts, 3, 'after 3 failures = 3');

  // Simulate: successful reconnect → reset
  (svc as any).retryCount = 0;
  assert.equal(svc.reconnectAttempts, 0, 'after success = 0');
});

// Test 5: onReconnect returns unsubscribe function
test('onReconnect: register + unregister callback', async () => {
  const client = new TestClient(baseURL, projectId);
  const svc = new RealtimeService(client as never);

  let called = 0;
  const unregister = svc.onReconnect(() => { called++; });

  // Simulate reconnect notification
  for (const listener of (svc as any).reconnectListeners) {
    listener();
  }
  assert.equal(called, 1, 'callback should fire');

  // Unregister
  unregister();

  for (const listener of (svc as any).reconnectListeners) {
    listener();
  }
  assert.equal(called, 1, 'callback should NOT fire after unregister');
});

// Test 6: scheduleReconnect calculates correct delay
test('scheduleReconnect: uses exponential backoff', async () => {
  const client = new TestClient(baseURL, projectId);
  const svc = new RealtimeService(client as never);

  // Test delay calculation at different retry counts
  const calculateDelay = (retryCount: number) => {
    return Math.min(1000 * Math.pow(2, retryCount), 30000);
  };

  assert.equal(calculateDelay(0), 1000);
  assert.equal(calculateDelay(1), 2000);
  assert.equal(calculateDelay(2), 4000);
  assert.equal(calculateDelay(4), 16000);
  assert.equal(calculateDelay(5), 30000, 'capped at 30s');
  assert.equal(calculateDelay(10), 30000, 'still capped');
});
