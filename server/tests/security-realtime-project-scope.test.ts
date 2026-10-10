// ============================================================================
// SECURITY: realtime hub harus project-scoped — event dari project X tidak
// boleh sampai ke subscriber project Y meskipun userId-nya sama.
// Repro temuan audit: hub lama tidak menyimpan projectId pada client, dan
// publish() tidak tahu project — event lintas project bisa bocor.
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
import { Router } from '../src/core/router.js';

let server: nodeHttp.Server;
let baseURL = '';
const TEST_DATA_DIR = path.resolve('../data/sec-rt-scope-test');

let pidA: string;
let pidB: string;
let adminToken: string;
let userAId: string;
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

interface SseEvent { event: string; data: any }

function openSse(reqPath: string, token?: string): { events: SseEvent[]; req: nodeHttp.ClientRequest } {
  const events: SseEvent[] = [];
  const url = new URL(reqPath, baseURL);
  const req = nodeHttp.request(url, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  req.end();
  req.on('response', (res) => {
    let buffer = '';
    res.setEncoding('utf-8');
    res.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const evMatch = frame.match(/event: (.+)/);
        const dataMatch = frame.match(/data: (.+)/);
        if (evMatch) {
          let data: any = null;
          try { data = JSON.parse(dataMatch?.[1] ?? 'null'); } catch { data = dataMatch?.[1] ?? null; }
          events.push({ event: evMatch[1].trim(), data });
        }
      }
    });
  });
  return { events, req };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  router.merge(createRealtimeRouter());

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

  const projA = await http('POST', '/api/admin/projects', { name: 'sec-rt-A' }, adminToken);
  pidA = projA.data.project.id;
  const projB = await http('POST', '/api/admin/projects', { name: 'sec-rt-B' }, adminToken);
  pidB = projB.data.project.id;

  for (const pid of [pidA, pidB]) {
    await http('POST', `/api/admin/projects/${pid}/collections`, {
      name: 'posts',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'userId', type: 'text', required: true },
      ],
    }, adminToken);
    await http('PATCH', `/api/admin/projects/${pid}/collections/posts/rules`, {
      listRule: 'userId = @request.auth.id',
      viewRule: 'userId = @request.auth.id',
      createRule: '@request.auth.id != "" && userId = @request.auth.id',
    }, adminToken);
  }

  // Register user in project A only — the SAME subject id must not exist in B.
  const reg = await http('POST', `/api/p/${pidA}/auth/register`, { email: 'a@scope.test', password: 'passwordA123' });
  tokenA = reg.data.accessToken;
  userAId = reg.data.user.id;
});

after(async () => {
  closeAllProjectDbs();
  closePlatformDb();
  server.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test('security: SSE subscriber of project A never receives events published in project B', async () => {
  // Subscriber connects through project A's URL with user A's token.
  const sseA = openSse(`/api/p/${pidA}/realtime`, tokenA);
  await sleep(200);
  const clientIdA = sseA.events[0]?.data?.clientId;
  assert.ok(clientIdA, 'PB_CONNECT must arrive first');

  // Subscribe via project A's realtime sync route.
  const sub = await http('POST', `/api/p/${pidA}/realtime`, { clientId: clientIdA, subscriptions: ['posts/*'] }, tokenA);
  assert.equal(sub.status, 200, JSON.stringify(sub.data));
  await sleep(200);

  // A record is created IN PROJECT B. The client has no subscription and no
  // identity there — but the old hub broadcast to every connected client
  // regardless of project, and the userId-based rule passed because the
  // subject id is the same string.
  // Use the project B admin (service context) to create a record owned by
  // the same subject id string as user A.
  const recB = await http('POST', `/api/p/${pidB}/collections/posts/records`, { title: 'project B secret', userId: userAId }, adminToken);
  assert.equal(recB.status, 201, JSON.stringify(recB.data));

  await sleep(500);
  sseA.req.destroy();

  const leaked = sseA.events.filter((e) => e.event === 'PB_CREATE' && e.data?.record?.title === 'project B secret');
  assert.equal(leaked.length, 0, 'project A subscriber must NOT receive project B events');
});

test('security: same-subject token from project B cannot subscribe into project A realtime', async () => {
  // user A registers in project B TOO — creating a same-subject-different-project
  // identity. A token minted by project B must be rejected by project A routes
  // (JWT project binding) — so no subscription hijack is possible either way.
  const regB = await http('POST', `/api/p/${pidB}/auth/register`, { email: 'b@scope.test', password: 'passwordB123' });
  assert.equal(regB.status, 201);
  const tokenB = regB.data.accessToken;
  const userBId = regB.data.user.id;

  const sseFake = openSse(`/api/p/${pidA}/realtime`, tokenB);
  await sleep(300);
  sseFake.req.destroy();
  // The SSE GET must NOT hand a working clientId to a foreign-project token.
  const connect = sseFake.events.find((e) => e.event === 'PB_CONNECT');
  assert.equal(connect, undefined, 'foreign-project token must not establish a realtime connection');
});

test('security: events published in project A reach only project A subscribers (same subject)', async () => {
  // Register the SAME subject id in both projects (forced via admin create in B
  // is not possible for auth — so verify the inverse: user A's own event in
  // project A does reach them; baseline guard against over-blocking).
  const sseA = openSse(`/api/p/${pidA}/realtime`, tokenA);
  await sleep(200);
  const clientIdA = sseA.events[0]?.data?.clientId;
  await http('POST', `/api/p/${pidA}/realtime`, { clientId: clientIdA, subscriptions: ['posts/*'] }, tokenA);
  await sleep(200);

  const recA = await http('POST', `/api/p/${pidA}/collections/posts/records`, { title: 'project A own', userId: userAId }, tokenA);
  assert.equal(recA.status, 201, JSON.stringify(recA.data));
  await sleep(500);
  sseA.req.destroy();

  const own = sseA.events.filter((e) => e.event === 'PB_CREATE' && e.data?.record?.title === 'project A own');
  assert.equal(own.length, 1, 'user must still receive their OWN project events');
});
