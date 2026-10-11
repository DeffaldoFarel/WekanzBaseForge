// ============================================================================
// SECURITY: finance functions & realtime auth hardening (audit F-01..F-05)
//
// F-01: callable functions with dbAccess must NOT be callable via the public
//       /api/p/:pid/functions/:name/execute route — admin-only.
// F-05: POST /realtime must NOT upgrade auth of a client belonging to a
//       different project.
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
import { createRealtimeRouter } from '../src/api/realtimeRoutes.js';
import { createFunctionRouter } from '../src/api/functionRoutes.js';
import { Router } from '../src/core/router.js';
import { realtimeHub } from '../src/core/realtime.js';
import type { ServerResponse } from 'node:http';

// ─── State & server ──────────────────────────────────────────────────────────

let server: nodeHttp.Server;
let baseURL = '';
const TEST_DATA_DIR = path.resolve('../data/sec-fn-test');

let pid: string;
let adminToken: string;
let tokenA: string;

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
        try { data = JSON.parse(text); } catch { /* stream */ }
        resolve({ status: res.statusCode ?? 0, data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/** Minimal SSE connection helper — resolves once PB_CONNECT arrives. */
async function openSse(pidLocal: string): Promise<{ clientId: string; res: nodeHttp.IncomingMessage; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request(new URL(`/api/p/${pidLocal}/realtime`, baseURL), { method: 'GET' });
    req.on('response', (res) => {
      let buffer = '';
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        const m = buffer.match(/event:\s*PB_CONNECT\r?\ndata:\s*(\{[^\n]*\})/);
        if (m) {
          const { clientId } = JSON.parse(m[1]);
          resolve({
            clientId,
            res,
            close: () => req.destroy(),
          });
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
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
  router.merge(createRealtimeRouter());
  router.merge(createFunctionRouter());

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

  const login = await http('POST', '/api/admin/auth/login', { email: 'admin@test.local', password: 'admin-test-pass' });
  adminToken = login.data.token;

  const proj = await http('POST', '/api/admin/projects', { name: 'secfn' }, adminToken);
  pid = proj.data.project.id;

  const reg = await http('POST', `/api/p/${pid}/auth/register`, { email: 'a@secfn.test', password: 'passwordA123' });
  tokenA = reg.data.accessToken;
});

after(async () => {
  closeAllProjectDbs();
  closePlatformDb();
  server.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─── F-01: public callable functions ────────────────────────────────────────

test('F-01: function with dbAccess=true → public execute must be 404/403 (admin-only)', async () => {
  await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'sensitive_aggregate',
    code: `return { ok: true };`,
    dbAccess: true,
    enabled: true,
  }, adminToken);

  // Authenticated end user
  const authed = await http('POST', `/api/p/${pid}/functions/sensitive_aggregate/execute`, {}, tokenA);
  assert.ok([403, 404].includes(authed.status), `expected 403/404, got ${authed.status}`);
  if (authed.status === 403) {
    assert.equal(authed.data.error.code, 'FORBIDDEN');
  }

  // Anonymous
  const anon = await http('POST', `/api/p/${pid}/functions/sensitive_aggregate/execute`, {});
  assert.ok([403, 404].includes(anon.status), `expected 403/404, got ${anon.status}`);

  // Admin path still works
  const adm = await http('POST', `/api/admin/projects/${pid}/functions/sensitive_aggregate/execute`, {}, adminToken);
  assert.equal(adm.status, 200);
});

test('F-01: function with dbAccess=false → public execute still allowed (enabled)', async () => {
  await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'pure_calc',
    code: `return { total: (req.body.x || 0) * 2 };`,
    dbAccess: false,
    enabled: true,
  }, adminToken);

  const res = await http('POST', `/api/p/${pid}/functions/pure_calc/execute`, { body: { x: 21 } }, tokenA);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.result, { total: 42 });
});

test('F-01: explicit callable=true opt-in overrides the dbAccess guard', async () => {
  await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'declared_callable',
    code: `return { ok: true };`,
    dbAccess: true,
    callable: true,
    enabled: true,
  }, adminToken);

  const res = await http('POST', `/api/p/${pid}/functions/declared_callable/execute`, {}, tokenA);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.result, { ok: true });
});

// ─── F-05: cross-project auth upgrade ────────────────────────────────────────

test('F-05: POST /realtime must refuse to upgrade auth of a client from another project', async () => {
  // Project A — the SSE connection owner.
  const projA = pid;

  // Create a second, separate project + user (the attacker's project/token).
  const projB = await http('POST', '/api/admin/projects', { name: 'secfn-b' }, adminToken);
  const pidB = projB.data.project.id;
  const regB = await http('POST', `/api/p/${pidB}/auth/register`, { email: 'b@secfn.test', password: 'passwordB123' });
  const tokenB = regB.data.accessToken;

  // Open an SSE connection on project A (anonymous — no token).
  const sse = await openSse(projA);
  try {
    // The client id is only delivered over the SSE stream of project A, but a
    // colliding/leaked id must still not be upgradable through project B's route.
    const res = await http('POST', `/api/p/${pidB}/realtime`, {
      clientId: sse.clientId,
      subscriptions: ['posts'],
    }, tokenB);
    assert.equal(res.status, 404, 'cross-project clientId must be treated as unknown on project B');
  } finally {
    sse.close();
  }
});

test('F-05: same-project POST /realtime still upgrades auth (regression)', async () => {
  const sse = await openSse(pid);
  try {
    const res = await http('POST', `/api/p/${pid}/realtime`, {
      clientId: sse.clientId,
      subscriptions: [],
    }, tokenA);
    assert.equal(res.status, 200, 'same-project sync must keep working');
  } finally {
    sse.close();
  }
});

// ─── F-04: serialized aggregate recompute (unit-level) ───────────────────────

test('F-04: per-key task queue runs overlapping recompute jobs in submission order (last write wins)', async () => {
  // Import the new serialization helper.
  const { createKeyedTaskQueue } = await import('../src/core/keyedTaskQueue.js');

  const completed: string[] = [];
  const queue = createKeyedTaskQueue();

  // Job 1 is SLOW (old snapshot finishing last), job 2 is FAST (new snapshot
  // finishing first). Serialized execution must make the final state the NEW
  // snapshot's value, regardless of internal completion speed.
  const run1 = queue.run('user-1', async () => {
    await new Promise((r) => setTimeout(r, 80));
    completed.push('job1');
  });
  const run2 = queue.run('user-1', async () => {
    await new Promise((r) => setTimeout(r, 10));
    completed.push('job2');
  });

  await Promise.all([run1, run2]);
  assert.deepEqual(completed, ['job1', 'job2'], 'jobs for the same key must run sequentially in submission order');

  // Different keys do not serialize against each other.
  const order: string[] = [];
  const q2 = createKeyedTaskQueue();
  const a = q2.run('k-a', async () => {
    await new Promise((r) => setTimeout(r, 60));
    order.push('a');
  });
  const b = q2.run('k-b', async () => {
    await new Promise((r) => setTimeout(r, 10));
    order.push('b');
  });
  await Promise.all([a, b]);
  assert.deepEqual(order, ['b', 'a'], 'different keys must run concurrently');
});
