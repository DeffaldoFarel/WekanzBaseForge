// ============================================================================
// M03: TEST META-TABLES
//
// Yang paling penting di sini: membuktikan bahwa tabel HASIL GENERATE
// (yang tidak pernah kita tulis SQL-nya dengan tangan) benar-benar
// berfungsi seperti tabel biasa — bisa di-INSERT, di-SELECT, di-ALTER.
//
// Jalankan: npm test
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  initSchemaTable,
  defineCollection,
  getCollectionByName,
  listCollections,
  updateCollection,
  deleteCollection,
  generateCreateTableSql,
} from '../src/core/schema.js';

const TEST_DIR = path.resolve('../data/m03-test');

let dbCounter = 0;

// Setiap test memakai file DB UNIK — menghindari masalah file lock
// di Windows (file yang baru di-close tidak langsung bisa dihapus).
function freshDb(): DatabaseSync {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const dbPath = path.join(TEST_DIR, `test-${Date.now()}-${dbCounter++}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  initSchemaTable(db);
  return db;
}

// ════════════════════════════════════════════════════════════════════════════

test('M03: SQL generator menghasilkan CREATE TABLE yang benar', () => {
  // Fungsi murni — tidak perlu database!
  const sql = generateCreateTableSql({
    name: 'habits',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'streak', type: 'number' },
      { name: 'done', type: 'bool' },
    ],
  });

  console.log('\n   📜 SQL hasil generate:');
  for (const line of sql.split('\n')) console.log('      ' + line);

  assert.ok(sql.includes('CREATE TABLE "habits"'));
  assert.ok(sql.includes('"id" TEXT PRIMARY KEY'));       // sistem
  assert.ok(sql.includes('"created" TEXT NOT NULL'));      // sistem
  assert.ok(sql.includes('"title" TEXT NOT NULL'));        // user + required
  assert.ok(sql.includes('"streak" REAL'));                // number → REAL
  assert.ok(sql.includes('"done" INTEGER NOT NULL DEFAULT 0')); // bool → INTEGER
});

test('M03: defineCollection menyimpan meta + membuat tabel asli', () => {
  const db = freshDb();

  const meta = defineCollection(db, {
    name: 'habits',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'streak', type: 'number' },
    ],
  });

  // 1. Meta tersimpan di _collections
  assert.equal(meta.name, 'habits');
  assert.equal(meta.fields.length, 2);
  assert.ok(meta.id);

  // 2. Tabel ASLI benar-benar ada di SQLite
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='habits'`)
    .get();
  assert.ok(tableExists, 'Tabel habits harus benar-benar terbentuk di SQLite');

  db.close();
});

test('M03: BUKTI NYATA — tabel hasil generate bisa di-INSERT & SELECT', () => {
  const db = freshDb();

  // Definisikan collection — kita TIDAK menulis CREATE TABLE dengan tangan!
  defineCollection(db, {
    name: 'habits',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'streak', type: 'number' },
    ],
  });

  // Insert ke tabel hasil generate — harus bekerja seperti tabel normal
  db.prepare('INSERT INTO habits (id, title, streak) VALUES (?, ?, ?)').run(
    'h1',
    'Olahraga',
    7
  );

  const row = db.prepare('SELECT * FROM habits WHERE id = ?').get('h1') as
    | { id: string; title: string; streak: number; created: string }
    | undefined;

  assert.equal(row?.title, 'Olahraga');
  assert.equal(row?.streak, 7);
  assert.ok(row?.created); // DEFAULT timestamp dari field sistem bekerja!

  console.log('\n   🎉 Record di tabel hasil generate:', row);

  // Schema menolak NULL (warisan M02 — tetap bekerja di tabel generate)
  assert.throws(() => {
    db.prepare('INSERT INTO habits (id, title, streak) VALUES (?, ?, ?)').run(
      'h2',
      null as unknown as string,
      3
    );
  });

  db.close();
});

test('M03: validasi nama menolak nama berbahaya (anti SQL injection)', () => {
  const db = freshDb();

  // Nama dengan karakter berbahaya
  assert.throws(() => {
    defineCollection(db, {
      name: 'habits"; DROP TABLE users; --',
      fields: [],
    });
  }, /Invalid collection name/);

  // Nama sistem (underscore di awal) — ditolak validasi nama
  assert.throws(() => {
    defineCollection(db, { name: '_secret', fields: [] });
  }, /Invalid collection name/);

  // Field dengan nama sistem
  assert.throws(() => {
    defineCollection(db, {
      name: 'habits',
      fields: [{ name: 'id', type: 'text' }],
    });
  }, /reserved/);

  console.log('\n   🛡️  Nama berbahaya ditolak — SQL injection di nama mustahil.');

  db.close();
});

test('M03: duplikat collection ditolak', () => {
  const db = freshDb();

  defineCollection(db, { name: 'habits', fields: [] });

  assert.throws(() => {
    defineCollection(db, { name: 'habits', fields: [] });
  }, /already exists/);

  db.close();
});

test('M03: updateCollection menambah kolom via ALTER TABLE', () => {
  const db = freshDb();

  defineCollection(db, {
    name: 'habits',
    fields: [{ name: 'title', type: 'text', required: true }],
  });

  // Isi data dulu
  db.prepare('INSERT INTO habits (id, title) VALUES (?, ?)').run('h1', 'Olahraga');

  // Tambah kolom baru
  const updated = updateCollection(db, 'habits', {
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'note', type: 'text' },        // ← kolom baru!
      { name: 'streak', type: 'number' },    // ← kolom baru!
    ],
  });

  assert.equal(updated.fields.length, 3);

  // Data lama masih ada, kolom baru bisa dipakai
  db.prepare('UPDATE habits SET note = ?, streak = ? WHERE id = ?').run(
    'catatan baru',
    5,
    'h1'
  );
  const row = db.prepare('SELECT * FROM habits WHERE id = ?').get('h1') as {
    note: string;
    streak: number;
  };
  assert.equal(row.note, 'catatan baru');
  assert.equal(row.streak, 5);

  console.log('\n   ➕ Kolom baru ditambahkan tanpa kehilangan data lama.');

  db.close();
});

test('M03: updateCollection menolak penghapusan kolom (belum didukung)', () => {
  const db = freshDb();

  defineCollection(db, {
    name: 'habits',
    fields: [
      { name: 'title', type: 'text' },
      { name: 'streak', type: 'number' },
    ],
  });

  assert.throws(() => {
    updateCollection(db, 'habits', {
      fields: [{ name: 'title', type: 'text' }], // streak dihapus!
    });
  }, /not supported|drop/i);

  db.close();
});

test('M03: deleteCollection menghapus meta + tabel', () => {
  const db = freshDb();

  defineCollection(db, { name: 'habits', fields: [] });
  assert.equal(deleteCollection(db, 'habits'), true);

  // Meta hilang
  assert.equal(getCollectionByName(db, 'habits'), undefined);

  // Tabel asli hilang
  const tableExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='habits'`)
    .get();
  assert.equal(tableExists, undefined);

  assert.equal(deleteCollection(db, 'habits'), false); // sudah tidak ada
  db.close();
});

test('M03: listCollections mengembalikan semua definisi', () => {
  const db = freshDb();

  defineCollection(db, { name: 'habits', fields: [{ name: 'title', type: 'text' }] });
  defineCollection(db, { name: 'posts', fields: [{ name: 'body', type: 'text' }] });

  const all = listCollections(db);
  assert.equal(all.length, 2);
  assert.deepEqual(
    all.map((c) => c.name),
    ['habits', 'posts']
  );

  db.close();
});
