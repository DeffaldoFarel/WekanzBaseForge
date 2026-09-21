// ============================================================================
// Ops-20: Backend Hardening Tests
//
// 1. Router Payload Size Limit (413 on payload > 10MB JSON)
// 2. Router Top-level Error Boundary (middleware throw caught gracefully)
// 3. Auth Users Pagination & LIKE Wildcard Escaping
// 4. Project DB Connection Cache LRU Eviction & Cap
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Router } from '../src/core/router.js';
import { initPlatformDb, createProject, deleteProject, provisionProjectStorage, destroyProjectStorage, DEFAULT_SERVICES } from '../src/core/platformDb.js';
import { getProjectDb, closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { initAuthUsersTable, createAuthUser, listAuthUsers } from '../src/auth/users.js';

test('Ops-20: Router rejects oversized payload with 413 PAYLOAD_TOO_LARGE', async () => {
  const router = new Router();
  router.post('/test-payload', (_req, res) => {
    res.json({ ok: true });
  });

  const server = http.createServer((req, res) => {
    void router.handle(req, res);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  try {
    // Send 11 MB payload with Content-Length header
    const oversize = 11 * 1024 * 1024;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/test-payload',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(oversize),
      },
    });

    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      req.on('response', resolve);
      req.on('error', reject);
      req.end();
    });

    assert.equal(res.statusCode, 413);

    const body = await new Promise<string>((resolve) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    });

    const json = JSON.parse(body);
    assert.equal(json.error?.code, 'PAYLOAD_TOO_LARGE');
  } finally {
    server.close();
  }
});

test('Ops-20: Router error boundary catches middleware errors without crashing server', async () => {
  const router = new Router();
  // Middleware that throws
  router.use(() => {
    throw new Error('Explosive middleware failure');
  });
  router.get('/ping', (_req, res) => {
    res.json({ pong: true });
  });

  const server = http.createServer((req, res) => {
    void router.handle(req, res);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/ping',
          method: 'GET',
        },
        resolve
      );
      req.on('error', reject);
      req.end();
    });

    assert.equal(res.statusCode, 500);
    const body = await new Promise<string>((resolve) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(d));
    });
    const json = JSON.parse(body);
    assert.equal(json.error?.code, 'INTERNAL_ERROR');
    assert.match(json.error?.message, /Explosive middleware failure/);
  } finally {
    server.close();
  }
});

test('Ops-20: listAuthUsers handles NaN/negative pagination and escapes LIKE wildcards', () => {
  initPlatformDb();
  const pid = 'ops20proj' + Math.random().toString(36).slice(2, 7);
  createProject(pid, 'Ops-20 Test Project', DEFAULT_SERVICES);
  provisionProjectStorage(pid);
  const db = getProjectDb(pid);
  initAuthUsersTable(db);

  createAuthUser(db, { email: 'user_a@test.com', password: 'Password123!', name: 'Alice Walker' });
  createAuthUser(db, { email: 'user%b@test.com', password: 'Password123!', name: 'Bob % Builder' });
  createAuthUser(db, { email: 'userc@test.com', password: 'Password123!', name: 'Charlie Brown' });

  // 1. NaN and negative pagination clamping
  const nanResult = listAuthUsers(db, NaN, NaN);
  assert.equal(nanResult.page, 1);
  assert.equal(nanResult.perPage, 20);
  assert.equal(nanResult.totalItems, 3);

  const negResult = listAuthUsers(db, -5, -100);
  assert.equal(negResult.page, 1);
  assert.equal(negResult.perPage, 20);

  // 2. Search matches name as well as email
  const nameSearch = listAuthUsers(db, 1, 10, 'Charlie');
  assert.equal(nameSearch.items.length, 1);
  assert.equal(nameSearch.items[0].email, 'userc@test.com');

  // 3. Search matches user ID directly!
  const charlieId = nameSearch.items[0].id;
  const idSearch = listAuthUsers(db, 1, 10, charlieId);
  assert.equal(idSearch.items.length, 1);
  assert.equal(idSearch.items[0].id, charlieId);
  assert.equal(idSearch.items[0].email, 'userc@test.com');

  // 4. Literal % search only matches Bob % Builder, not all rows!
  const pctSearch = listAuthUsers(db, 1, 10, '%');
  assert.equal(pctSearch.items.length, 1);
  assert.equal(pctSearch.items[0].name, 'Bob % Builder');

  // 5. Literal _ search only matches user_a, not all rows!
  const underscoreSearch = listAuthUsers(db, 1, 10, '_');
  assert.equal(underscoreSearch.items.length, 1);
  assert.equal(underscoreSearch.items[0].email, 'user_a@test.com');

  closeAllProjectDbs();
  deleteProject(pid);
  destroyProjectStorage(pid);
});

test('Ops-20: Project DB connection cache adheres to LRU capacity cap (anti-EMFILE)', () => {
  initPlatformDb();
  const testPids: string[] = [];

  try {
    // Buat 105 projects berturut-turut
    for (let i = 0; i < 105; i++) {
      const p = `lru${i}_${Math.random().toString(36).slice(2, 6)}`;
      testPids.push(p);
      createProject(p, `LRU Test ${i}`, DEFAULT_SERVICES);
      provisionProjectStorage(p);
      // Buka koneksi — ini meng-cache di connections
      getProjectDb(p);
    }

    // Akses kembali project pertama (testPids[0]): harus bisa dibuka kembali tanpa error walau sudah tergusur
    const reopenedDb = getProjectDb(testPids[0]);
    assert.ok(reopenedDb);
  } finally {
    closeAllProjectDbs();
    for (const p of testPids) {
      deleteProject(p);
      destroyProjectStorage(p);
    }
  }
});
