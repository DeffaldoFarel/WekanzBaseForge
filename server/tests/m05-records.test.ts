// ============================================================================
// M05: TEST RECORD API
//
// Yang paling penting: membuktikan SATU set fungsi bekerja untuk
// DUA collection yang sangat berbeda strukturnya — tanpa perubahan kode.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initSchemaTable, defineCollection } from '../src/core/schema.js';
import {
  createRecord,
  getRecord,
  updateRecord,
  deleteRecord,
  listRecords,
} from '../src/core/records.js';

const TEST_DIR = path.resolve('../data/m05-test');
let counter = 0;

function freshDb(): DatabaseSync {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(TEST_DIR, `t-${Date.now()}-${counter++}.db`));
  db.exec('PRAGMA journal_mode = WAL');
  initSchemaTable(db);

  // Dua collection SANGAT berbeda — untuk membuktikan generik
  defineCollection(db, {
    name: 'habits',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'streak', type: 'number' },
      { name: 'done', type: 'bool' },
    ],
  });

  defineCollection(db, {
    name: 'posts',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'views', type: 'number' },
      { name: 'meta', type: 'json' },
    ],
  });

  return db;
}

// ════════════════════════════════════════════════════════════════════════════
// CREATE + READ
// ════════════════════════════════════════════════════════════════════════════

test('M05: createRecord generate id + timestamps otomatis', () => {
  const db = freshDb();

  const rec = createRecord(db, 'habits', { title: 'Olahraga', streak: 7 });

  assert.ok(rec.id, 'id harus ter-generate');
  assert.equal(rec.id.length, 15);
  assert.ok(rec.created, 'created harus terisi otomatis');
  assert.ok(rec.updated, 'updated harus terisi otomatis');
  assert.equal(rec.title, 'Olahraga');
  assert.equal(rec.streak, 7);

  db.close();
});

test('M05: serialize bool → simpan 1, deserialize → true', () => {
  const db = freshDb();

  const rec = createRecord(db, 'habits', { title: 'Meditasi', done: true });
  assert.equal(rec.done, true, 'bool harus kembali sebagai true, bukan 1');

  // Bukti di DB mentah tersimpan sebagai 1
  const raw = db.prepare('SELECT done FROM habits WHERE id = ?').get(rec.id) as { done: number };
  assert.equal(raw.done, 1, 'di SQLite harus tersimpan sebagai integer 1');

  db.close();
});

test('M05: serialize json → simpan string, deserialize → object', () => {
  const db = freshDb();

  const rec = createRecord(db, 'posts', {
    title: 'Belajar SQLite',
    meta: { tags: ['db', 'sql'], draft: false },
  });

  assert.deepEqual(rec.meta, { tags: ['db', 'sql'], draft: false });

  db.close();
});

test('M05: validasi menolak tipe salah & field asing', () => {
  const db = freshDb();

  // tipe salah
  assert.throws(() => {
    createRecord(db, 'habits', { title: 'X', streak: 'bukan angka' as unknown as number });
  }, /must be a finite number/);

  // field tidak ada di skema
  assert.throws(() => {
    createRecord(db, 'habits', { title: 'X', hacker: 'coba' } as never);
  }, /tidak ada di collection/);

  // required tidak diisi
  assert.throws(() => {
    createRecord(db, 'habits', { streak: 5 } as never);
  }, /required/);

  db.close();
});

// ════════════════════════════════════════════════════════════════════════════
// UPDATE + DELETE
// ════════════════════════════════════════════════════════════════════════════

test('M05: updateRecord mengubah field + updated timestamp', () => {
  const db = freshDb();

  const rec = createRecord(db, 'habits', { title: 'Baca', streak: 3 });
  const updated = updateRecord(db, 'habits', rec.id, { streak: 10 });

  assert.equal(updated?.streak, 10);
  assert.equal(updated?.title, 'Baca'); // tidak berubah
  assert.ok(updated!.updated >= rec.updated);

  assert.equal(updateRecord(db, 'habits', 'id-tidak-ada', { streak: 1 }), null);

  db.close();
});

test('M05: deleteRecord menghapus', () => {
  const db = freshDb();

  const rec = createRecord(db, 'habits', { title: 'Hapus aku' });
  assert.equal(deleteRecord(db, 'habits', rec.id), true);
  assert.equal(getRecord(db, 'habits', rec.id), null);
  assert.equal(deleteRecord(db, 'habits', rec.id), false);

  db.close();
});

// ════════════════════════════════════════════════════════════════════════════
// LIST: filter + sort + pagination
// ════════════════════════════════════════════════════════════════════════════

test('M05: listRecords dengan filter dari query parser M04', () => {
  const db = freshDb();

  createRecord(db, 'habits', { title: 'Olahraga', streak: 7 });
  createRecord(db, 'habits', { title: 'Baca buku', streak: 3 });
  createRecord(db, 'habits', { title: 'Review', streak: 10 });

  const result = listRecords(db, 'habits', { filter: 'streak > 5' });

  assert.equal(result.totalItems, 2);
  assert.equal(result.items.length, 2);
  // semua hasil harus streak > 5
  for (const item of result.items) {
    assert.ok((item.streak as number) > 5);
  }

  db.close();
});

test('M05: listRecords dengan sort descending', () => {
  const db = freshDb();

  createRecord(db, 'habits', { title: 'A', streak: 3 });
  createRecord(db, 'habits', { title: 'B', streak: 9 });
  createRecord(db, 'habits', { title: 'C', streak: 5 });

  const result = listRecords(db, 'habits', { sort: '-streak' });
  const streaks = result.items.map((i) => i.streak);

  assert.deepEqual(streaks, [9, 5, 3]);

  db.close();
});

test('M05: pagination menghitung totalItems & totalPages dengan benar', () => {
  const db = freshDb();

  // Isi 25 record
  for (let i = 1; i <= 25; i++) {
    createRecord(db, 'habits', { title: `Habit ${i}`, streak: i });
  }

  // Halaman 1 (20 per halaman)
  const page1 = listRecords(db, 'habits', { page: 1, perPage: 20, sort: 'streak' });
  assert.equal(page1.totalItems, 25);
  assert.equal(page1.totalPages, 2);
  assert.equal(page1.items.length, 20);

  // Halaman 2 — sisa 5
  const page2 = listRecords(db, 'habits', { page: 2, perPage: 20, sort: 'streak' });
  assert.equal(page2.items.length, 5);

  // Tidak ada duplikat antar halaman
  const ids1 = new Set(page1.items.map((i) => i.id));
  for (const item of page2.items) {
    assert.ok(!ids1.has(item.id), 'halaman 2 tidak boleh duplikat halaman 1');
  }

  db.close();
});

// ════════════════════════════════════════════════════════════════════════════
// BUKTI GENERIK: satu set fungsi untuk DUA collection berbeda
// ════════════════════════════════════════════════════════════════════════════

test('M05: BUKTI GENERIK — fungsi yang sama untuk habits DAN posts', () => {
  const db = freshDb();

  // HABITS: text + number + bool
  const habit = createRecord(db, 'habits', { title: 'Olahraga', streak: 7, done: true });

  // POSTS: text + number + json — STRUKTUR SANGAT BERBEDA
  const post = createRecord(db, 'posts', {
    title: 'Tutorial',
    views: 100,
    meta: { author: 'farel', tags: ['tutorial'] },
  });

  // Fungsi getRecord yang SAMA untuk keduanya
  const gotHabit = getRecord(db, 'habits', habit.id);
  const gotPost = getRecord(db, 'posts', post.id);

  assert.equal(gotHabit?.done, true);
  assert.deepEqual((gotPost?.meta as { author: string }).author, 'farel');

  // Fungsi listRecords yang SAMA untuk keduanya
  const habits = listRecords(db, 'habits', { filter: 'streak > 5' });
  const posts = listRecords(db, 'posts', { filter: 'views >= 50' });

  assert.equal(habits.totalItems, 1);
  assert.equal(posts.totalItems, 1);

  console.log('\n   🎉 SATU set fungsi melayani 2 collection berbeda tanpa hardcode!');

  db.close();
});
