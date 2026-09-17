// ============================================================================
// M29: TEST VECTOR SEARCH — field type, math, search engine, API endpoint
//
// Fokus:
//  1. Unit: cosine similarity (identical/orthogonal/opposite), L2, normalize
//  2. Field type: create collection dengan vector field + dimensions
//  3. Validasi: wrong dims, non-numeric, empty array ditolak
//  4. Search end-to-end: query vector → top-k ranking benar
//  5. Pre-filter: hanya record yang lolos filter yang discan
//  6. Threshold: minScore memangkas hasil
//  7. k limit: maksimal k hasil
//  8. Multiple vector fields: pilih field yang benar
//  9. listRule dievaluasi (security parity dengan aggregate M19)
// 10. Metric L2 vs cosine menghasilkan ranking berbeda
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
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';
import { createPublicRouter } from '../src/api/publicRoutes.js';
import { cosineSimilarity, euclideanDistance, normalizeVector, validateVector } from '../src/core/vector.js';

const TEST_DATA_DIR = path.resolve('../data/m29-vector-test');

let server: nodeHttp.Server;
let baseURL: string;
let adminToken: string;
let projectId: string;

function http(
  method: string,
  p: string,
  body?: unknown,
  token?: string,
  headers?: Record<string, string>
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const req = nodeHttp.request(
      new URL(p, baseURL),
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(headers ?? {}),
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
  process.env.ADMIN_EMAIL = 'admin@m29.test';
  process.env.ADMIN_PASSWORD = 'm29-secret-pass';
  process.env.JWT_SECRET = 'm29-test-jwt-secret-key-long-enough';
  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());
  router.merge(createPublicRouter());

  server = nodeHttp.createServer((rq, rs) => router.handle(rq, rs));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  baseURL = `http://127.0.0.1:${addr.port}`;

  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@m29.test',
    password: 'm29-secret-pass',
  });
  adminToken = login.data.token;

  const proj = await http('POST', '/api/admin/projects', { name: 'm29-vec' }, adminToken);
  projectId = proj.data.project.id;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  closeAllProjectDbs();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─── 1. Unit: math ──────────────────────────────────────────────────────────

test('unit: cosine similarity — identical=1, orthogonal=0, opposite=-1', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-10, 'identical → 1');
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1]) - 0) < 1e-10, 'orthogonal → 0');
  assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) - (-1)) < 1e-10, 'opposite → -1');
  assert.ok(Math.abs(cosineSimilarity([0, 0], [1, 1]) - 0) < 1e-10, 'zero vector → 0');
});

test('unit: euclidean distance + normalize', () => {
  assert.ok(Math.abs(euclideanDistance([0, 0], [3, 4]) - 5) < 1e-10, '3-4-5 triangle');
  assert.ok(euclideanDistance([1, 1], [1, 1]) === 0, 'identical → 0');
  const norm = normalizeVector([3, 4]);
  assert.ok(Math.abs(norm[0] - 0.6) < 1e-10 && Math.abs(norm[1] - 0.8) < 1e-10);
  // setelah normalize, ||v|| = 1
  const magnitude = Math.sqrt(norm.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(magnitude - 1) < 1e-10);
});

test('unit: validateVector — dims mismatch, non-numeric, valid', () => {
  assert.deepEqual(validateVector([1, 2, 3], 3), [1, 2, 3]);
  assert.deepEqual(validateVector([1, 2], 3), []); // wrong dims
  assert.deepEqual(validateVector([1, 'a', 3], 3), []); // non-numeric
  assert.deepEqual(validateVector([1, NaN, 3], 3), []); // NaN
  assert.deepEqual(validateVector([1, Infinity, 3], 3), []); // Infinity
  assert.deepEqual(validateVector('not-array', 3), []); // wrong type
  assert.deepEqual(validateVector([1, 2, 3], 0), [1, 2, 3]); // no dims constraint
});

// ─── 2-3. Field type + validasi ──────────────────────────────────────────────

test('field type vector: create collection + dimensions validasi', async () => {
  const col = await http(
    'POST',
    `/api/admin/projects/${projectId}/collections`,
    {
      name: 'docs',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'embedding', type: 'vector', options: { dimensions: 3 } },
      ],
      rules: { listRule: '', viewRule: '', createRule: '' },
    },
    adminToken
  );
  assert.equal(col.status, 201, JSON.stringify(col.data));

  // Valid record dengan vector
  const rec = await http('POST', `/api/p/${projectId}/collections/docs/records`, {
    title: 'hello world',
    embedding: [0.1, 0.2, 0.3],
  });
  assert.equal(rec.status, 201, JSON.stringify(rec.data));

  // Wrong dims → 400
  const bad1 = await http('POST', `/api/p/${projectId}/collections/docs/records`, {
    title: 'bad dims',
    embedding: [0.1, 0.2],
  });
  assert.equal(bad1.status, 400);
  assert.match(bad1.data.error.message, /3 dimensions/);

  // Non-numeric → 400
  const bad2 = await http('POST', `/api/p/${projectId}/collections/docs/records`, {
    title: 'bad type',
    embedding: [0.1, 'x', 0.3],
  });
  assert.equal(bad2.status, 400);
});

// ─── 4. Search end-to-end ────────────────────────────────────────────────────

test('search: query vector → top-k ranking benar (cosine)', async () => {
  // Seed: 5 dokumen dengan embedding 3D yang jelas arahnya
  const docs = [
    { title: 'east', embedding: [1, 0, 0] },     // → query [1,0,0] score=1.0
    { title: 'north-east', embedding: [0.7, 0.7, 0] }, // → score≈0.707
    { title: 'north', embedding: [0, 1, 0] },     // → score=0.0 (ortogonal)
    { title: 'west', embedding: [-1, 0, 0] },     // → score=-1.0 (opposite)
    { title: 'up', embedding: [0, 0, 1] },        // → score=0.0
  ];
  for (const d of docs) {
    await http('POST', `/api/p/${projectId}/collections/docs/records`, d);
  }

  const search = await http('POST', `/api/p/${projectId}/collections/docs/vector-search`, {
    vector: [1, 0, 0], // cari dokumen yang "mengarah ke timur"
    k: 3,
  });
  assert.equal(search.status, 200, JSON.stringify(search.data));
  assert.equal(search.data.items.length, 3, 'k=3');
  // 6 total: 1 dari test "field type" + 5 baru
  assert.equal(search.data.totalSearched, 6);
  assert.equal(search.data.metric, 'cosine');
  assert.equal(search.data.vectorField, 'embedding');

  // Ranking: east > north-east > (north | up)
  assert.equal(search.data.items[0].record.title, 'east');
  assert.ok(search.data.items[0].score > 0.99, 'east score ≈ 1');
  assert.equal(search.data.items[1].record.title, 'north-east');
  assert.ok(search.data.items[1].score > 0.69 && search.data.items[1].score < 0.72);
});

// ─── 5. Pre-filter ───────────────────────────────────────────────────────────

test('search: pre-filter membatasi record yang discan', async () => {
  // Tambah record dengan tag
  const col2 = await http(
    'POST',
    `/api/admin/projects/${projectId}/collections`,
    {
      name: 'articles',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'category', type: 'text' },
        { name: 'vec', type: 'vector' },
      ],
      rules: { listRule: '', viewRule: '', createRule: '' },
    },
    adminToken
  );
  assert.equal(col2.status, 201);

  const articles = [
    { title: 'tech 1', category: 'tech', vec: [1, 0] },
    { title: 'tech 2', category: 'tech', vec: [0.9, 0.1] },
    { title: 'food 1', category: 'food', vec: [1, 0] },
    { title: 'food 2', category: 'food', vec: [0.1, 0.9] },
  ];
  for (const a of articles) {
    await http('POST', `/api/p/${projectId}/collections/articles/records`, a);
  }

  const search = await http('POST', `/api/p/${projectId}/collections/articles/vector-search`, {
    vector: [1, 0],
    k: 10,
    filter: "category = 'tech'",
  });
  assert.equal(search.status, 200);
  assert.equal(search.data.totalSearched, 2, 'hanya 2 article tech yang discan');
  assert.ok(search.data.items.every((i: any) => i.record.category === 'tech'));
});

// ─── 6. Threshold ────────────────────────────────────────────────────────────

test('search: minScore memangkas hasil di bawah threshold', async () => {
  const search = await http('POST', `/api/p/${projectId}/collections/articles/vector-search`, {
    vector: [1, 0],
    k: 10,
    minScore: 0.8,
  });
  assert.equal(search.status, 200);
  assert.ok(search.data.items.every((i: any) => i.score >= 0.8));
  // food 2 ([0.1, 0.9]) → score ≈ 0.1 → harus terpangkas
  assert.ok(!search.data.items.some((i: any) => i.record.title === 'food 2'));
});

// ─── 7. k limit ──────────────────────────────────────────────────────────────

test('search: k=1 → hanya 1 hasil; k default 10; k max 100', async () => {
  const s1 = await http('POST', `/api/p/${projectId}/collections/articles/vector-search`, {
    vector: [1, 0],
    k: 1,
  });
  assert.equal(s1.data.items.length, 1);

  const sDefault = await http('POST', `/api/p/${projectId}/collections/articles/vector-search`, {
    vector: [1, 0],
  });
  assert.equal(sDefault.data.items.length, 4); // semua (hanya 4 article)

  // k=200 → dibatasi 100 (totalSearched tetap 4 di test ini)
  const sMax = await http('POST', `/api/p/${projectId}/collections/articles/vector-search`, {
    vector: [1, 0],
    k: 200,
  });
  assert.equal(sMax.status, 200);
  assert.equal(sMax.data.items.length, 4); // hanya ada 4
});

// ─── 8. Multiple vector fields ───────────────────────────────────────────────

test('search: multiple vector fields — pilih field yang benar', async () => {
  const col3 = await http(
    'POST',
    `/api/admin/projects/${projectId}/collections`,
    {
      name: 'multi_vec',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'vec_a', type: 'vector' },
        { name: 'vec_b', type: 'vector' },
      ],
      rules: { listRule: '' },
    },
    adminToken
  );
  assert.equal(col3.status, 201);

  await http('POST', `/api/p/${projectId}/collections/multi_vec/records`, {
    title: 'item1',
    vec_a: [1, 0],
    vec_b: [0, 1],
  });

  // Default: field pertama (vec_a)
  const sDefault = await http('POST', `/api/p/${projectId}/collections/multi_vec/vector-search`, {
    vector: [1, 0],
  });
  assert.equal(sDefault.data.vectorField, 'vec_a');

  // Eksplisit: vec_b
  const sB = await http('POST', `/api/p/${projectId}/collections/multi_vec/vector-search`, {
    vector: [0, 1],
    field: 'vec_b',
  });
  assert.equal(sB.data.vectorField, 'vec_b');

  // Field yang bukan vector → error
  const sBad = await http('POST', `/api/p/${projectId}/collections/multi_vec/vector-search`, {
    vector: [1, 0],
    field: 'title',
  });
  assert.equal(sBad.status, 400);
  assert.match(sBad.data.error.message, /not a vector field/);
});

// ─── 9. listRule (security) ──────────────────────────────────────────────────

test('search: listRule menutup akses — anonymous tidak bisa scan (parity M19)', async () => {
  const col4 = await http(
    'POST',
    `/api/admin/projects/${projectId}/collections`,
    {
      name: 'private_vec',
      fields: [
        { name: 'title', type: 'text' },
        { name: 'embedding', type: 'vector' },
      ],
      // TIDAK set rules → default null = admin only
    },
    adminToken
  );
  assert.equal(col4.status, 201);

  await http('POST', `/api/p/${projectId}/collections/private_vec/records`, {
    title: 'secret',
    embedding: [1, 0],
  });

  // Anonymous → listRule null → TIDAK boleh scan (info bocor via similarity)
  const anonSearch = await http('POST', `/api/p/${projectId}/collections/private_vec/vector-search`, {
    vector: [1, 0],
  });
  assert.equal(anonSearch.status, 200);
  assert.equal(anonSearch.data.items.length, 0, 'anonymous → 0 hasil (listRule null)');
  assert.equal(anonSearch.data.totalSearched, 0);
});

// ─── 10. Metric L2 ───────────────────────────────────────────────────────────

test('search: metric=l2 menghasilkan skor 1/(1+distance)', async () => {
  const search = await http('POST', `/api/p/${projectId}/collections/articles/vector-search`, {
    vector: [1, 0],
    metric: 'l2',
    k: 4,
  });
  assert.equal(search.status, 200);
  assert.equal(search.data.metric, 'l2');
  // Semua artikel dengan vec=[1,0] → distance 0 → score 1.0
  // tech 1 dan food 1 keduanya punya [1,0] → score = 1.0 (tie)
  assert.ok(Math.abs(search.data.items[0].score - 1.0) < 1e-10, 'top score = 1.0 (distance 0)');
  assert.ok(
    search.data.items[0].record.title === 'tech 1' || search.data.items[0].record.title === 'food 1',
    'tie antara tech 1 dan food 1 (keduanya [1,0])'
  );
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

test('search: collection tanpa vector field → error jelas', async () => {
  const col5 = await http(
    'POST',
    `/api/admin/projects/${projectId}/collections`,
    { name: 'no_vec', fields: [{ name: 'title', type: 'text' }], rules: { listRule: '' } },
    adminToken
  );
  assert.equal(col5.status, 201, `create no_vec: ${JSON.stringify(col5.data)}`);

  const search = await http('POST', `/api/p/${projectId}/collections/no_vec/vector-search`, {
    vector: [1, 0],
  });
  assert.equal(search.status, 400, `search no_vec: ${JSON.stringify(search.data)}`);
  assert.match(
    search.data.error?.message ?? '',
    /no vector fields/,
    `error message: ${JSON.stringify(search.data)}`
  );
});

test('search: body tanpa vector → 400; dims tidak cocok → 400', async () => {
  const noVec = await http('POST', `/api/p/${projectId}/collections/docs/vector-search`, {});
  assert.equal(noVec.status, 400);

  const wrongDims = await http('POST', `/api/p/${projectId}/collections/docs/vector-search`, {
    vector: [1, 2], // collection butuh 3 dims
  });
  assert.equal(wrongDims.status, 400);
});
