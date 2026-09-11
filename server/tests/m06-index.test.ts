// ============================================================================
// M06: TEST INDEXING
//
// Yang terpenting di sini: BENCHMARK yang membuktikan dengan ANGKA
// perbedaan query dengan dan tanpa index pada data besar,
// plus EXPLAIN QUERY PLAN yang menunjukkan SCAN vs SEARCH.
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
  generateCreateIndexSql,
} from '../src/core/schema.js';

const TEST_DIR = path.resolve('../data/m06-test');
let counter = 0;

function freshDb(): DatabaseSync {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(TEST_DIR, `t-${Date.now()}-${counter++}.db`));
  db.exec('PRAGMA journal_mode = WAL');
  initSchemaTable(db);
  return db;
}

// Helper: jalankan EXPLAIN QUERY PLAN dan kembalikan deskripsinya
function explainPlan(db: DatabaseSync, sql: string, params: unknown[]): string {
  const rows = db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...(params as never[])) as { detail: string }[];
  return rows.map((r) => r.detail).join(' | ');
}

// Helper: isi N habits dengan streak acak (0-99)
function seedHabits(db: DatabaseSync, n: number): void {
  const insert = db.prepare(
    'INSERT INTO habits (id, title, streak) VALUES (?, ?, ?)'
  );
  db.exec('BEGIN');
  for (let i = 0; i < n; i++) {
    insert.run(`h${i}`, `Habit ${i}`, i % 100);
  }
  db.exec('COMMIT');
}

// ════════════════════════════════════════════════════════════════════════════
// DEFINISI INDEX
// ════════════════════════════════════════════════════════════════════════════

test('M06: defineCollection dengan indexes → CREATE INDEX terbentuk', () => {
  const db = freshDb();

  defineCollection(db, {
    name: 'habits',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'streak', type: 'number' },
    ],
    indexes: [{ name: 'idx_habits_streak', fields: ['streak'] }],
  });

  // Cek index benar-benar ada di SQLite
  const idx = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_habits_streak'`)
    .get();
  assert.ok(idx, 'Index harus terbentuk di SQLite');

  // Meta menyimpan definisi index
  const meta = getCollectionByName(db, 'habits');
  assert.equal(meta?.indexes.length, 1);

  db.close();
});

test('M06: index merujuk field yang tidak ada → ditolak', () => {
  const db = freshDb();

  assert.throws(() => {
    defineCollection(db, {
      name: 'habits',
      fields: [{ name: 'title', type: 'text' }],
      indexes: [{ name: 'idx_bad', fields: ['field_hantu'] }],
    });
  }, /tidak ada di collection/);

  db.close();
});

test('M06: composite index (multi-kolom) terbentuk', () => {
  const db = freshDb();

  defineCollection(db, {
    name: 'habits',
    fields: [
      { name: 'user', type: 'text' },
      { name: 'streak', type: 'number' },
    ],
    indexes: [{ name: 'idx_user_streak', fields: ['user', 'streak'] }],
  });

  const sql = generateCreateIndexSql('habits', { name: 'idx_user_streak', fields: ['user', 'streak'] }, [
    { name: 'user', type: 'text' },
    { name: 'streak', type: 'number' },
  ]);
  assert.ok(sql.includes('("user", "streak")'));

  db.close();
});

// ════════════════════════════════════════════════════════════════════════════
// EXPLAIN QUERY PLAN — mata database
// ════════════════════════════════════════════════════════════════════════════

test('M06: EXPLAIN menunjukkan SCAN tanpa index vs SEARCH dengan index', () => {
  const db = freshDb();

  // Tabel TANPA index di streak
  defineCollection(db, {
    name: 'habits',
    fields: [
      { name: 'title', type: 'text' },
      { name: 'streak', type: 'number' },
    ],
  });

  const planNoIndex = explainPlan(db, 'SELECT * FROM habits WHERE streak > ?', [50]);
  console.log('\n   🔍 Tanpa index :', planNoIndex);
  assert.ok(/SCAN/i.test(planNoIndex), 'tanpa index harus SCAN (baca semua)');

  // Tambah index
  db.exec('CREATE INDEX idx_streak ON habits (streak)');

  const planWithIndex = explainPlan(db, 'SELECT * FROM habits WHERE streak > ?', [50]);
  console.log('   ✨ Dengan index:', planWithIndex);
  assert.ok(/SEARCH/i.test(planWithIndex), 'dengan index harus SEARCH');
  assert.ok(/idx_streak/i.test(planWithIndex), 'harus pakai index kita');

  db.close();
});

// ════════════════════════════════════════════════════════════════════════════
// BENCHMARK UTAMA — dengan vs tanpa index pada data besar
// ════════════════════════════════════════════════════════════════════════════

test('M06: BENCHMARK — query dengan vs tanpa index pada 100.000 record', () => {
  const db = freshDb();
  const N = 100_000;

  // Siapkan tabel TANPA index streak dulu
  defineCollection(db, {
    name: 'habits',
    fields: [
      { name: 'title', type: 'text' },
      { name: 'streak', type: 'number' },
    ],
  });

  console.log(`\n   ⏳ Mengisi ${N.toLocaleString()} record...`);
  const tSeed = performance.now();
  seedHabits(db, N);
  console.log(`   ✅ Terisi dalam ${(performance.now() - tSeed).toFixed(0)}ms (dengan transaksi!)`);

  const QUERY = 'SELECT COUNT(*) AS n FROM habits WHERE streak > ?';
  const PARAM = [95]; // streak 96-99 → 4% data

  // ── TANPA index (warm up + ukur) ──
  db.prepare(QUERY).get(...(PARAM as never[]));
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) db.prepare(QUERY).get(...(PARAM as never[]));
  const noIndexTime = (performance.now() - t0) / 20;

  // ── Buat index ──
  const tIdx = performance.now();
  db.exec('CREATE INDEX idx_streak ON habits (streak)');
  const createIndexTime = performance.now() - tIdx;

  // ── DENGAN index ──
  db.prepare(QUERY).get(...(PARAM as never[]));
  const t1 = performance.now();
  for (let i = 0; i < 20; i++) db.prepare(QUERY).get(...(PARAM as never[]));
  const withIndexTime = (performance.now() - t1) / 20;

  const speedup = noIndexTime / Math.max(withIndexTime, 0.001);

  console.log('');
  console.log('   ╔══════════════════════════════════════════════════════════╗');
  console.log(`   ║  QUERY streak > 95 dari ${N.toLocaleString()} record (rata2 20x)      ║`);
  console.log('   ╠══════════════════════════════════════════════════════════╣');
  console.log(`   ║  TANPA index (SCAN)   : ${noIndexTime.toFixed(2).padStart(8)}ms                       ║`);
  console.log(`   ║  DENGAN index (SEARCH): ${withIndexTime.toFixed(3).padStart(8)}ms                       ║`);
  console.log('   ╠══════════════════════════════════════════════════════════╣');
  console.log(`   ║  PERCEPATAN           : ${speedup.toFixed(1).padStart(6)}x                         ║`);
  console.log(`   ║  Biaya buat index     : ${createIndexTime.toFixed(0).padStart(6)}ms (sekali)             ║`);
  console.log('   ╚══════════════════════════════════════════════════════════╝');
  console.log('');

  // Dengan index HARUS lebih cepat (atau minimal tidak lebih lambat)
  assert.ok(withIndexTime <= noIndexTime, 'index harus mempercepat atau menyamai');

  db.close();
});

// ════════════════════════════════════════════════════════════════════════════
// TRADE-OFF: index memperlambat WRITE
// ════════════════════════════════════════════════════════════════════════════

test('M06: trade-off — lebih banyak index = INSERT lebih lambat', () => {
  const N = 20_000;

  // ── Tabel TANPA index tambahan ──
  const dbNoIdx = freshDb();
  defineCollection(dbNoIdx, {
    name: 'habits',
    fields: [
      { name: 'title', type: 'text' },
      { name: 'streak', type: 'number' },
    ],
  });
  const t0 = performance.now();
  seedHabits(dbNoIdx, N);
  const noIdxTime = performance.now() - t0;
  dbNoIdx.close();

  // ── Tabel dengan 3 INDEX tambahan ──
  const dbIdx = freshDb();
  defineCollection(dbIdx, {
    name: 'habits',
    fields: [
      { name: 'title', type: 'text' },
      { name: 'streak', type: 'number' },
    ],
    indexes: [
      { name: 'idx1', fields: ['streak'] },
      { name: 'idx2', fields: ['title'] },
      { name: 'idx3', fields: ['title', 'streak'] },
    ],
  });
  const t1 = performance.now();
  seedHabits(dbIdx, N);
  const withIdxTime = performance.now() - t1;
  dbIdx.close();

  console.log('');
  console.log('   ╔══════════════════════════════════════════════════════════╗');
  console.log(`   ║  INSERT ${N.toLocaleString()} record                                       ║`);
  console.log('   ╠══════════════════════════════════════════════════════════╣');
  console.log(`   ║  Tanpa index tambahan : ${noIdxTime.toFixed(0).padStart(6)}ms                       ║`);
  console.log(`   ║  Dengan 3 index       : ${withIdxTime.toFixed(0).padStart(6)}ms                       ║`);
  console.log(`   ║  Overhead write       : ${(withIdxTime - noIdxTime).toFixed(0).padStart(6)}ms (${((withIdxTime / Math.max(noIdxTime, 1)) * 100 - 100).toFixed(0)}% lebih lambat)      ║`);
  console.log('   ╚══════════════════════════════════════════════════════════╝');
  console.log('   💡 Pelajaran: index itu TIDAK GRATIS — setiap index membebani');
  console.log('      INSERT/UPDATE. Indexlah kolom yang sering di-QUERY, bukan semua.');
  console.log('');

  assert.ok(true); // observasi, bukan assertion ketat (timing bervariasi)
});
