import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import nodeHttp from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { Router } from '../src/core/router.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';
import { createPublicRouter } from '../src/api/publicRoutes.js';
import { initPlatformDb, createProject } from '../src/core/platformDb.js';
import { getProjectDb, closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { initSchemaTable, defineCollection, rebuildCollection } from '../src/core/schema.js';
import { createRecord, getRecord, listRecords } from '../src/core/records.js';
import { verifyPassword } from '../src/auth/password.js';

describe('Unified Auth Collections (PocketBase Parity)', () => {
  const db = new DatabaseSync(':memory:');
  initSchemaTable(db);

  test('defineCollection with type=auth creates table with password_hash & email unique', () => {
    const meta = defineCollection(db, {
      name: 'users',
      type: 'auth',
      fields: [
        { name: 'name', type: 'text' },
        { name: 'role', type: 'select', options: { values: ['admin', 'member', 'guest'] } },
      ],
    });

    assert.equal(meta.type, 'auth');
    assert.ok(meta.fields.some((f) => f.name === 'email'));
    assert.ok(meta.fields.some((f) => f.name === 'verified'));
    assert.ok(meta.fields.some((f) => f.name === 'name'));
    assert.ok(meta.fields.some((f) => f.name === 'role'));

    const cols = db.prepare(`PRAGMA table_info("users")`).all() as { name: string }[];
    assert.ok(cols.some((c) => c.name === 'password_hash'));
    assert.ok(cols.some((c) => c.name === 'email'));
  });

  let createdUserId = '';

  test('createRecord hashes password and strips password_hash in response', () => {
    const user = createRecord(db, 'users', {
      email: 'deffaldo@wekanz.id',
      password: 'StrongPassword123',
      name: 'Deffaldo Farel',
      role: 'admin',
    });

    assert.ok(user.id);
    createdUserId = user.id;
    assert.equal(user.email, 'deffaldo@wekanz.id');
    assert.equal(user.name, 'Deffaldo Farel');
    assert.equal(user.role, 'admin');
    assert.equal((user as Record<string, unknown>).password_hash, undefined);
    assert.equal((user as Record<string, unknown>).password, undefined);

    const raw = db.prepare(`SELECT * FROM "users" WHERE id = ?`).get(user.id) as Record<string, unknown>;
    assert.ok(typeof raw.password_hash === 'string');
    assert.ok(verifyPassword('StrongPassword123', String(raw.password_hash)));
  });

  test('getRecord and listRecords strip password_hash', () => {
    const rec = getRecord(db, 'users', createdUserId);
    assert.ok(rec);
    assert.equal((rec as Record<string, unknown>).password_hash, undefined);
    assert.equal(rec.name, 'Deffaldo Farel');

    const list = listRecords(db, 'users', {});
    assert.equal(list.items.length, 1);
    assert.equal((list.items[0] as Record<string, unknown>).password_hash, undefined);
  });

  test('rebuildCollection preserves password_hash intact', () => {
    const updated = rebuildCollection(db, 'users', {
      fields: [
        { name: 'email', type: 'email', required: true },
        { name: 'name', type: 'text' },
        { name: 'role', type: 'select', options: { values: ['admin', 'member', 'guest'] } },
        { name: 'bio', type: 'text' },
      ],
    });

    assert.equal(updated.type, 'auth');
    assert.ok(updated.fields.some((f) => f.name === 'bio'));

    const raw = db.prepare(`SELECT * FROM "users" WHERE id = ?`).get(createdUserId) as Record<string, unknown>;
    assert.ok(raw);
    assert.ok(typeof raw.password_hash === 'string');
    assert.ok(verifyPassword('StrongPassword123', String(raw.password_hash)));
    assert.equal(raw.name, 'Deffaldo Farel');
  });
});

describe('HTTP Auth Collection Endpoints', () => {
  let server: nodeHttp.Server;
  let baseURL = '';
  const TEST_DATA_DIR = path.join(os.tmpdir(), `baseforge-auth-col-${Date.now()}`);
  let pid = '';
  let adminToken = '';

  before(async () => {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    process.env.DATA_DIR = TEST_DATA_DIR;
    process.env.ADMIN_EMAIL = 'admin@authcol.local';
    process.env.ADMIN_PASSWORD = 'admin-authcol-pass';

    initPlatformDb();

    const router = new Router();
    router.merge(createAdminRouter());
    router.merge(createDatabaseRouter());
    router.merge(createPublicRouter());

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

    // Login admin
    const loginRes = await fetch(`${baseURL}/api/admin/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@authcol.local', password: 'admin-authcol-pass' }),
    }).then((r) => r.json());
    adminToken = loginRes.token;

    // Create project
    const projRes = await fetch(`${baseURL}/api/admin/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: 'AuthColProj' }),
    }).then((r) => r.json());
    pid = projRes.project.id;
  });

  after(() => {
    closeAllProjectDbs();
    server.close();
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  let authUserToken = '';

  test('Create auth collection via admin API and register user via record API', async () => {
    // 1. Create auth collection 'members'
    const colRes = await fetch(`${baseURL}/api/admin/projects/${pid}/collections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: 'members',
        type: 'auth',
        fields: [
          { name: 'name', type: 'text' },
          { name: 'tier', type: 'select', options: { values: ['silver', 'gold', 'platinum'] } },
        ],
        rules: {
          listRule: '',
          viewRule: '',
          createRule: '',
          updateRule: '',
          deleteRule: '',
        },
      }),
    }).then((r) => r.json());

    assert.equal(colRes.collection.name, 'members');
    assert.equal(colRes.collection.type, 'auth');

    // 2. Create user record with password & custom field
    const userRes = await fetch(`${baseURL}/api/p/${pid}/collections/members/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'member@wekanz.id',
        password: 'Password12345',
        name: 'Member Wekanz',
        tier: 'gold',
      }),
    }).then((r) => r.json());

    assert.ok(userRes.record.id);
    assert.equal(userRes.record.email, 'member@wekanz.id');
    assert.equal(userRes.record.name, 'Member Wekanz');
    assert.equal(userRes.record.tier, 'gold');
    assert.equal(userRes.record.password_hash, undefined);
  });

  // Tahap 4 (Ops-12): test untuk `auth-with-password`, `auth-refresh`, dan
  // `auth-logout` dihapus bersama endpointnya. Autentikasi end-user kini hanya
  // lewat platform auth `/api/p/:pid/auth/*`; lihat
  // tests/ops12-auth-collection-removal.test.ts. Collection type=auth sendiri
  // tetap ada — test di bawah menjaga skema dan CRUD-nya.


  test('M40: register with duplicate email returns 409 EMAIL_TAKEN', async () => {
    const dupe = await fetch(`${baseURL}/api/p/${pid}/collections/members/records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'Member@wekanz.id', // beda case — tetap harus ditolak
        password: 'Password12345',
        name: 'Impostor',
      }),
    });
    assert.equal(dupe.status, 409);
    const body = await dupe.json() as { error: { code: string } };
    assert.equal(body.error.code, 'EMAIL_TAKEN');
  });

  test('M40: auth collection record listable from dashboard (admin API)', async () => {
    const listRes = await fetch(`${baseURL}/api/admin/projects/${pid}/collections/members/records`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(listRes.status, 200);
    const body = await listRes.json() as { items: Record<string, unknown>[] };
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].email, 'member@wekanz.id');
    assert.equal(body.items[0].password_hash, undefined);
  });
});
