// ============================================================================
// M28: TEST CLI — jalankan CLI sebagai child process, verifikasi output
//
// CLI memanggil server HTTP live (sama pattern test lain). State ditulis ke
// HOME override (env HOME → temp dir) supaya tidak mengganggu state user.
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import nodeHttp from 'node:http';
import { execFile } from 'node:child_process';
import { initPlatformDb, closePlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { Router } from '../src/core/router.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';
import { createPublicRouter } from '../src/api/publicRoutes.js';
import { createWebhookRouter } from '../src/api/webhookRoutes.js';

const TEST_DATA_DIR = path.resolve('../data/m28-cli-test');
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-cli-home-'));

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

/** Jalankan CLI sebagai child process (node --import tsx). stdin untuk password. */
function cli(args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      ['--import', 'tsx', 'src/cli/index.ts', ...args],
      {
        cwd: path.resolve('.'),
        env: { ...process.env, HOME: FAKE_HOME, USERPROFILE: FAKE_HOME },
        timeout: 20_000,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (error as { code?: number }).code ?? 1 : 0,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
        });
      }
    );
    if (stdin) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    }
  });
}

before(async () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  process.env.DATA_DIR = TEST_DATA_DIR;
  process.env.ADMIN_EMAIL = 'admin@m28cli.test';
  process.env.ADMIN_PASSWORD = 'm28cli-secret-pass';
  process.env.JWT_SECRET = 'm28cli-test-jwt-secret-key-long-enough';
  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());
  router.merge(createPublicRouter());
  router.merge(createWebhookRouter());

  server = nodeHttp.createServer((rq, rs) => router.handle(rq, rs));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  baseURL = `http://127.0.0.1:${addr.port}`;

  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@m28cli.test',
    password: 'm28cli-secret-pass',
  });
  adminToken = login.data.token;

  const proj = await http('POST', '/api/admin/projects', { name: 'cli-proj' }, adminToken);
  projectId = proj.data.project.id;

  const col = await http(
    'POST',
    `/api/admin/projects/${projectId}/collections`,
    {
      name: 'posts',
      fields: [{ name: 'title', type: 'text' }],
      rules: { listRule: '', viewRule: '', createRule: '' },
    },
    adminToken
  );
  assert.equal(col.status, 201);
  const seed = await http('POST', `/api/p/${projectId}/collections/posts/records`, { title: 'seed post' });
  assert.equal(seed.status, 201);
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  closeAllProjectDbs();
  // Windows: rmSync gagal EPERM selama handle platform.db masih terbuka.
  closePlatformDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.rmSync(FAKE_HOME, { recursive: true, force: true });
});

// ─── Basic ────────────────────────────────────────────────────────────────────

test('help: menampilkan usage', async () => {
  const r = await cli(['help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage: baseforge/);
  assert.match(r.stdout, /projects/);
  assert.match(r.stdout, /records/);
});

test('unknown command → error + exit 1', async () => {
  const r = await cli(['badcmd']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Unknown command/);
});

test('whoami (belum login) → not logged in', async () => {
  const r = await cli(['whoami', '--url', baseURL]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Not logged in/);
});

// ─── Login flow ───────────────────────────────────────────────────────────────

test('login (password via stdin) → whoami menampilkan email + use menyimpan project', async () => {
  const login = await cli(['login', 'admin@m28cli.test', '--url', baseURL], 'm28cli-secret-pass\n');
  assert.equal(login.code, 0, `stderr: ${login.stderr}`);
  assert.match(login.stdout, /Logged in as admin@m28cli\.test/);

  const who = await cli(['whoami', '--url', baseURL]);
  assert.equal(who.code, 0);
  assert.match(who.stdout, /Admin: admin@m28cli\.test/);
  assert.match(who.stdout, /not selected/);

  const use = await cli(['use', projectId, '--url', baseURL]);
  assert.equal(use.code, 0);
  assert.match(use.stdout, /Active project: cli-proj/);

  const who2 = await cli(['whoami', '--url', baseURL]);
  assert.match(who2.stdout, new RegExp(projectId));
});

test('login password salah → exit 1 + error message', async () => {
  const r = await cli(['login', 'admin@m28cli.test', '--url', baseURL], 'wrong-password\n');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Error/);
});

// ─── Data commands ────────────────────────────────────────────────────────────

test('projects list → tabel berisi cli-proj', async () => {
  const r = await cli(['projects', '--url', baseURL]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /cli-proj/);
  assert.match(r.stdout, /ID\s+NAME\s+CREATED/);
});

test('collections list → tabel posts', async () => {
  const r = await cli(['collections', '--url', baseURL]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /posts/);
});

test('records list → seed post tampil sebagai JSON lines', async () => {
  const r = await cli(['records', 'list', 'posts', '--url', baseURL]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /"title":\s*"seed post"/);
  assert.match(r.stderr, /1 records/);
});

test('records create → record baru; records delete → sukses', async () => {
  const create = await cli(
    ['records', 'create', 'posts', '{"title":"from cli"}', '--url', baseURL],
  );
  assert.equal(create.code, 0, create.stderr);
  const rec = JSON.parse(create.stdout.trim().split('\n').slice(-5).join('\n').replace(/^[^{]*/, '') || '{}');
  // stdout bisa multi-baris JSON — cari field id via regex
  const idMatch = create.stdout.match(/"id":\s*"([a-z0-9]+)"/);
  assert.ok(idMatch, 'id ada di output');
  const rid = idMatch[1];

  const list = await cli(['records', 'list', 'posts', '--url', baseURL]);
  assert.match(list.stdout, /from cli/);

  const del = await cli(['records', 'delete', 'posts', rid, '--url', baseURL]);
  assert.equal(del.code, 0);
  assert.match(del.stdout, new RegExp(`Deleted: ${rid}`));
});

test('records create JSON invalid → exit 1', async () => {
  const r = await cli(['records', 'create', 'posts', '{bad json', '--url', baseURL]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /valid JSON/);
});

// ─── Tanpa project ────────────────────────────────────────────────────────────

test('records tanpa project terpilih → exit 1 + petunjuk use', async () => {
  // State ada (login dari test sebelumnya) — hapus project aktif via logout+login
  await cli(['logout', '--url', baseURL]);
  await cli(['login', 'admin@m28cli.test', '--url', baseURL], 'm28cli-secret-pass\n');
  // state.project = null (logout menghapus)
  const r = await cli(['records', 'list', 'posts', '--url', baseURL]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no project selected/);
  assert.match(r.stderr, /baseforge use/);

  // --pid override bekerja
  const r2 = await cli(['records', 'list', 'posts', '--pid', projectId, '--url', baseURL]);
  assert.equal(r2.code, 0);
});

test('logout → whoami not logged in', async () => {
  await cli(['use', projectId, '--url', baseURL]);
  const out = await cli(['logout', '--url', baseURL]);
  assert.equal(out.code, 0);
  const who = await cli(['whoami', '--url', baseURL]);
  assert.match(who.stdout, /Not logged in/);
});
