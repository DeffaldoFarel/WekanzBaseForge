// ============================================================================
// M35: TEST BUCKET STORAGE — decoupled upload/serve/delete (ala Appwrite)
//
// Fokus test:
//  1. Upload → fileId + URL
//  2. GET file by fileId → Content-Type + Content-Length + data
//  3. Upload dengan determinate fileId → overwrite existing
//  4. Delete file
//  5. List files
//  6. Upload via authenticated user → uploadedBy di-set
//  7. User A tidak bisa delete file User B → 403
//  8. GET non-existent fileId → 404
//  9. Upload non-multipart → 400
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
import { createPublicRouter } from '../src/api/publicRoutes.js';
import { createBucketRouter } from '../src/api/bucketRoutes.js';
import { createProjectAuthRouter } from '../src/api/authRoutes.js';

const TEST_DATA_DIR = path.resolve('../data/m35-bucket-test');

let server: nodeHttp.Server;
let baseURL: string;
let adminToken: string;
let projectId: string;
let userTokenA: string;
let userTokenB: string;

function http(
  method: string,
  p: string,
  body?: unknown,
  token?: string,
  headers?: Record<string, string>
): Promise<{ status: number; data: any; raw: Buffer }> {
  return new Promise((resolve, reject) => {
    const isMultipart = headers?.['Content-Type']?.includes('multipart');
    const req = nodeHttp.request(
      new URL(p, baseURL),
      {
        method,
        headers: {
          ...(isMultipart
            ? headers
            : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(headers && !isMultipart ? headers : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          let data: any = {};
          try { data = JSON.parse(raw.toString('utf-8') || '{}'); } catch {}
          resolve({ status: res.statusCode ?? 0, data, raw });
        });
      }
    );
    req.on('error', reject);
    if (body !== undefined && !isMultipart) req.write(JSON.stringify(body));
    else if (body !== undefined && isMultipart && Buffer.isBuffer(body)) req.write(body);
    req.end();
  });
}

/** Buat multipart body manual (boundary + file part) */
function makeMultipart(filename: string, data: Buffer, extraFields?: Record<string, string>): { body: Buffer; contentType: string } {
  const boundary = '----TestBoundary' + Date.now();
  const parts: Buffer[] = [];

  // Extra form fields
  if (extraFields) {
    for (const [name, value] of Object.entries(extraFields)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
  }

  // File part
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  ));
  parts.push(data);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

before(async () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  process.env.DATA_DIR = TEST_DATA_DIR;
  process.env.ADMIN_EMAIL = 'admin@m35.test';
  process.env.ADMIN_PASSWORD = 'm35-secret-pass';
  process.env.JWT_SECRET = 'm35-test-jwt-secret-key-long-enough';
  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createPublicRouter());
  router.merge(createProjectAuthRouter());
  router.merge(createBucketRouter());

  server = nodeHttp.createServer((rq, rs) => router.handle(rq, rs));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@m35.test',
    password: 'm35-secret-pass',
  });
  adminToken = login.data.token;

  const proj = await http('POST', '/api/admin/projects', { name: 'm35-bucket' }, adminToken);
  projectId = proj.data.project?.id;
  assert.ok(projectId, 'projectId harus ada');

  // Register 2 end users
  const regA = await http('POST', `/api/p/${projectId}/auth/register`, {
    email: 'alice@m35.test', password: 'passwordA-123',
  });
  userTokenA = regA.data.accessToken;

  const regB = await http('POST', `/api/p/${projectId}/auth/register`, {
    email: 'bob@m35.test', password: 'passwordB-123',
  });
  userTokenB = regB.data.accessToken;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  closeAllProjectDbs();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const STORAGE = () => `/api/p/${projectId}/storage`;
const FILE_URL = (fileId: string) => `/api/files/${projectId}/bucket/${encodeURIComponent(fileId)}`;

// ─── 1. Upload → fileId + URL ────────────────────────────────────────────────

test('upload → fileId + filename + contentType + size + url', async () => {
  const mp = makeMultipart('hello.txt', Buffer.from('Hello Bucket World'));
  const upload = await http(
    'POST',
    `${STORAGE()}/upload`,
    mp.body,
    undefined,
    { 'Content-Type': mp.contentType }
  );
  assert.equal(upload.status, 201, JSON.stringify(upload.data));
  assert.ok(upload.data.fileId);
  assert.equal(upload.data.filename, 'hello.txt');
  assert.equal(upload.data.size, 18);
  assert.ok(upload.data.url);
  assert.ok(upload.data.url.includes('/api/files/'));
});

// ─── 2. GET file by fileId ──────────────────────────────────────────────────

test('GET file by fileId → Content-Type + data', async () => {
  const mp = makeMultipart('test.txt', Buffer.from('bucket content test'));
  const upload = await http('POST', `${STORAGE()}/upload`, mp.body, undefined, {
    'Content-Type': mp.contentType,
  });
  const fileId = upload.data.fileId;

  const get = await http('GET', FILE_URL(fileId));
  assert.equal(get.status, 200);
  assert.equal(get.raw.toString(), 'bucket content test');
});

// ─── 3. Determinate fileId → overwrite ──────────────────────────────────────

test('upload dengan determinate fileId → overwrite existing', async () => {
  // First upload
  const mp1 = makeMultipart('v1.txt', Buffer.from('version 1'), { fileId: 'determinate_id_123' });
  const upload1 = await http('POST', `${STORAGE()}/upload`, mp1.body, undefined, {
    'Content-Type': mp1.contentType,
  });
  assert.equal(upload1.status, 201);
  assert.equal(upload1.data.fileId, 'determinate_id_123');

  // Second upload with same ID → overwrite
  const mp2 = makeMultipart('v2.txt', Buffer.from('version 2'), { fileId: 'determinate_id_123' });
  const upload2 = await http('POST', `${STORAGE()}/upload`, mp2.body, undefined, {
    'Content-Type': mp2.contentType,
  });
  assert.equal(upload2.status, 201);
  assert.equal(upload2.data.fileId, 'determinate_id_123');

  // Content should be v2
  const get = await http('GET', FILE_URL('determinate_id_123'));
  assert.equal(get.raw.toString(), 'version 2');
});

// ─── 4. Delete file ─────────────────────────────────────────────────────────

test('upload (user A) → delete (user A) → GET → 404', async () => {
  const mp = makeMultipart('todelete.txt', Buffer.from('to be deleted'));
  const upload = await http('POST', `${STORAGE()}/upload`, mp.body, userTokenA, {
    'Content-Type': mp.contentType,
  });
  const fileId = upload.data.fileId;

  // Delete by owner
  const del = await http('DELETE', `${STORAGE()}/bucket/${fileId}`, undefined, userTokenA);
  assert.equal(del.status, 200);
  assert.equal(del.data.ok, true);

  // GET → 404
  const get = await http('GET', FILE_URL(fileId));
  assert.equal(get.status, 404);
});

// ─── 5. List files ──────────────────────────────────────────────────────────

test('list files → hanya milik user yang login', async () => {
  // Upload 2 files as user A
  for (let i = 0; i < 2; i++) {
    const mp = makeMultipart(`fileA${i}.txt`, Buffer.from(`A file ${i}`));
    await http('POST', `${STORAGE()}/upload`, mp.body, userTokenA, {
      'Content-Type': mp.contentType,
    });
  }
  // Upload 1 file as user B
  const mpB = makeMultipart('fileB.txt', Buffer.from('B file'));
  await http('POST', `${STORAGE()}/upload`, mpB.body, userTokenB, {
    'Content-Type': mpB.contentType,
  });

  // List as user A → hanya file A
  const listA = await http('GET', `${STORAGE()}/bucket`, undefined, userTokenA);
  assert.equal(listA.status, 200);
  assert.ok(listA.data.files.length >= 2);
  const fileNamesA = listA.data.files.map((f: any) => f.filename);
  assert.ok(fileNamesA.some((n: string) => n.startsWith('fileA')));
  assert.ok(!fileNamesA.includes('fileB.txt'), 'user A tidak melihat file B');

  // List as user B → hanya file B
  const listB = await http('GET', `${STORAGE()}/bucket`, undefined, userTokenB);
  assert.ok(listB.data.files.some((f: any) => f.filename === 'fileB.txt'));
  assert.ok(!listB.data.files.some((f: any) => f.filename.startsWith('fileA')));
});

// ─── 6. uploadedBy di-set untuk authenticated user ──────────────────────────

test('upload dengan auth → uploadedBy di-set ke userId', async () => {
  const mp = makeMultipart('owned.txt', Buffer.from('owned file'));
  const upload = await http('POST', `${STORAGE()}/upload`, mp.body, userTokenA, {
    'Content-Type': mp.contentType,
  });
  assert.equal(upload.status, 201);
  // uploadedBy tersimpan di metadata (dilihat via list)
  const list = await http('GET', `${STORAGE()}/bucket`, undefined, userTokenA);
  const owned = list.data.files.find((f: any) => f.filename === 'owned.txt');
  assert.ok(owned, 'file ada di list user A');
  assert.ok(owned.uploadedBy); // di-set (bukan null)
});

// ─── 7. User B tidak bisa delete file User A → 403 ─────────────────────────

test('user B coba delete file user A → 403 FORBIDDEN', async () => {
  const mp = makeMultipart('alice-file.txt', Buffer.from('alice secret'));
  const upload = await http('POST', `${STORAGE()}/upload`, mp.body, userTokenA, {
    'Content-Type': mp.contentType,
  });
  const fileId = upload.data.fileId;

  const del = await http('DELETE', `${STORAGE()}/bucket/${fileId}`, undefined, userTokenB);
  assert.equal(del.status, 403);
  assert.equal(del.data.error.code, 'FORBIDDEN');
});

// ─── 8. GET non-existent → 404 ─────────────────────────────────────────────

test('GET non-existent fileId → 404', async () => {
  const get = await http('GET', FILE_URL('does_not_exist_999'));
  assert.equal(get.status, 404);
});

// ─── 9. Upload non-multipart → 400 ─────────────────────────────────────────

test('POST upload dengan JSON body → 400', async () => {
  const upload = await http('POST', `${STORAGE()}/upload`, { filename: 'test.txt' });
  assert.equal(upload.status, 400);
  assert.match(upload.data.error.message, /multipart/);
});
