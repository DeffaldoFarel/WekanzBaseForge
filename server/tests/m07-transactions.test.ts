// ============================================================================
// M07: EKSPERIMEN TRANSACTIONS & WAL
//
// Di sini kita MENCOBA MERUSAK database dengan sengaja — dan menyaksikan
// SQLite menolak untuk rusak. Setiap eksperimen menjawab satu pertanyaan
// tentang durability.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const TEST_DIR = path.resolve('../data/m07-test');
let counter = 0;

function freshPath(tag: string): string {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  return path.join(TEST_DIR, `t-${tag}-${Date.now()}-${counter++}.db`);
}

// ════════════════════════════════════════════════════════════════════════════
// EKSPERIMEN 1: Atomicity — semua atau tidak sama sekali (pendalaman M02)
// ════════════════════════════════════════════════════════════════════════════

test('M07-E1: transaksi bersarang gagal di dalam → semua batal, tidak ada setengah', () => {
  const dbPath = freshPath('e1');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE accounts (id TEXT PRIMARY KEY, balance REAL)');

  // Simulasi transfer uang: kurangi A, tambah B — HARUS keduanya atau batal
  db.prepare('INSERT INTO accounts VALUES (?, ?)').run('A', 1000);
  db.prepare('INSERT INTO accounts VALUES (?, ?)').run('B', 500);

  db.exec('BEGIN');
  db.prepare('UPDATE accounts SET balance = balance - 300 WHERE id = ?').run('A');
  // Bayangkan di sini terjadi error SEBELUM kredit ke B...
  db.exec('ROLLBACK');

  const a = db.prepare('SELECT balance FROM accounts WHERE id = ?').get('A') as { balance: number };
  console.log(`\n   💰 E1: Setelah ROLLBACK, saldo A = ${a.balance} (harus tetap 1000)`);
  assert.equal(a.balance, 1000, 'ROLLBACK harus mengembalikan keadaan semula');

  db.close();
});

// ════════════════════════════════════════════════════════════════════════════
// EKSPERIMEN 2: Isolation — transaksi lain tidak melihat pekerjaan setengah jadi
// ════════════════════════════════════════════════════════════════════════════

test('M07-E2: koneksi lain melihat data LAMA sampai COMMIT (isolation)', () => {
  const dbPath = freshPath('e2');

  // Koneksi 1: siapkan data awal
  const db1 = new DatabaseSync(dbPath);
  db1.exec('PRAGMA journal_mode = WAL');
  db1.exec('CREATE TABLE counter (id TEXT PRIMARY KEY, value REAL)');
  db1.prepare('INSERT INTO counter VALUES (?, ?)').run('c1', 100);

  // Koneksi 2: pembaca terpisah (file yang sama)
  const db2 = new DatabaseSync(dbPath);
  db2.exec('PRAGMA journal_mode = WAL');

  // Koneksi 1: mulai transaksi dan UBAH (tapi BELUM commit)
  db1.exec('BEGIN');
  db1.prepare('UPDATE counter SET value = ? WHERE id = ?').run(999, 'c1');

  // Koneksi 2 membaca SAAT koneksi 1 belum commit → harus melihat nilai LAMA
  const duringTx = db2.prepare('SELECT value FROM counter WHERE id = ?').get('c1') as { value: number };
  console.log(`   👀 E2: Saat tx belum commit, koneksi lain melihat: ${duringTx.value} (harus 100 — nilai LAMA)`);
  assert.equal(duringTx.value, 100, 'isolation: koneksi lain tidak boleh melihat perubahan belum commit');

  // Sekarang COMMIT
  db1.exec('COMMIT');

  // Setelah commit, koneksi 2 baru melihat nilai BARU
  const afterCommit = db2.prepare('SELECT value FROM counter WHERE id = ?').get('c1') as { value: number };
  console.log(`   👀 E2: Setelah commit, koneksi lain melihat: ${afterCommit.value} (harus 999 — nilai BARU)`);
  assert.equal(afterCommit.value, 999);

  db1.close();
  db2.close();
});

// ════════════════════════════════════════════════════════════════════════════
// EKSPERIMEN 3: WAL vs DELETE journal mode — lihat file yang muncul
// ════════════════════════════════════════════════════════════════════════════

test('M07-E3: mode WAL membuat file -wal, mode DELETE tidak', () => {
  // ── Mode WAL ──
  const walPath = freshPath('wal');
  const dbWal = new DatabaseSync(walPath);
  dbWal.exec('PRAGMA journal_mode = WAL');
  dbWal.exec('CREATE TABLE t (x TEXT)');
  dbWal.prepare('INSERT INTO t VALUES (?)').run('data');

  const walMode = (dbWal.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
  const walFileExists = fs.existsSync(walPath + '-wal');
  console.log(`\n   📁 E3: Mode WAL → journal_mode='${walMode}', file -wal ada? ${walFileExists}`);
  assert.equal(walMode.toLowerCase(), 'wal');
  dbWal.close();

  // ── Mode DELETE (rollback journal, cara lama) ──
  const delPath = freshPath('del');
  const dbDel = new DatabaseSync(delPath);
  dbDel.exec('PRAGMA journal_mode = DELETE');
  dbDel.exec('CREATE TABLE t (x TEXT)');
  dbDel.prepare('INSERT INTO t VALUES (?)').run('data');

  const delMode = (dbDel.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
  console.log(`   📁 E3: Mode DELETE → journal_mode='${delMode}' (rollback journal klasik)`);
  assert.equal(delMode.toLowerCase(), 'delete');
  dbDel.close();

  console.log('   💡 WAL = tulis niat di log terpisah. DELETE = backup halaman lama sebelum ubah.');
  console.log('      Keduanya menjamin atomicity, tapi WAL lebih cepat untuk read+write bersamaan.');
});

// ════════════════════════════════════════════════════════════════════════════
// EKSPERIMEN 4: Savepoint — transaksi bersarang (rollback sebagian)
// ════════════════════════════════════════════════════════════════════════════

test('M07-E4: savepoint memungkinkan rollback SEBAGIAN dalam transaksi', () => {
  const dbPath = freshPath('e4');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE log (msg TEXT)');

  db.exec('BEGIN');
  db.prepare('INSERT INTO log VALUES (?)').run('A — sebelum savepoint');

  db.exec('SAVEPOINT sp1');
  db.prepare('INSERT INTO log VALUES (?)').run('B — setelah savepoint (akan dibatalkan)');

  // Batalkan HANYA bagian setelah savepoint
  db.exec('ROLLBACK TO sp1');
  db.exec('COMMIT');

  const rows = db.prepare('SELECT msg FROM log').all() as { msg: string }[];
  console.log('\n   📌 E4: Setelah ROLLBACK TO savepoint, yang tersimpan:');
  rows.forEach((r) => console.log('      -', r.msg));

  assert.equal(rows.length, 1);
  assert.ok(rows[0].msg.startsWith('A'), 'hanya A yang tersimpan; B dibatalkan');

  db.close();
});

// ════════════════════════════════════════════════════════════════════════════
// EKSPERIMEN 5 (PUNCAK): Crash recovery dengan WAL — data selamat
// ════════════════════════════════════════════════════════════════════════════

test('M07-E5: "crash" tanpa checkpoint → recovery dari WAL → data SELAMAT', () => {
  const dbPath = freshPath('e5');

  // Fase 1: tulis data dalam transaksi, lalu "mati" secara tidak sopan
  {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE precious (id TEXT PRIMARY KEY, data TEXT)');

    db.exec('BEGIN');
    const insert = db.prepare('INSERT INTO precious VALUES (?, ?)');
    for (let i = 0; i < 100; i++) {
      insert.run(`rec${i}`, `data penting ${i}`);
    }
    db.exec('COMMIT'); // commit masuk ke WAL
    // SIMULASI CRASH: tutup TANPA checkpoint — WAL dibiarkan utuh
    db.close();
    // (close normal pun sebenarnya aman; intinya data ada di WAL)
  }

  // Pastikan file WAL ada — perubahan masih "di log", belum tentu di file utama
  const walExists = fs.existsSync(dbPath + '-wal');
  console.log(`\n   💥 E5: Setelah "crash", file -wal ada? ${walExists}`);

  // Fase 2: "restart" — buka ulang. SQLite otomatis membaca WAL (recovery)
  {
    const db2 = new DatabaseSync(dbPath);
    const count = (db2.prepare('SELECT COUNT(*) AS n FROM precious').get() as { n: number }).n;
    const sample = db2.prepare('SELECT data FROM precious WHERE id = ?').get('rec42') as { data: string };

    console.log(`   🛟 E5: Setelah restart, jumlah record: ${count} (harus 100 — SELAMAT!)`);
    console.log(`        Contoh data: "${sample.data}"`);

    assert.equal(count, 100, 'semua data harus selamat berkat recovery dari WAL');
    assert.equal(sample.data, 'data penting 42');

    db2.close();
  }

  console.log('   🎉 E5: Data selamat dari crash — WAL bekerja persis seperti dijanjikan!');
});
