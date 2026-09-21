// ============================================================================
// M19: TEST EXPAND API — menyambung relations.ts yang sebelumnya yatim
//
// Sebelum M19: route MENGIRIM `expand` tetapi ListOptions tidak memilikinya,
// jadi opsi dibuang diam-diam. Klien menerima HTTP 200 tanpa key `expand`
// dan mengira berhasil — gagal senyap.
//
// Test ini memverifikasi lewat HTTP (bukan memanggil core langsung), karena
// justru pemanggilan langsung itulah yang membuat bug ini lolos 300 test.
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import nodeHttp from 'node:http';
import { initPlatformDb, closePlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { Router } from '../src/core/router.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';
import { createProjectAuthRouter } from '../src/api/authRoutes.js';
import { createPublicRouter } from '../src/api/publicRoutes.js';

const TEST_DATA_DIR = path.resolve('../data/m19-expand-test');

let server: nodeHttp.Server;
let baseURL: string;
let adminToken: string;
let projectId: string;
let P: string;
let authorId: string;
let publisherId: string;
let bookIdWithAuthor: string;

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
        let raw = '';
        res.setEncoding('utf-8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let data: any = null;
          try {
            data = JSON.parse(raw);
          } catch {
            data = raw;
          }
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
  process.env.STORAGE_DIR = path.join(TEST_DATA_DIR, 'storage');
  process.env.ADMIN_EMAIL = 'admin@m19exp.test';
  process.env.ADMIN_PASSWORD = 'm19-expand-pass';
  process.env.JWT_SECRET = 'm19-expand-jwt-secret-key-long-enough';
  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());
  router.merge(createProjectAuthRouter());
  router.merge(createPublicRouter());

  server = nodeHttp.createServer((req, res) => router.handle(req, res));
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseURL = `http://127.0.0.1:${port}`;

  const login = await http('POST', '/api/admin/auth/login', {
    email: 'admin@m19exp.test',
    password: 'm19-expand-pass',
  });
  assert.equal(login.status, 200);
  adminToken = login.data.token;

  const proj = await http('POST', '/api/admin/projects', { name: 'm19-expand' }, adminToken);
  assert.equal(proj.status, 201);
  projectId = proj.data.project?.id ?? proj.data.id;
  P = `/api/admin/projects/${projectId}`;

  // ── publishers (level 2 untuk nested expand) ──
  const pubCol = await http(
    'POST',
    `${P}/collections`,
    { name: 'publishers', fields: [{ name: 'nama', type: 'text' }], rules: { listRule: '', viewRule: '' } },
    adminToken
  );
  assert.equal(pubCol.status, 201);

  // ── authors → relation ke publishers ──
  const authCol = await http(
    'POST',
    `${P}/collections`,
    {
      name: 'authors',
      fields: [
        { name: 'nama', type: 'text' },
        { name: 'publisher', type: 'relation', options: { collectionId: 'publishers' } },
      ],
      rules: { listRule: '', viewRule: '' },
    },
    adminToken
  );
  assert.equal(authCol.status, 201);

  // ── books → relation ke authors + multi-relation tags ──
  const bookCol = await http(
    'POST',
    `${P}/collections`,
    {
      name: 'books',
      fields: [
        { name: 'judul', type: 'text' },
        { name: 'author', type: 'relation', options: { collectionId: 'authors' } },
        { name: 'kontributor', type: 'relation', options: { collectionId: 'authors', maxSelect: 5 } },
      ],
      rules: { listRule: '', viewRule: '' },
    },
    adminToken
  );
  assert.equal(bookCol.status, 201);

  // ── seed ──
  const pub = await http('POST', `${P}/collections/publishers/records`, { nama: 'Bentang' }, adminToken);
  assert.equal(pub.status, 201);
  publisherId = pub.data.record.id;

  const au = await http(
    'POST',
    `${P}/collections/authors/records`,
    { nama: 'Andrea Hirata', publisher: publisherId },
    adminToken
  );
  assert.equal(au.status, 201);
  authorId = au.data.record.id;

  const au2 = await http(
    'POST',
    `${P}/collections/authors/records`,
    { nama: 'Tere Liye', publisher: publisherId },
    adminToken
  );
  assert.equal(au2.status, 201);
  const author2Id = au2.data.record.id;

  const bk = await http(
    'POST',
    `${P}/collections/books/records`,
    { judul: 'Laskar Pelangi', author: authorId, kontributor: [authorId, author2Id] },
    adminToken
  );
  assert.equal(bk.status, 201, `seed book gagal: ${JSON.stringify(bk.data)}`);
  bookIdWithAuthor = bk.data.record.id;

  // satu buku TANPA relasi (membuktikan expand tidak crash saat null)
  const bk2 = await http('POST', `${P}/collections/books/records`, { judul: 'Buku Yatim' }, adminToken);
  assert.equal(bk2.status, 201);
});

after(() => {
  closeAllProjectDbs();
  // Windows: rmSync gagal EPERM selama handle platform.db masih terbuka.
  closePlatformDb();
  server?.close();
  setTimeout(() => {
    try {
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }, 100);
});

// ════════════════════════════════════════════════════════════════════════════

test('M19: expand di list mengisi key `expand` (sebelumnya dibuang diam-diam)', async () => {
  const res = await http(
    'GET',
    `${P}/collections/books/records?filter=${encodeURIComponent("judul='Laskar Pelangi'")}&expand=author`,
    undefined,
    adminToken
  );
  assert.equal(res.status, 200);
  const item = res.data.items[0];
  console.log('\n   📚 expand=author →', JSON.stringify(item.expand));

  assert.ok(item.expand, 'key `expand` HARUS ada — inti bug M19');
  assert.equal(item.expand.author.id, authorId);
  assert.equal(item.expand.author.nama, 'Andrea Hirata');
  // field mentah tetap berisi id (tidak ditimpa)
  assert.equal(item.author, authorId);
});

test('M19: tanpa param expand, key `expand` TIDAK muncul', async () => {
  const res = await http(
    'GET',
    `${P}/collections/books/records?filter=${encodeURIComponent("judul='Laskar Pelangi'")}`,
    undefined,
    adminToken
  );
  assert.equal(res.status, 200);
  const item = res.data.items[0];
  assert.equal(item.expand, undefined, 'expand tidak boleh muncul kalau tidak diminta');
});

test('M19: nested expand (author.publisher) bekerja 2 level', async () => {
  const res = await http(
    'GET',
    `${P}/collections/books/records?filter=${encodeURIComponent("judul='Laskar Pelangi'")}&expand=author.publisher`,
    undefined,
    adminToken
  );
  assert.equal(res.status, 200);
  const item = res.data.items[0];
  console.log('   🪆 nested →', JSON.stringify(item.expand?.author?.expand));

  assert.ok(item.expand?.author, 'level 1 harus ada');
  assert.equal(item.expand.author.expand?.publisher?.nama, 'Bentang', 'level 2 harus ada');
});

test('M19: multi-relation menghasilkan ARRAY', async () => {
  const res = await http(
    'GET',
    `${P}/collections/books/records?filter=${encodeURIComponent("judul='Laskar Pelangi'")}&expand=kontributor`,
    undefined,
    adminToken
  );
  assert.equal(res.status, 200);
  const item = res.data.items[0];
  console.log('   👥 kontributor →', JSON.stringify(item.expand?.kontributor?.map((k: any) => k.nama)));

  assert.ok(Array.isArray(item.expand.kontributor), 'multi-relation harus array');
  assert.equal(item.expand.kontributor.length, 2);
  const nama = item.expand.kontributor.map((k: any) => k.nama).sort();
  assert.deepEqual(nama, ['Andrea Hirata', 'Tere Liye']);
});

test('M19: record tanpa relasi tidak crash saat expand', async () => {
  const res = await http(
    'GET',
    `${P}/collections/books/records?filter=${encodeURIComponent("judul='Buku Yatim'")}&expand=author`,
    undefined,
    adminToken
  );
  assert.equal(res.status, 200, 'harus 200, bukan 500');
  const item = res.data.items[0];
  console.log('   🕳️  buku tanpa relasi → expand:', JSON.stringify(item.expand));
  // expand ada tapi kosong — bukan crash, bukan null pointer
  assert.ok(item.expand !== undefined);
  assert.equal(item.expand.author, undefined);
});

test('M19: expand field yang bukan relation diabaikan (semantik PocketBase)', async () => {
  const res = await http(
    'GET',
    `${P}/collections/books/records?expand=judul`,
    undefined,
    adminToken
  );
  console.log('   🙈 expand=judul (bukan relation) →', res.status);
  assert.equal(res.status, 200, 'tidak error, hanya diabaikan');
});

test('M19: expand pada GET satu record (jalur publik)', async () => {
  const res = await http(
    'GET',
    `/api/p/${projectId}/collections/books/records/${bookIdWithAuthor}?expand=author`
  );
  assert.equal(res.status, 200);
  console.log('   🔎 single record expand →', JSON.stringify(res.data.record?.expand?.author?.nama));
  assert.equal(res.data.record.expand.author.nama, 'Andrea Hirata');
});

test('M19: expand di list jalur publik (bukan hanya admin)', async () => {
  const res = await http('GET', `/api/p/${projectId}/collections/books/records?expand=author`);
  assert.equal(res.status, 200);
  const withAuthor = res.data.items.find((i: any) => i.judul === 'Laskar Pelangi');
  console.log('   🌐 public list expand →', JSON.stringify(withAuthor?.expand?.author?.nama));
  assert.equal(withAuthor.expand.author.nama, 'Andrea Hirata');
});

test('M19 ANTI-REGRESI: relations.ts diimpor kode produksi, bukan hanya test', () => {
  const srcDir = path.resolve('src');
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && entry.name !== 'relations.ts') {
        if (/from\s+['"].*relations\.js['"]/.test(fs.readFileSync(full, 'utf-8'))) {
          found.push(path.relative(srcDir, full));
        }
      }
    }
  };
  walk(srcDir);
  console.log('   🔗 relations.ts diimpor oleh:', found);
  assert.ok(found.length >= 1, 'relations.ts tidak boleh kembali jadi modul yatim');
});
