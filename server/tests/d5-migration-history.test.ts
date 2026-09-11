// ============================================================================
// D5: TEST MIGRATION HISTORY
//
// Membuktikan setiap perubahan skema tercatat di _migrations dengan benar.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  initSchemaTable,
  defineCollection,
  updateCollection,
  rebuildCollection,
  deleteCollection,
  getMigrations,
  getSchemaVersion,
} from '../src/core/schema.js';

const TEST_DIR = path.resolve('../data/d5-test');
let counter = 0;

function freshDb(): DatabaseSync {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(TEST_DIR, `t-${Date.now()}-${counter++}.db`));
  db.exec('PRAGMA journal_mode = WAL');
  initSchemaTable(db);
  return db;
}

// ════════════════════════════════════════════════════════════════════════════

test('D5: tabel _migrations terbentuk otomatis', () => {
  const db = freshDb();

  const table = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'`)
    .get();
  assert.ok(table, '_migrations harus ada');

  db.close();
});

test('D5: defineCollection mencatat migrasi create', () => {
  const db = freshDb();

  defineCollection(db, {
    name: 'habits',
    fields: [{ name: 'title', type: 'text' }],
  });

  const migrations = getMigrations(db);
  assert.equal(migrations.length, 1);
  assert.equal(migrations[0].collection, 'habits');
  assert.equal(migrations[0].action, 'create');
  assert.ok(migrations[0].applied_at, 'harus ada timestamp');

  console.log('\n   📜 Migrasi pertama:', migrations[0].action, 'pada', migrations[0].collection);

  db.close();
});

test('D5: semua operasi skema tercatat berurutan', () => {
  const db = freshDb();

  // 1. create
  defineCollection(db, {
    name: 'habits',
    fields: [{ name: 'title', type: 'text' }],
  });

  // 2. add_column
  updateCollection(db, 'habits', {
    fields: [
      { name: 'title', type: 'text' },
      { name: 'note', type: 'text' },
    ],
  });

  // 3. rebuild
  rebuildCollection(db, 'habits', {
    fields: [{ name: 'title', type: 'text' }],
  });

  // 4. drop
  deleteCollection(db, 'habits');

  const migrations = getMigrations(db, 'habits');
  const actions = migrations.map((m) => m.action);

  console.log('\n   📜 Urutan migrasi habits:', actions.join(' → '));

  assert.deepEqual(actions, ['create', 'add_column', 'rebuild', 'drop']);
  assert.equal(migrations.length, 4);

  db.close();
});

test('D5: rebuild mencatat before & after', () => {
  const db = freshDb();

  defineCollection(db, {
    name: 'users',
    fields: [
      { name: 'email', type: 'email' },
      { name: 'age', type: 'number' },
    ],
  });

  rebuildCollection(db, 'users', {
    fields: [
      { name: 'email', type: 'email' },
      { name: 'age', type: 'text' }, // ubah tipe
    ],
  });

  const migrations = getMigrations(db, 'users');
  const rebuild = migrations.find((m) => m.action === 'rebuild');

  assert.ok(rebuild, 'harus ada migrasi rebuild');
  assert.ok(Array.isArray(rebuild.changes.before), 'harus ada before');
  assert.ok(Array.isArray(rebuild.changes.after), 'harus ada after');

  const ageAfter = (rebuild.changes.after as { name: string; type: string }[]).find((f) => f.name === 'age');
  assert.equal(ageAfter?.type, 'text');

  console.log('\n   📜 Rebuild tercatat: age berubah dari number → text');

  db.close();
});

test('D5: getSchemaVersion menghitung jumlah perubahan', () => {
  const db = freshDb();

  defineCollection(db, { name: 'posts', fields: [{ name: 'title', type: 'text' }] });
  updateCollection(db, 'posts', {
    fields: [
      { name: 'title', type: 'text' },
      { name: 'body', type: 'text' },
    ],
  });

  const version = getSchemaVersion(db, 'posts');
  console.log(`\n   🔢 Schema version 'posts': ${version} (harus 2)`);
  assert.equal(version, 2);

  // Collection yang tidak pernah ada → 0
  assert.equal(getSchemaVersion(db, 'tidak-ada'), 0);

  db.close();
});

test('D5: getMigrations per collection hanya mengembalikan miliknya', () => {
  const db = freshDb();

  defineCollection(db, { name: 'a', fields: [{ name: 'x', type: 'text' }] });
  defineCollection(db, { name: 'b', fields: [{ name: 'y', type: 'text' }] });
  updateCollection(db, 'a', {
    fields: [
      { name: 'x', type: 'text' },
      { name: 'z', type: 'text' },
    ],
  });

  const aMigrations = getMigrations(db, 'a');
  assert.equal(aMigrations.length, 2); // create + add_column
  assert.ok(aMigrations.every((m) => m.collection === 'a'));

  const all = getMigrations(db);
  assert.equal(all.length, 3); // create a, create b, update a

  db.close();
});
