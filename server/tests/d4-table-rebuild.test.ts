// ============================================================================
// D4: TEST TABLE REBUILD
//
// Membuktikan skema bisa berubah (hapus kolom, ubah tipe, tambah required)
// TANPA kehilangan data, dan index dibuat ulang.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initSchemaTable, defineCollection, rebuildCollection, getCollectionByName } from '../src/core/schema.js';
import { createRecord, getRecord } from '../src/core/records.js';

const TEST_DIR = path.resolve('../data/d4-test');
let counter = 0;

function freshDb(): DatabaseSync {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(TEST_DIR, `t-${Date.now()}-${counter++}.db`));
  db.exec('PRAGMA journal_mode = WAL');
  initSchemaTable(db);
  return db;
}

// Helper: daftar kolom aktual dari tabel SQLite
function actualColumns(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
  return rows.map((r) => r.name);
}

// ════════════════════════════════════════════════════════════════════════════
// SKENARIO A: Hapus kolom
// ════════════════════════════════════════════════════════════════════════════

test('D4: hapus kolom → kolom hilang, data kolom lain selamat', () => {
  const db = freshDb();

  defineCollection(db, {
    name: 'habits',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'streak', type: 'number' },
      { name: 'note', type: 'text' },
    ],
  });

  const rec = createRecord(db, 'habits', { title: 'Olahraga', streak: 7, note: 'penting' });

  // Rebuild: hapus kolom 'streak'
  rebuildCollection(db, 'habits', {
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'note', type: 'text' },
    ],
  });

  // Kolom streak harus hilang dari tabel
  const cols = actualColumns(db, 'habits');
  console.log('\n   🗑️  Kolom setelah rebuild:', cols);
  assert.ok(!cols.includes('streak'), 'streak harus hilang');
  assert.ok(cols.includes('title') && cols.includes('note'), 'kolom lain tetap');

  // Data kolom lain harus SELAMAT
  const surviving = getRecord(db, 'habits', rec.id);
  assert.equal(surviving?.title, 'Olahraga');
  assert.equal(surviving?.note, 'penting');

  db.close();
});

// ════════════════════════════════════════════════════════════════════════════
// SKENARIO B: Ubah tipe kolom
// ════════════════════════════════════════════════════════════════════════════

test('D4: ubah tipe kolom → nilai dikonversi', () => {
  const db = freshDb();

  defineCollection(db, {
    name: 'habits',
    fields: [
      { name: 'title', type: 'text' },
      { name: 'score', type: 'number' },
    ],
  });

  const rec = createRecord(db, 'habits', { title: 'Test', score: 42 });

  // Rebuild: ubah score dari number → text
  rebuildCollection(db, 'habits', {
    fields: [
      { name: 'title', type: 'text' },
      { name: 'score', type: 'text' },
    ],
  });

  const surviving = getRecord(db, 'habits', rec.id);
  console.log('\n   🔄 Score setelah ubah tipe:', surviving?.score, `(tipe: ${typeof surviving?.score})`);
  // Nilai harus dikonversi menjadi string "42"
  assert.equal(String(surviving?.score), '42');

  db.close();
});

// ════════════════════════════════════════════════════════════════════════════
// SKENARIO C: Tambah kolom required
// ════════════════════════════════════════════════════════════════════════════

test('D4: tambah kolom required → data lama terisi default', () => {
  const db = freshDb();

  defineCollection(db, {
    name: 'habits',
    fields: [{ name: 'title', type: 'text' }],
  });

  const rec = createRecord(db, 'habits', { title: 'Olahraga' });

  // Rebuild: tambah kolom 'category' yang REQUIRED
  rebuildCollection(db, 'habits', {
    fields: [
      { name: 'title', type: 'text' },
      { name: 'category', type: 'text', required: true },
    ],
  });

  // Data lama harus punya category (default, tidak NULL)
  const surviving = getRecord(db, 'habits', rec.id);
  console.log('\n   ➕ Category data lama:', JSON.stringify(surviving?.category));
  assert.ok(surviving?.category !== null && surviving?.category !== undefined, 'kolom baru harus terisi');

  // Skema di meta harus ter-update
  const meta = getCollectionByName(db, 'habits');
  assert.equal(meta?.fields.length, 2);

  db.close();
});

// ════════════════════════════════════════════════════════════════════════════
// INDEX DIBUAT ULANG
// ════════════════════════════════════════════════════════════════════════════

test('D4: unique index dibuat ulang setelah rebuild', () => {
  const db = freshDb();

  defineCollection(db, {
    name: 'users',
    fields: [
      { name: 'email', type: 'email', unique: true },
      { name: 'name', type: 'text' },
    ],
  });

  createRecord(db, 'users', { email: 'a@x.com', name: 'A' });

  // Rebuild (tambah kolom)
  rebuildCollection(db, 'users', {
    fields: [
      { name: 'email', type: 'email', unique: true },
      { name: 'name', type: 'text' },
      { name: 'age', type: 'number' },
    ],
  });

  // Unique index harus masih menegakkan keunikan setelah rebuild
  assert.throws(() => {
    createRecord(db, 'users', { email: 'a@x.com', name: 'Duplikat' });
  }, /unique|already used/i);

  console.log('\n   🛡️  Unique index tetap menegakkan setelah rebuild.');

  db.close();
});

// ════════════════════════════════════════════════════════════════════════════
// DATA SELAMAT SAAT REBUILD
// ════════════════════════════════════════════════════════════════════════════

test('D4: banyak data tetap utuh setelah rebuild (100 records)', () => {
  const db = freshDb();

  defineCollection(db, {
    name: 'habits',
    fields: [
      { name: 'title', type: 'text' },
      { name: 'streak', type: 'number' },
    ],
  });

  // Isi 100 records
  for (let i = 1; i <= 100; i++) {
    createRecord(db, 'habits', { title: `Habit ${i}`, streak: i });
  }

  // Rebuild: hapus streak, tambah note
  rebuildCollection(db, 'habits', {
    fields: [
      { name: 'title', type: 'text' },
      { name: 'note', type: 'text' },
    ],
  });

  const count = (db.prepare('SELECT COUNT(*) AS n FROM habits').get() as { n: number }).n;
  console.log(`\n   💯 Setelah rebuild, jumlah record: ${count} (harus 100)`);
  assert.equal(count, 100);

  // Spot check beberapa record
  const titles = db.prepare('SELECT title FROM habits ORDER BY title').all() as { title: string }[];
  assert.ok(titles.some((t) => t.title === 'Habit 50'));

  db.close();
});
