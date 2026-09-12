// ============================================================================
// BATCH 2 & 3: TEST BACKUP, DUPLIKASI COLLECTION, BATCH INSERT
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  initSchemaTable,
  defineCollection,
  duplicateCollection,
  getCollectionByName,
} from '../src/core/schema.js';
import { createRecord, createRecordsBatch, listRecords } from '../src/core/records.js';

const TEST_DIR = path.resolve('../data/b23-test');
let counter = 0;

function freshDb(): DatabaseSync {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(TEST_DIR, `t-${Date.now()}-${counter++}.db`));
  db.exec('PRAGMA journal_mode = WAL');
  initSchemaTable(db);

  defineCollection(db, {
    name: 'habits',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'streak', type: 'number' },
    ],
    indexes: [{ name: 'idx_habits_streak', fields: ['streak'] }],
  });

  return db;
}

// ════════════════════════════════════════════════════════════════════════════
// B2: BACKUP
// ════════════════════════════════════════════════════════════════════════════

test('B2: VACUUM INTO membuat backup yang bisa dibuka & berisi data sama', () => {
  const dbPath = path.join(TEST_DIR, `backup-src-${Date.now()}-${counter++}.db`);
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  initSchemaTable(db);
  defineCollection(db, {
    name: 'habits',
    fields: [{ name: 'title', type: 'text', required: true }],
  });
  createRecord(db, 'habits', { title: 'Olahraga' });
  createRecord(db, 'habits', { title: 'Baca' });

  // Backup dengan VACUUM INTO (cara SQLite yang konsisten)
  const backupPath = dbPath.replace('.db', '-backup.db');
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);

  assert.ok(fs.existsSync(backupPath), 'file backup harus terbentuk');

  // Buka backup & verifikasi isinya SAMA
  const backupDb = new DatabaseSync(backupPath);
  const count = (backupDb.prepare('SELECT COUNT(*) AS n FROM habits').get() as { n: number }).n;
  console.log(`\n   💾 Backup berisi ${count} records (harus 2)`);
  assert.equal(count, 2);

  backupDb.close();
  db.close();
});

test('B2: backup menyalin skema (_collections) juga', () => {
  const dbPath = path.join(TEST_DIR, `backup-schema-${Date.now()}-${counter++}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  initSchemaTable(db);
  defineCollection(db, {
    name: 'users',
    fields: [{ name: 'email', type: 'email', unique: true }],
  });

  const backupPath = dbPath.replace('.db', '-backup.db');
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);

  const backupDb = new DatabaseSync(backupPath);
  const meta = getCollectionByName(backupDb, 'users');
  assert.ok(meta, 'skema harus ikut ter-backup');
  assert.equal(meta.fields[0].unique, true, 'konfigurasi unique ikut tersalin');

  backupDb.close();
  db.close();
});

// ════════════════════════════════════════════════════════════════════════════
// B3.1: DUPLIKASI COLLECTION
// ════════════════════════════════════════════════════════════════════════════

test('B3: duplikasi collection menyalin skema (tanpa data)', () => {
  const db = freshDb();
  createRecord(db, 'habits', { title: 'Asli', streak: 5 });

  const copy = duplicateCollection(db, 'habits', 'habits_copy');

  assert.equal(copy.name, 'habits_copy');
  assert.equal(copy.fields.length, 2, 'skema tersalin');
  assert.equal(copy.indexes.length, 1, 'index tersalin');

  // Tanpa withData → kosong
  const count = (db.prepare('SELECT COUNT(*) AS n FROM habits_copy').get() as { n: number }).n;
  console.log(`\n   📋 habits_copy punya ${count} records (harus 0 — tanpa data)`);
  assert.equal(count, 0);

  db.close();
});

test('B3: duplikasi dengan withData menyalin record juga', () => {
  const db = freshDb();
  createRecord(db, 'habits', { title: 'A', streak: 1 });
  createRecord(db, 'habits', { title: 'B', streak: 2 });

  duplicateCollection(db, 'habits', 'habits_copy', { withData: true });

  const count = (db.prepare('SELECT COUNT(*) AS n FROM habits_copy').get() as { n: number }).n;
  console.log(`   📋 habits_copy punya ${count} records (harus 2)`);
  assert.equal(count, 2);

  db.close();
});

test('B3: duplikasi ke nama yang sudah ada DITOLAK', () => {
  const db = freshDb();
  assert.throws(() => {
    duplicateCollection(db, 'habits', 'habits'); // nama sama
  }, /sudah ada/);
  db.close();
});

test('B3: duplikasi dari collection tidak ada DITOLAK', () => {
  const db = freshDb();
  assert.throws(() => {
    duplicateCollection(db, 'tidak-ada', 'baru');
  }, /tidak ditemukan/);
  db.close();
});

// ════════════════════════════════════════════════════════════════════════════
// B3.2: BATCH INSERT
// ════════════════════════════════════════════════════════════════════════════

test('B3: batch insert membuat banyak record sekaligus', () => {
  const db = freshDb();

  const created = createRecordsBatch(
    db,
    'habits',
    Array.from({ length: 50 }, (_, i) => ({ title: `Habit ${i}`, streak: i }))
  );

  assert.equal(created.length, 50);
  const result = listRecords(db, 'habits', { perPage: 100 });
  assert.equal(result.totalItems, 50);

  console.log('\n   📦 Batch insert: 50 records dalam 1 transaksi');
  db.close();
});

test('B3: batch insert ATOMIK — satu gagal, semua batal', () => {
  const db = freshDb();

  // Record ke-3 punya streak bertipe salah → gagal di tengah
  const bad = [
    { title: 'A', streak: 1 },
    { title: 'B', streak: 2 },
    { title: 'C', streak: 'bukan-angka' as unknown as number }, // ❌
    { title: 'D', streak: 4 },
  ];

  assert.throws(() => createRecordsBatch(db, 'habits', bad));

  // ROLLBACK → tidak ada yang tersimpan
  const count = (db.prepare('SELECT COUNT(*) AS n FROM habits').get() as { n: number }).n;
  console.log(`   🛡️  Setelah gagal di record ke-3: ${count} tersimpan (harus 0 — atomik)`);
  assert.equal(count, 0);

  db.close();
});

test('B3: batch insert jauh lebih cepat dari insert satu-per-satu', () => {
  const N = 2000;

  // ── Satu per satu (auto-commit tiap insert) ──
  const db1 = freshDb();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    createRecord(db1, 'habits', { title: `H${i}`, streak: i });
  }
  const oneByOne = performance.now() - t0;
  db1.close();

  // ── Batch (1 transaksi) ──
  const db2 = freshDb();
  const t1 = performance.now();
  createRecordsBatch(
    db2,
    'habits',
    Array.from({ length: N }, (_, i) => ({ title: `H${i}`, streak: i }))
  );
  const batchTime = performance.now() - t1;
  db2.close();

  console.log('');
  console.log('   ╔════════════════════════════════════════════════════╗');
  console.log(`   ║  INSERT ${N} records                                  ║`);
  console.log('   ╠════════════════════════════════════════════════════╣');
  console.log(`   ║  Satu per satu : ${oneByOne.toFixed(0).padStart(6)}ms                        ║`);
  console.log(`   ║  Batch         : ${batchTime.toFixed(0).padStart(6)}ms                        ║`);
  console.log(`   ║  Percepatan    : ${(oneByOne / Math.max(batchTime, 0.1)).toFixed(1).padStart(6)}x                        ║`);
  console.log('   ╚════════════════════════════════════════════════════╝');
  console.log('');

  assert.ok(batchTime < oneByOne, 'batch harus lebih cepat');
});
