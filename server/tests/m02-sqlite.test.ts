// ============================================================================
// M02: TEST + BENCHMARK HEAD-TO-HEAD vs M01 KV STORE
//
// Bagian 1: test fungsional SQLite (CRUD, validasi, query).
// Bagian 2: benchmark — operasi yang SAMA di M01 dan M02, diukur berdampingan.
//
// Jalankan: npm test
// ============================================================================

import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { RawSqlite } from '../src/lab/rawSqlite.js';
import { KVStore } from '../src/lab/kvStore.js';

const TEST_DIR = path.resolve('../data/m02-test');

// Bersihkan direktori test setelah suite selesai. Tanpa ini, file DB yang
// dinamai unik per-test (tidak pernah tertimpa) menumpuk di data/ tiap run.
after(() => {
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows menahan handle SQLite sampai GC; kegagalan cleanup tidak boleh
    // menggagalkan suite yang assertion-nya sudah lulus.
  }
});
const SQLITE_DB = path.join(TEST_DIR, 'test.db');
const KV_DB = path.join(TEST_DIR, 'kv.json');

function clean(): void {
  for (const f of [SQLITE_DB, KV_DB, SQLITE_DB + '-wal', SQLITE_DB + '-shm']) {
    if (fs.existsSync(f)) fs.rmSync(f);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// BAGIAN 1: TEST FUNGSIONAL
// ════════════════════════════════════════════════════════════════════════════

test('M02: insert dan get bekerja', () => {
  clean();
  const db = new RawSqlite(SQLITE_DB);

  db.insertHabit('h1', 'Olahraga', 7);
  const habit = db.getHabit('h1');

  assert.equal(habit?.title, 'Olahraga');
  assert.equal(habit?.streak, 7);
  assert.ok(habit?.created); // DEFAULT bekerja — kita tidak mengisinya!
  db.close();
});

test('M02: schema MENOLAK data yang melanggar (ini fitur!)', () => {
  clean();
  const db = new RawSqlite(SQLITE_DB);

  // title NULL → NOT NULL constraint menolak
  assert.throws(() => {
    db.insertHabit('h2', null as unknown as string, 5);
  }, /NOT NULL|constraint/i);

  // Di M01, operasi seperti ini diam-diam BERHASIL dan jadi bug di kemudian hari.
  db.close();
});

test('M02: update dan delete bekerja', () => {
  clean();
  const db = new RawSqlite(SQLITE_DB);

  db.insertHabit('h3', 'Baca', 3);
  assert.equal(db.updateStreak('h3', 10), true);
  assert.equal(db.getHabit('h3')?.streak, 10);

  assert.equal(db.deleteHabit('h3'), true);
  assert.equal(db.getHabit('h3'), undefined);
  assert.equal(db.deleteHabit('h3'), false);
  db.close();
});

test('M02: query dengan kondisi — WHERE tanpa membaca semuanya di JS', () => {
  clean();
  const db = new RawSqlite(SQLITE_DB);

  db.bulkInsertWithTransaction(
    Array.from({ length: 100 }, (_, i) => ({
      id: `h${i}`,
      title: `Habit ${i}`,
      streak: i % 10,
    }))
  );

  const found = db.findHabitsByMinStreak(5);
  assert.equal(found.length, 40); // streak 6,7,8,9 × 10
  // streak tertinggi harus di urutan pertama (ORDER BY streak DESC)
  assert.equal(found[0].streak, 9);
  db.close();
});

// ════════════════════════════════════════════════════════════════════════════
// BAGIAN 2: BENCHMARK HEAD-TO-HEAD — M01 vs M02
// ════════════════════════════════════════════════════════════════════════════

test('BENCHMARK 1: isi 2000 record — KV store vs SQLite (tanpa & dengan transaksi)', async () => {
  clean();
  const N = 2000;

  // ── M01: KV store buatan ──
  const kv = new KVStore(KV_DB);
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    await kv.set(`h${i}`, { title: `Habit ${i}`, streak: i % 10 });
  }
  const kvTime = performance.now() - t0;

  // ── M02: SQLite tanpa transaksi (auto-commit per INSERT) ──
  const db = new RawSqlite(SQLITE_DB);
  const rows = Array.from({ length: N }, (_, i) => ({
    id: `h${i}`,
    title: `Habit ${i}`,
    streak: i % 10,
  }));

  const t1 = performance.now();
  db.bulkInsertNoTransaction(rows);
  const sqliteNoTxTime = performance.now() - t1;

  // ── M02: SQLite dengan transaksi ──
  db.clearHabits();
  const t2 = performance.now();
  db.bulkInsertWithTransaction(rows);
  const sqliteTxTime = performance.now() - t2;

  console.log('');
  console.log('   ╔═══════════════════════════════════════════════════════╗');
  console.log(`   ║  ISI ${N} RECORD                                        ║`);
  console.log('   ╠═══════════════════════════════════════════════════════╣');
  console.log(`   ║  M01 KV store          : ${kvTime.toFixed(0).padStart(6)}ms                     ║`);
  console.log(`   ║  M02 SQLite (no tx)    : ${sqliteNoTxTime.toFixed(0).padStart(6)}ms                     ║`);
  console.log(`   ║  M02 SQLite (with tx)  : ${sqliteTxTime.toFixed(0).padStart(6)}ms                     ║`);
  console.log('   ╠═══════════════════════════════════════════════════════╣');
  console.log(`   ║  Transaksi mempercepat : ${(sqliteNoTxTime / Math.max(sqliteTxTime, 0.1)).toFixed(1)}x                        ║`);
  console.log(`   ║  SQLite vs KV buatan   : ${(kvTime / Math.max(sqliteTxTime, 0.1)).toFixed(1)}x lebih cepat           ║`);
  console.log('   ╚═══════════════════════════════════════════════════════╝');
  console.log('');

  db.close();
  assert.ok(true); // benchmark selalu "lulus" — yang penting angkanya
});

test('BENCHMARK 2: cari streak > 5 dari 5000 record — full scan JS vs WHERE SQL', async () => {
  clean();
  const N = 5000;

  // ── M01: KV store — cari dengan loop JavaScript ──
  const kv = new KVStore(KV_DB);
  for (let i = 0; i < N; i++) {
    await kv.set(`habits:h${i}`, { title: `Habit ${i}`, streak: i % 10 });
  }

  const t0 = performance.now();
  const kvFound = await kv.findByValue((v) => (v as { streak: number }).streak > 5);
  const kvTime = performance.now() - t0;

  // ── M02: SQLite — WHERE clause ──
  const db = new RawSqlite(SQLITE_DB);
  db.bulkInsertWithTransaction(
    Array.from({ length: N }, (_, i) => ({
      id: `h${i}`,
      title: `Habit ${i}`,
      streak: i % 10,
    }))
  );

  const t1 = performance.now();
  const sqlFound = db.findHabitsByMinStreak(5);
  const sqlTime = performance.now() - t1;

  console.log('');
  console.log('   ╔═══════════════════════════════════════════════════════╗');
  console.log(`   ║  CARI streak>5 DARI ${N} RECORD                          ║`);
  console.log('   ╠═══════════════════════════════════════════════════════╣');
  console.log(`   ║  M01 full scan JS      : ${kvTime.toFixed(1).padStart(6)}ms  (${kvFound.length} hasil)      ║`);
  console.log(`   ║  M02 WHERE SQL         : ${sqlTime.toFixed(1).padStart(6)}ms  (${sqlFound.length} hasil)      ║`);
  console.log('   ╚═══════════════════════════════════════════════════════╝');
  console.log('   Catatan: keduanya "membaca semua" (belum ada index — itu M06),');
  console.log('   tapi engine C SQLite jauh lebih efisien daripada loop JS kita.');
  console.log('');

  assert.equal(kvFound.length, sqlFound.length); // hasil harus sama!
  db.close();
});

test('BENCHMARK 3: bukti transaksi itu atomik — gagal di tengah, semua batal', () => {
  clean();
  const db = new RawSqlite(SQLITE_DB);

  // Baris ke-500 punya id duplikat dengan baris pertama → error di tengah
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    id: i === 500 ? 'h0' : `h${i}`, // 'h0' duplikat!
    title: `Habit ${i}`,
    streak: 1,
  }));

  assert.throws(() => db.bulkInsertWithTransaction(rows));

  // Karena ROLLBACK, TIDAK ADA SATUPUN yang tersimpan —
  // padahal 500 baris pertama "berhasil" sebelum error!
  const count = db.countHabits();
  console.log(`   🛡️  B3: 500 baris "berhasil" lalu error di baris ke-501.`);
  console.log(`       Isi tabel sekarang: ${count} baris (harus 0 — ROLLBACK bekerja!)`);
  assert.equal(count, 0);

  db.close();
});
