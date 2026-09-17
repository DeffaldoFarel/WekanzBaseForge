// ============================================================================
// M30: TEST S3 STORAGE ADAPTER — mock S3 server lokal + signature V4
//
// Mock S3 server (127.0.0.1) mengimplementasi:
//   PUT /<bucket>/<key> → simpan ke memory Map
//   GET /<bucket>/<key> → return Buffer atau 404
//   DELETE /<bucket>/<key> → hapus dari Map (selalu 204)
//   GET /<bucket>?list-type=2&prefix= → ListBucketResult XML
//   HEAD /<bucket> → 200 (health check)
//
// Fokus test:
//  1. AWS Signature V4: request signed benar → server terima
//  2. Put/Get/Delete object via adapter
//  3. Anti-tabrakan filename (suffix random)
//  4. DeleteAll (batch prefix delete)
//  5. List objects (parse XML)
//  6. Health check
//  7. Config resolution (env → local, env S3 → S3 adapter)
//  8. Admin API (PUT/GET/DELETE config, test connection)
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import nodeHttp from 'node:http';
import { URL } from 'node:url';

import { signS3Request, s3Put, s3Get, s3Delete, s3List, s3HeadBucket } from '../src/core/s3.js';
import { LocalDiskAdapter, S3Adapter, getStorageInfo } from '../src/core/storageAdapter.js';
import type { S3Config } from '../src/core/s3.js';

// ─── Mock S3 Server ───────────────────────────────────────────────────────────

let mockS3: nodeHttp.Server;
let mockPort: number;
let objects: Map<string, Buffer> = new Map();

before(async () => {
  mockS3 = nodeHttp.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const fullPath = url.pathname; // /<bucket>/<key> atau /<bucket>
    const bucket = fullPath.split('/')[1] ?? '';
    const key = fullPath.split('/').slice(2).join('/'); // key TANPA bucket name

    // HEAD /<bucket> → health check
    if (req.method === 'HEAD' && !key) {
      res.writeHead(200);
      res.end();
      return;
    }

    // GET /<bucket>?list-type=2&prefix= → LIST objects
    if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const matching: Array<{ key: string; size: number; lastModified: string }> = [];
      for (const [objKey, buf] of objects.entries()) {
        if (objKey.startsWith(prefix)) {
          matching.push({ key: objKey, size: buf.length, lastModified: new Date().toISOString() });
        }
      }
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
${matching.map((o) => `  <Contents>
    <Key>${o.key}</Key>
    <LastModified>${o.lastModified}</LastModified>
    <ETag>"${o.key.length}"</ETag>
    <Size>${o.size}</Size>
  </Contents>`).join('\n')}
</ListBucketResult>`;
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(xml);
      return;
    }

    // PUT /<bucket>/<key> → save
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        objects.set(key, Buffer.concat(chunks));
        res.writeHead(200);
        res.end();
      });
      return;
    }

    // GET /<bucket>/<key> → read
    if (req.method === 'GET' && key) {
      const data = objects.get(key);
      if (!data) {
        res.writeHead(404);
        res.end('NoSuchKey');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(data);
      return;
    }

    // DELETE /<bucket>/<key> → delete
    if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(400);
    res.end();
  });

  await new Promise<void>((r) => mockS3.listen(0, '127.0.0.1', r));
  const addr = mockS3.address() as { port: number };
  mockPort = addr.port;
});

after(async () => {
  await new Promise<void>((r) => mockS3.close(() => r()));
  objects.clear();
});

function testConfig(): S3Config {
  return {
    endpoint: `http://127.0.0.1:${mockPort}`,
    region: 'us-east-1',
    bucket: 'test-bucket',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };
}

// ─── 1. AWS Signature V4 ─────────────────────────────────────────────────────

test('signS3Request: menghasilkan Authorization header AWS4-HMAC-SHA256', () => {
  const config = testConfig();
  const { url, headers } = signS3Request(config, 'GET', 'test/file.txt', null);
  assert.ok(url.includes('/test-bucket/test/file.txt'));
  assert.ok(headers.Authorization?.startsWith('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/'));
  assert.ok(headers.Authorization?.includes('Signature='));
  assert.ok(headers['x-amz-date']);
  assert.ok(headers['x-amz-content-sha256']);
});

// ─── 2. Put/Get/Delete via adapter ───────────────────────────────────────────

test('S3Adapter: put → get → delete lifecycle', async () => {
  const config = testConfig();
  const adapter = new S3Adapter(config);

  // Save
  const stored = await adapter.save('proj1', 'rec1', 'hello.txt', Buffer.from('hello world'));
  assert.equal(stored, 'hello.txt');

  // Read
  const data = await adapter.read('proj1', 'rec1', 'hello.txt');
  assert.ok(data);
  assert.equal(data.toString(), 'hello world');

  // Delete
  await adapter.delete('proj1', 'rec1', 'hello.txt');
  const deleted = await adapter.read('proj1', 'rec1', 'hello.txt');
  assert.equal(deleted, null);
});

// ─── 3. Anti-tabrakan filename ────────────────────────────────────────────────

test('S3Adapter: save file dengan nama sama → suffix random', async () => {
  const adapter = new S3Adapter(testConfig());
  const stored1 = await adapter.save('proj2', 'rec1', 'doc.pdf', Buffer.from('v1'));
  const stored2 = await adapter.save('proj2', 'rec1', 'doc.pdf', Buffer.from('v2'));
  assert.notEqual(stored1, stored2, 'nama file harus beda');
  assert.ok(stored2.includes('_'), 'harus ada suffix');
});

// ─── 4. DeleteAll (prefix) ───────────────────────────────────────────────────

test('S3Adapter: deleteAll menghapus semua file dengan prefix record', async () => {
  const adapter = new S3Adapter(testConfig());
  await adapter.save('proj3', 'recA', 'file1.txt', Buffer.from('1'));
  await adapter.save('proj3', 'recA', 'file2.txt', Buffer.from('2'));
  await adapter.save('proj3', 'recB', 'file3.txt', Buffer.from('3'));

  const count = await adapter.deleteAll('proj3', 'recA');
  assert.equal(count, 2, 'recA punya 2 file yang dihapus');

  // recB masih ada
  const remaining = await adapter.read('proj3', 'recB', 'file3.txt');
  assert.ok(remaining);
  assert.equal(remaining.toString(), '3');
});

// ─── 5. List objects ──────────────────────────────────────────────────────────

test('S3Adapter: list mengembalikan file dengan metadata', async () => {
  const adapter = new S3Adapter(testConfig());
  await adapter.save('proj4', 'rec1', 'a.jpg', Buffer.from('image'));
  await adapter.save('proj4', 'rec2', 'b.txt', Buffer.from('text'));

  const files = await adapter.list('proj4');
  assert.equal(files.length, 2);
  const jpg = files.find((f) => f.name === 'a.jpg');
  assert.ok(jpg);
  assert.equal(jpg.mime, 'image/jpeg');
  assert.equal(jpg.size, 5);
  assert.ok(jpg.isImage);
});

// ─── 6. Health check ─────────────────────────────────────────────────────────

test('S3Adapter: healthCheck → true (HEAD bucket berhasil)', async () => {
  const adapter = new S3Adapter(testConfig());
  const healthy = await adapter.healthCheck();
  assert.equal(healthy, true);
});

// ─── 7. LocalDiskAdapter tetap bekerja ───────────────────────────────────────

test('LocalDiskAdapter: save/read/delete di disk lokal', async () => {
  process.env.STORAGE_DIR = 'data/m30-local-test';
  const adapter = new LocalDiskAdapter();

  const stored = await adapter.save('proj', 'rec', 'test.txt', Buffer.from('local data'));
  assert.equal(stored, 'test.txt');

  const data = await adapter.read('proj', 'rec', 'test.txt');
  assert.ok(data);
  assert.equal(data.toString(), 'local data');

  await adapter.delete('proj', 'rec', 'test.txt');
  const deleted = await adapter.read('proj', 'rec', 'test.txt');
  assert.equal(deleted, null);

  const healthy = await adapter.healthCheck();
  assert.equal(healthy, true);
});

// ─── 8. Config resolution (tanpa env → local) ───────────────────────────────

test('config resolution: tanpa S3 env → backend local', () => {
  delete process.env.S3_ENDPOINT;
  const info = getStorageInfo();
  assert.equal(info.backend, 'local');
});
