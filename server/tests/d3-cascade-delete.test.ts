// ============================================================================
// D3: TEST CASCADE DELETE
//
// Membuktikan ketiga strategi (cascade, setNull, restrict) bekerja dengan
// benar, termasuk pada multi-relation, dan restrict itu atomik.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initSchemaTable, defineCollection } from '../src/core/schema.js';
import { createRecord, getRecord, deleteRecord, RestrictError } from '../src/core/records.js';

const TEST_DIR = path.resolve('../data/d3-test');
let counter = 0;

function freshDb(): DatabaseSync {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(TEST_DIR, `t-${Date.now()}-${counter++}.db`));
  db.exec('PRAGMA journal_mode = WAL');
  initSchemaTable(db);
  return db;
}

// ════════════════════════════════════════════════════════════════════════════
// CASCADE
// ════════════════════════════════════════════════════════════════════════════

test('D3: cascade — hapus user → habits-nya ikut terhapus', () => {
  const db = freshDb();

  defineCollection(db, { name: 'users', fields: [{ name: 'name', type: 'text' }] });
  defineCollection(db, {
    name: 'habits',
    fields: [
      { name: 'title', type: 'text' },
      { name: 'user', type: 'relation', options: { collectionId: 'users', cascadeDelete: 'cascade' } },
    ],
  });

  const user = createRecord(db, 'users', { name: 'Farel' });
  createRecord(db, 'habits', { title: 'Olahraga', user: user.id });
  createRecord(db, 'habits', { title: 'Baca', user: user.id });

  // Hapus user
  deleteRecord(db, 'users', user.id);

  // Habits harus ikut terhapus
  const habitCount = (db.prepare('SELECT COUNT(*) AS n FROM habits').get() as { n: number }).n;
  console.log(`\n   🗑️  Cascade: setelah user dihapus, sisa habits = ${habitCount} (harus 0)`);
  assert.equal(habitCount, 0);

  db.close();
});

// ════════════════════════════════════════════════════════════════════════════
// SET NULL (default)
// ════════════════════════════════════════════════════════════════════════════

test('D3: setNull — hapus user → habits tetap ada tapi user jadi null', () => {
  const db = freshDb();

  defineCollection(db, { name: 'users', fields: [{ name: 'name', type: 'text' }] });
  defineCollection(db, {
    name: 'habits',
    fields: [
      { name: 'title', type: 'text' },
      // TIDAK disebut cascadeDelete → default 'setNull'
      { name: 'user', type: 'relation', options: { collectionId: 'users' } },
    ],
  });

  const user = createRecord(db, 'users', { name: 'Farel' });
  const habit = createRecord(db, 'habits', { title: 'Olahraga', user: user.id });

  deleteRecord(db, 'users', user.id);

  // Habit tetap ada
  const surviving = getRecord(db, 'habits', habit.id);
  assert.ok(surviving, 'habit harus tetap ada (setNull)');
  assert.equal(surviving.user, null, 'field user harus jadi null');

  console.log('\n   🔗 SetNull: habit tetap ada, user =', surviving.user);

  db.close();
});

// ════════════════════════════════════════════════════════════════════════════
// RESTRICT
// ════════════════════════════════════════════════════════════════════════════

test('D3: restrict — hapus user yang masih punya habits → DITOLAK', () => {
  const db = freshDb();

  defineCollection(db, { name: 'users', fields: [{ name: 'name', type: 'text' }] });
  defineCollection(db, {
    name: 'habits',
    fields: [
      { name: 'title', type: 'text' },
      { name: 'user', type: 'relation', options: { collectionId: 'users', cascadeDelete: 'restrict' } },
    ],
  });

  const user = createRecord(db, 'users', { name: 'Farel' });
  createRecord(db, 'habits', { title: 'Olahraga', user: user.id });
  createRecord(db, 'habits', { title: 'Baca', user: user.id });

  // Coba hapus user → harus DITOLAK
  let error: Error | null = null;
  try {
    deleteRecord(db, 'users', user.id);
  } catch (e) {
    error = e as Error;
  }

  assert.ok(error instanceof RestrictError, 'harus RestrictError');
  console.log('\n   🛡️  Restrict error:', error.message);
  assert.ok(error.message.includes('restrict'), 'pesan menyebut restrict');
  assert.ok(error.message.includes('habits'), 'pesan menyebut collection perujuk');

  // User harus TETAP ADA (restrict menolak penghapusan)
  const surviving = getRecord(db, 'users', user.id);
  assert.ok(surviving, 'user harus tetap ada karena restrict');
  assert.equal(surviving.name, 'Farel');

  // Habits juga harus tetap ada (tidak ada yang terhapus — atomik!)
  const habitCount = (db.prepare('SELECT COUNT(*) AS n FROM habits').get() as { n: number }).n;
  assert.equal(habitCount, 2, 'restrict atomik: tidak ada perubahan sebagian');

  db.close();
});

test('D3: restrict — hapus user TANPA rujukan → BOLEH', () => {
  const db = freshDb();

  defineCollection(db, { name: 'users', fields: [{ name: 'name', type: 'text' }] });
  defineCollection(db, {
    name: 'habits',
    fields: [
      { name: 'title', type: 'text' },
      { name: 'user', type: 'relation', options: { collectionId: 'users', cascadeDelete: 'restrict' } },
    ],
  });

  const user = createRecord(db, 'users', { name: 'Sendirian' }); // tidak punya habits

  // Hapus user tanpa rujukan → boleh
  const deleted = deleteRecord(db, 'users', user.id);
  assert.equal(deleted, true);
  assert.equal(getRecord(db, 'users', user.id), null);

  db.close();
});

// ════════════════════════════════════════════════════════════════════════════
// MULTI-RELATION (D2 + D3)
// ════════════════════════════════════════════════════════════════════════════

test('D3: setNull pada multi-relation → hapus HANYA id itu dari array', () => {
  const db = freshDb();

  defineCollection(db, { name: 'tags', fields: [{ name: 'label', type: 'text' }] });
  defineCollection(db, {
    name: 'posts',
    fields: [
      { name: 'title', type: 'text' },
      {
        name: 'tags',
        type: 'relation',
        options: { collectionId: 'tags', maxSelect: 5, cascadeDelete: 'setNull' },
      },
    ],
  });

  const t1 = createRecord(db, 'tags', { label: 'sqlite' });
  const t2 = createRecord(db, 'tags', { label: 'database' });
  const t3 = createRecord(db, 'tags', { label: 'tutorial' });

  const post = createRecord(db, 'posts', { title: 'Post A', tags: [t1.id, t2.id, t3.id] });

  // Hapus tag t2 → harus dihapus HANYA t2 dari array, t1 & t3 tetap
  deleteRecord(db, 'tags', t2.id);

  const surviving = getRecord(db, 'posts', post.id);
  const tags = surviving?.tags as string[];
  console.log('\n   🏷️  Setelah t2 dihapus, sisa tags:', tags);

  assert.ok(Array.isArray(tags));
  assert.equal(tags.length, 2, 'harus tersisa 2 tag');
  assert.ok(!tags.includes(t2.id), 't2 harus hilang dari array');
  assert.ok(tags.includes(t1.id) && tags.includes(t3.id), 't1 & t3 tetap');

  db.close();
});

test('D3: cascade pada multi-relation → hapus record anak yang merujuk', () => {
  const db = freshDb();

  defineCollection(db, { name: 'tags', fields: [{ name: 'label', type: 'text' }] });
  defineCollection(db, {
    name: 'posts',
    fields: [
      { name: 'title', type: 'text' },
      {
        name: 'tags',
        type: 'relation',
        options: { collectionId: 'tags', maxSelect: 5, cascadeDelete: 'cascade' },
      },
    ],
  });

  const t1 = createRecord(db, 'tags', { label: 'sqlite' });
  const post = createRecord(db, 'posts', { title: 'Post A', tags: [t1.id] });

  deleteRecord(db, 'tags', t1.id);

  assert.equal(getRecord(db, 'posts', post.id), null, 'post yang merujuk harus ikut terhapus');

  db.close();
});
