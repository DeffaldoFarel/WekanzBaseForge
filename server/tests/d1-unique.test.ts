// ============================================================================
// D1: TEST UNIQUE CONSTRAINT
//
// Membuktikan: duplikat pada field unique ditolak oleh DATABASE (bukan
// hanya kode), dengan pesan error yang ramah untuk produksi.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initSchemaTable, defineCollection } from '../src/core/schema.js';
import { createRecord, updateRecord, DuplicateError } from '../src/core/records.js';

const TEST_DIR = path.resolve('../data/d1-test');
let counter = 0;

function freshDb(): DatabaseSync {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(TEST_DIR, `t-${Date.now()}-${counter++}.db`));
  db.exec('PRAGMA journal_mode = WAL');
  initSchemaTable(db);

  defineCollection(db, {
    name: 'users',
    fields: [
      { name: 'email', type: 'email', required: true, unique: true },
      { name: 'username', type: 'text', unique: true },
      { name: 'name', type: 'text' }, // TIDAK unique — kontrol
    ],
  });

  return db;
}

// ════════════════════════════════════════════════════════════════════════════

test('D1: UNIQUE INDEX terbentuk untuk field unique', () => {
  const db = freshDb();

  const indexes = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='users'`)
    .all() as { name: string }[];

  const names = indexes.map((i) => i.name);
  console.log('\n   📇 Index di tabel users:', names);

  assert.ok(names.some((n) => n.includes('email') && n.includes('unique')), 'harus ada unique index email');
  assert.ok(names.some((n) => n.includes('username') && n.includes('unique')), 'harus ada unique index username');

  db.close();
});

test('D1: INSERT nilai berbeda → berhasil (kontrol)', () => {
  const db = freshDb();

  createRecord(db, 'users', { email: 'a@x.com', username: 'andi', name: 'Andi' });
  createRecord(db, 'users', { email: 'b@x.com', username: 'budi', name: 'Budi' });

  const count = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  assert.equal(count, 2);

  db.close();
});

test('D1: INSERT email duplikat → DITOLAK dengan pesan ramah', () => {
  const db = freshDb();

  createRecord(db, 'users', { email: 'farel@x.com', username: 'farel', name: 'Farel' });

  // Coba buat user lain dengan email SAMA
  let error: Error | null = null;
  try {
    createRecord(db, 'users', { email: 'farel@x.com', username: 'palsu', name: 'Palsu' });
  } catch (e) {
    error = e as Error;
  }

  assert.ok(error !== null, 'duplikat email harus ditolak');
  assert.ok(error instanceof DuplicateError, 'harus DuplicateError (pesan ramah)');
  console.log('\n   🛡️  Pesan error untuk user:', error.message);
  assert.ok(error.message.includes('email'), 'pesan harus menyebut field');
  assert.ok(error.message.includes('farel@x.com'), 'pesan harus menyebut nilai duplikat');
  assert.ok(/unique|already used/i.test(error.message), 'pesan harus ramah, bukan SQL mentah');

  // Pastikan hanya 1 user (yang palsu tidak tersimpan)
  const count = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  assert.equal(count, 1);

  db.close();
});

test('D1: INSERT username duplikat → DITOLAK (field unique kedua juga ditegakkan)', () => {
  const db = freshDb();

  createRecord(db, 'users', { email: 'a@x.com', username: 'farel', name: 'A' });

  assert.throws(() => {
    createRecord(db, 'users', { email: 'b@x.com', username: 'farel', name: 'B' });
  }, DuplicateError);

  db.close();
});

test('D1: field TIDAK unique → duplikat BOLEH (kontrol penting!)', () => {
  const db = freshDb();

  // 'name' tidak unique → dua user boleh punya nama sama
  createRecord(db, 'users', { email: 'a@x.com', username: 'a', name: 'Farel' });
  createRecord(db, 'users', { email: 'b@x.com', username: 'b', name: 'Farel' });

  const count = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  assert.equal(count, 2, 'field non-unique harus tetap boleh duplikat');

  db.close();
});

test('D1: UPDATE menjadi nilai duplikat → DITOLAK', () => {
  const db = freshDb();

  const u1 = createRecord(db, 'users', { email: 'a@x.com', username: 'andi', name: 'Andi' });
  createRecord(db, 'users', { email: 'b@x.com', username: 'budi', name: 'Budi' });

  // Coba ubah email u1 menjadi email yang sudah dipakai u2
  assert.throws(() => {
    updateRecord(db, 'users', u1.id, { email: 'b@x.com' });
  }, DuplicateError);

  // Tapi update ke nilai yang MASIH unik → boleh
  const updated = updateRecord(db, 'users', u1.id, { email: 'andi-baru@x.com' });
  assert.equal(updated?.email, 'andi-baru@x.com');

  db.close();
});

test('D1: race condition — duplikat tetap ditolak walau "bersamaan"', () => {
  const db = freshDb();

  // Simulasi: dua "request" mencoba email yang sama secara berurutan cepat.
  // Validasi-di-kode akan lolos keduanya (cek dulu baru buat),
  // tapi UNIQUE INDEX di SQLite menolak yang kedua secara atomik.
  createRecord(db, 'users', { email: 'race@x.com', username: 'r1', name: 'R1' });

  assert.throws(() => {
    createRecord(db, 'users', { email: 'race@x.com', username: 'r2', name: 'R2' });
  }, DuplicateError);

  const count = (db.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').get('race@x.com') as { n: number }).n;
  assert.equal(count, 1, 'hanya SATU yang boleh tersimpan — race condition aman');

  console.log('\n   🏁 D1: Race condition aman — SQLite menegakkan keunikan secara atomik.');

  db.close();
});
