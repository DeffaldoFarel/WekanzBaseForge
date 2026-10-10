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
import { initPlatformDb, closePlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { getProjectDb } from '../src/core/projectDbManager.js';
import { Router } from '../src/core/router.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createPublicRouter } from '../src/api/publicRoutes.js';
import { createBucketRouter } from '../src/api/bucketRoutes.js';
import { createProjectAuthRouter } from '../src/api/authRoutes.js';
import { createApiKey } from '../src/auth/apiKeys.js';
import { bucketUpload } from '../src/core/bucketStorage.js';
import { getStorageAdapter } from '../src/core/storageAdapter.js';

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
  // Windows: rmSync gagal EPERM selama handle platform.db masih terbuka.
  closePlatformDb();
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
    userTokenA,
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
  const upload = await http('POST', `${STORAGE()}/upload`, mp.body, userTokenA, {
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
  const upload1 = await http('POST', `${STORAGE()}/upload`, mp1.body, userTokenA, {
    'Content-Type': mp1.contentType,
  });
  assert.equal(upload1.status, 201);
  assert.equal(upload1.data.fileId, 'determinate_id_123');

  // Second upload with same ID → overwrite
  const mp2 = makeMultipart('v2.txt', Buffer.from('version 2'), { fileId: 'determinate_id_123' });
  const upload2 = await http('POST', `${STORAGE()}/upload`, mp2.body, userTokenA, {
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
  const upload = await http('POST', `${STORAGE()}/upload`, { filename: 'test.txt' }, userTokenA);
  assert.equal(upload.status, 400);
  assert.match(upload.data.error.message, /multipart/);
});

test('security: unauthenticated users cannot upload files or list bucket metadata', async () => {
  const mp = makeMultipart('anonymous.txt', Buffer.from('not stored'));
  const upload = await http('POST', `${STORAGE()}/upload`, mp.body, undefined, {
    'Content-Type': mp.contentType,
  });
  assert.equal(upload.status, 401, JSON.stringify(upload.data));
  const list = await http('GET', `${STORAGE()}/bucket`);
  assert.equal(list.status, 401, JSON.stringify(list.data));
});

test('security: invalid Bearer tokens fail loudly on upload and bucket list', async () => {
  const mp = makeMultipart('invalid.txt', Buffer.from('not stored'));
  const upload = await http('POST', `${STORAGE()}/upload`, mp.body, 'invalid-token', {
    'Content-Type': mp.contentType,
  });
  assert.equal(upload.status, 401, JSON.stringify(upload.data));
  const list = await http('GET', `${STORAGE()}/bucket`, undefined, 'invalid-token');
  assert.equal(list.status, 401, JSON.stringify(list.data));
});

test('security: invalid Bearer and read-only service key cannot delete bucket files', async () => {
  const fileId = 'protected_delete_auth';
  const mp = makeMultipart('protected.txt', Buffer.from('keep me'), { fileId });
  assert.equal((await http('POST', `${STORAGE()}/upload`, mp.body, userTokenA, {
    'Content-Type': mp.contentType,
  })).status, 201);
  const invalid = await http('DELETE', `${STORAGE()}/bucket/${fileId}`, undefined, 'invalid-token');
  assert.equal(invalid.status, 401, JSON.stringify(invalid.data));
  const readKey = createApiKey(getProjectDb(projectId), { name: 'read-only delete fixture', scope: 'read' }).key;
  const insufficient = await http('DELETE', `${STORAGE()}/bucket/${fileId}`, undefined, undefined, {
    'X-API-Key': readKey,
  });
  assert.equal(insufficient.status, 403, JSON.stringify(insufficient.data));
  assert.equal((await http('GET', FILE_URL(fileId))).raw.toString(), 'keep me');
});

test('security: another user cannot overwrite a known fileId or its contents', async () => {
  const fileId = 'owned_by_alice_security';
  const original = makeMultipart('owned.txt', Buffer.from('original contents'), { fileId });
  assert.equal((await http('POST', `${STORAGE()}/upload`, original.body, userTokenA, {
    'Content-Type': original.contentType,
  })).status, 201);
  const replacement = makeMultipart('owned.txt', Buffer.from('attacker contents'), { fileId });
  const denied = await http('POST', `${STORAGE()}/upload`, replacement.body, userTokenB, {
    'Content-Type': replacement.contentType,
  });
  assert.equal(denied.status, 403, JSON.stringify(denied.data));
  assert.equal((await http('GET', FILE_URL(fileId))).raw.toString(), 'original contents');
});

test('security: in-flight owner overwrite cannot expose an empty owner slot for another user', async () => {
  const fileId = 'owned_race_security';
  const first = makeMultipart('owned.txt', Buffer.from('initial contents'), { fileId });
  assert.equal((await http('POST', `${STORAGE()}/upload`, first.body, userTokenA, {
    'Content-Type': first.contentType,
  })).status, 201);

  const adapter = getStorageAdapter();
  const originalSave = adapter.save;
  let ownerReachedGap!: () => void;
  let allowOwnerToSave!: () => void;
  const atGap = new Promise<void>((resolve) => { ownerReachedGap = resolve; });
  const releaseOwner = new Promise<void>((resolve) => { allowOwnerToSave = resolve; });
  adapter.save = async function (...args) {
    if (args[1] === fileId && args[3].toString() === 'owner replacement') {
      ownerReachedGap();
      await releaseOwner;
    }
    return originalSave.apply(this, args);
  };
  try {
    const owner = makeMultipart('owned.txt', Buffer.from('owner replacement'), { fileId });
    const ownerRequest = http('POST', `${STORAGE()}/upload`, owner.body, userTokenA, {
      'Content-Type': owner.contentType,
    });
    await atGap; // deterministic moment while the owner's physical write is pending
    const attacker = makeMultipart('owned.txt', Buffer.from('attacker replacement'), { fileId });
    const attackerResponse = await http('POST', `${STORAGE()}/upload`, attacker.body, userTokenB, {
      'Content-Type': attacker.contentType,
    });
    allowOwnerToSave();
    const ownerResponse = await ownerRequest;
    assert.equal(attackerResponse.status, 403, JSON.stringify(attackerResponse.data));
    assert.equal(ownerResponse.status, 201, JSON.stringify(ownerResponse.data));
    assert.equal((await http('GET', FILE_URL(fileId))).raw.toString(), 'owner replacement');
  } finally {
    allowOwnerToSave();
    adapter.save = originalSave;
  }
});

test('security: delete racing with a new upload cannot remove the newly stored file', async () => {
  const fileId = 'delete_race_security';
  const initial = makeMultipart('initial.txt', Buffer.from('old content'), { fileId });
  assert.equal((await http('POST', `${STORAGE()}/upload`, initial.body, userTokenA, {
    'Content-Type': initial.contentType,
  })).status, 201);
  const adapter = getStorageAdapter();
  const originalDelete = adapter.delete;
  let reachedPhysicalDelete!: () => void;
  let releasePhysicalDelete!: () => void;
  const atDelete = new Promise<void>(resolve => { reachedPhysicalDelete = resolve; });
  const resumeDelete = new Promise<void>(resolve => { releasePhysicalDelete = resolve; });
  let firstDeletePaused = false;
  adapter.delete = async function (...args) {
    if (!firstDeletePaused && args[1] === fileId && args[2].endsWith('.txt')) {
      firstDeletePaused = true;
      reachedPhysicalDelete();
      await resumeDelete;
    }
    return originalDelete.apply(this, args);
  };
  try {
    const deletion = http('DELETE', `${STORAGE()}/bucket/${fileId}`, undefined, userTokenA);
    await atDelete;
    const replacement = makeMultipart('new.txt', Buffer.from('new content'), { fileId });
    const uploaded = await http('POST', `${STORAGE()}/upload`, replacement.body, userTokenA, {
      'Content-Type': replacement.contentType,
    });
    releasePhysicalDelete();
    const deleted = await deletion;
    assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
    const view = await http('GET', FILE_URL(fileId));
    assert.equal(view.status, 200);
    assert.equal(view.raw.toString(), 'new content');
  } finally {
    releasePhysicalDelete();
    adapter.delete = originalDelete;
  }
});

test('security: two first uploads of a known ID cannot overwrite each other or leave a claimable orphan', async () => {
  const fileId = 'fresh_race_security';
  const adapter = getStorageAdapter();
  const originalSave = adapter.save;
  let firstAtSave!: () => void;
  let releaseFirst!: () => void;
  const paused = new Promise<void>(resolve => { firstAtSave = resolve; });
  const resume = new Promise<void>(resolve => { releaseFirst = resolve; });
  adapter.save = async function (...args) {
    if (args[1] === fileId && args[3].toString() === 'first content') {
      firstAtSave();
      await resume;
    }
    return originalSave.apply(this, args);
  };
  try {
    const first = makeMultipart('initial.txt', Buffer.from('first content'), { fileId });
    const firstWrite = http('POST', `${STORAGE()}/upload`, first.body, userTokenA, {
      'Content-Type': first.contentType,
    });
    await paused;
    const second = makeMultipart('winner.txt', Buffer.from('second content'), { fileId });
    const secondWrite = await http('POST', `${STORAGE()}/upload`, second.body, userTokenB, {
      'Content-Type': second.contentType,
    });
    releaseFirst();
    const firstResult = await firstWrite;
    assert.equal(secondWrite.status, 201, JSON.stringify(secondWrite.data));
    assert.equal(firstResult.status, 409, JSON.stringify(firstResult.data));
    const result = await http('GET', FILE_URL(fileId));
    assert.equal(result.status, 200);
    assert.equal(result.raw.toString(), 'second content');
    const physical = await adapter.list(projectId);
    assert.equal(physical.filter(f => f.storedName.startsWith(`${fileId}_`)).length, 1);
  } finally {
    releaseFirst();
    adapter.save = originalSave;
  }
});

test('security: user cannot delete a legacy file without an assigned owner', async () => {
  const fileId = 'legacy_unowned_security';
  await bucketUpload(getProjectDb(projectId), projectId, {
    filename: 'legacy.txt', data: Buffer.from('legacy contents'), fileId, uploadedBy: null,
  });
  const denied = await http('DELETE', `${STORAGE()}/bucket/${fileId}`, undefined, userTokenA);
  assert.equal(denied.status, 403, JSON.stringify(denied.data));
  assert.equal((await http('GET', FILE_URL(fileId))).raw.toString(), 'legacy contents');
});

test('security: service-owned legacy files stay protected from a normal user overwrite', async () => {
  const fileId = 'legacy_unowned_overwrite';
  await bucketUpload(getProjectDb(projectId), projectId, {
    filename: 'legacy.txt', data: Buffer.from('legacy contents'), fileId, uploadedBy: null,
  });
  const mp = makeMultipart('legacy.txt', Buffer.from('attacker contents'), { fileId });
  const denied = await http('POST', `${STORAGE()}/upload`, mp.body, userTokenA, {
    'Content-Type': mp.contentType,
  });
  assert.equal(denied.status, 403, JSON.stringify(denied.data));
  assert.equal((await http('GET', FILE_URL(fileId))).raw.toString(), 'legacy contents');
});

test('security: wrong-project user tokens cannot list, upload, or delete bucket files', async () => {
  const original = makeMultipart('cross-project.txt', Buffer.from('owned'), { fileId: 'cross_project_file' });
  assert.equal((await http('POST', `${STORAGE()}/upload`, original.body, userTokenA, {
    'Content-Type': original.contentType,
  })).status, 201);
  const { signToken } = await import('../src/auth/jwt.js');
  const foreignToken = await signToken({ sub: 'user_from_unrelated_project' }, 60);
  const deniedList = await http('GET', `${STORAGE()}/bucket`, undefined, foreignToken);
  assert.equal(deniedList.status, 401, JSON.stringify(deniedList.data));
  const deniedUpload = await http('POST', `${STORAGE()}/upload`, original.body, foreignToken, {
    'Content-Type': original.contentType,
  });
  assert.equal(deniedUpload.status, 401, JSON.stringify(deniedUpload.data));
  const deniedDelete = await http('DELETE', `${STORAGE()}/bucket/cross_project_file`, undefined, foreignToken);
  assert.equal(deniedDelete.status, 401, JSON.stringify(deniedDelete.data));
  assert.equal((await http('GET', FILE_URL('cross_project_file'))).raw.toString(), 'owned');
});

test('security: stale admin delete cannot remove a newer bucket version', async () => {
  const fileId = 'stale_admin_delete';
  const original = makeMultipart('first.txt', Buffer.from('old'), { fileId });
  assert.equal((await http('POST', `${STORAGE()}/upload`, original.body, userTokenA, {
    'Content-Type': original.contentType,
  })).status, 201);
  const db = getProjectDb(projectId);
  const oldVersion = (db.prepare('SELECT stored_name FROM _bucket_files WHERE file_id = ?').get(fileId) as { stored_name: string }).stored_name;
  const newer = makeMultipart('second.txt', Buffer.from('new'), { fileId });
  assert.equal((await http('POST', `${STORAGE()}/upload`, newer.body, userTokenA, {
    'Content-Type': newer.contentType,
  })).status, 201);
  const stale = await http('DELETE', `/api/admin/projects/${projectId}/storage/bucket/${fileId}`,
    undefined, adminToken, { 'X-Expected-Stored-Name': oldVersion });
  assert.equal(stale.status, 409, JSON.stringify(stale.data));
  assert.equal((await http('GET', FILE_URL(fileId))).raw.toString(), 'new');
});

test('security: same subject from a different project cannot access this bucket', async () => {
  const { signToken, verifyToken } = await import('../src/auth/jwt.js');
  const verified = await verifyToken(userTokenA);
  assert.equal(verified.valid, true);
  assert.equal(verified.payload?.projectId, projectId, 'issued access token must bind to project');
  const forgedProject = await signToken({
    sub: String(verified.payload?.sub), projectId: 'unrelated_project',
  }, 60);
  const list = await http('GET', `${STORAGE()}/bucket`, undefined, forgedProject);
  assert.equal(list.status, 401, JSON.stringify(list.data));
  const upload = makeMultipart('wrong-project.txt', Buffer.from('not stored'));
  assert.equal((await http('POST', `${STORAGE()}/upload`, upload.body, forgedProject, {
    'Content-Type': upload.contentType,
  })).status, 401);
  const existing = makeMultipart('owner.txt', Buffer.from('owned'), { fileId: 'same_sub_cross_project' });
  assert.equal((await http('POST', `${STORAGE()}/upload`, existing.body, userTokenA, {
    'Content-Type': existing.contentType,
  })).status, 201);
  assert.equal((await http('DELETE', `${STORAGE()}/bucket/same_sub_cross_project`, undefined, forgedProject)).status, 401);
});

test('security: valid service key is project-scoped and a read key cannot upload', async () => {
  const db = getProjectDb(projectId);
  const readKey = createApiKey(db, { name: 'read bucket fixture', scope: 'read' }).key;
  const writeKey = createApiKey(db, { name: 'write bucket fixture', scope: 'write' }).key;
  const mp = makeMultipart('service.txt', Buffer.from('service contents'));
  const denied = await http('POST', `${STORAGE()}/upload`, mp.body, undefined, {
    'Content-Type': mp.contentType, 'X-API-Key': readKey,
  });
  assert.equal(denied.status, 403, JSON.stringify(denied.data));
  const created = await http('POST', `${STORAGE()}/upload`, mp.body, undefined, {
    'Content-Type': mp.contentType, 'X-API-Key': writeKey,
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const list = await http('GET', `${STORAGE()}/bucket`, undefined, undefined, { 'X-API-Key': readKey });
  assert.equal(list.status, 200, JSON.stringify(list.data));
  assert.ok(list.data.files.some((f: { fileId: string }) => f.fileId === created.data.fileId));
  const invalid = await http('GET', `${STORAGE()}/bucket`, undefined, undefined, { 'X-API-Key': 'bf_invalid' });
  assert.equal(invalid.status, 401, JSON.stringify(invalid.data));
});
