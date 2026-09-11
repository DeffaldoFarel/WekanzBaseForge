// ============================================================================
// D2: TEST MULTI-RELATION
//
// Membuktikan: satu record bisa punya BANYAK relasi (array of ids),
// disimpan sebagai JSON array, expand menghasilkan array of objects,
// dan tetap memakai batch loading (bukan N+1).
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initSchemaTable, defineCollection, getCollectionByName } from '../src/core/schema.js';
import { createRecord, getRecord } from '../src/core/records.js';
import { expandRecords, QueryCounter } from '../src/core/relations.js';

const TEST_DIR = path.resolve('../data/d2-test');
let counter = 0;

function freshDb(): DatabaseSync {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(TEST_DIR, `t-${Date.now()}-${counter++}.db`));
  db.exec('PRAGMA journal_mode = WAL');
  initSchemaTable(db);

  // tags (tujuan relasi)
  defineCollection(db, {
    name: 'tags',
    fields: [{ name: 'label', type: 'text', required: true }],
  });

  // posts dengan multi-relation ke tags (maxSelect 5) + single relation ke author
  defineCollection(db, {
    name: 'posts',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'tags', type: 'relation', options: { collectionId: 'tags', maxSelect: 5 } },
      { name: 'author', type: 'relation', options: { collectionId: 'users', maxSelect: 1 } },
    ],
  });

  defineCollection(db, {
    name: 'users',
    fields: [{ name: 'name', type: 'text', required: true }],
  });

  return db;
}

// ════════════════════════════════════════════════════════════════════════════

test('D2: multi-relation disimpan sebagai JSON array di DB mentah', () => {
  const db = freshDb();

  const t1 = createRecord(db, 'tags', { label: 'sqlite' }).id;
  const t2 = createRecord(db, 'tags', { label: 'database' }).id;

  const post = createRecord(db, 'posts', {
    title: 'Belajar SQLite',
    tags: [t1, t2],
  });

  // Bukti di DB mentah: tersimpan sebagai JSON array string
  const raw = db.prepare('SELECT tags FROM posts WHERE id = ?').get(post.id) as { tags: string };
  console.log('\n   💾 Nilai mentah di DB:', raw.tags);
  assert.equal(raw.tags, JSON.stringify([t1, t2]));

  db.close();
});

test('D2: deserialize mengembalikan array ke user (bukan string)', () => {
  const db = freshDb();

  const t1 = createRecord(db, 'tags', { label: 'sqlite' }).id;
  const t2 = createRecord(db, 'tags', { label: 'database' }).id;
  const post = createRecord(db, 'posts', { title: 'X', tags: [t1, t2] });

  const fetched = getRecord(db, 'posts', post.id);
  assert.ok(Array.isArray(fetched?.tags), 'tags harus kembali sebagai array');
  assert.deepEqual(fetched?.tags, [t1, t2]);

  db.close();
});

test('D2: validasi — nilai non-array pada multi-relation DITOLAK', () => {
  const db = freshDb();

  assert.throws(() => {
    createRecord(db, 'posts', { title: 'X', tags: 'bukan-array' as never });
  }, /array of record ids/);

  db.close();
});

test('D2: validasi — melebihi maxSelect DITOLAK', () => {
  const db = freshDb();

  const tagIds = Array.from({ length: 6 }, (_, i) => createRecord(db, 'tags', { label: `t${i}` }).id);

  assert.throws(() => {
    createRecord(db, 'posts', { title: 'X', tags: tagIds }); // 6 > maxSelect 5
  }, /maxSelect/);

  db.close();
});

test('D2: expand multi menghasilkan ARRAY of objects', () => {
  const db = freshDb();

  const t1 = createRecord(db, 'tags', { label: 'sqlite' }).id;
  const t2 = createRecord(db, 'tags', { label: 'database' }).id;
  createRecord(db, 'posts', { title: 'Post A', tags: [t1, t2] });
  createRecord(db, 'posts', { title: 'Post B', tags: [t2] });

  const postsMeta = getCollectionByName(db, 'posts')!;
  const posts = db.prepare('SELECT * FROM posts').all() as never[];
  const expanded = expandRecords(db, posts as never, postsMeta, 'tags');

  const postA = expanded.find((p) => (p as { title: string }).title === 'Post A') as {
    expand?: { tags?: { label: string }[] };
  };

  assert.ok(Array.isArray(postA?.expand?.tags), 'expand.tags harus array');
  assert.equal(postA.expand.tags.length, 2);
  const labels = postA.expand.tags.map((t) => t.label);
  assert.ok(labels.includes('sqlite'));
  assert.ok(labels.includes('database'));

  console.log('\n   🔗 Expand multi Post A:', labels);

  db.close();
});

test('D2: expand multi memakai BATCH loading (bukan N+1)', () => {
  const db = freshDb();

  // Buat 5 tags dan 4 posts yang merujuk berbagai kombinasi
  const tagIds = Array.from({ length: 5 }, (_, i) => createRecord(db, 'tags', { label: `tag${i}` }).id);
  for (let i = 0; i < 4; i++) {
    createRecord(db, 'posts', { title: `Post ${i}`, tags: [tagIds[i], tagIds[4]] });
  }

  const postsMeta = getCollectionByName(db, 'posts')!;
  const posts = db.prepare('SELECT * FROM posts').all() as never[];

  const counter = new QueryCounter();
  expandRecords(db, posts as never, postsMeta, 'tags', counter);

  console.log(`\n   🚀 Expand 4 posts dengan multi-relation: ${counter.count} query (harus 1)`);
  assert.equal(counter.count, 1, 'batch loading harus hanya 1 query untuk semua');

  db.close();
});

test('D2: single relation (maxSelect 1) tetap bekerja seperti M12 (kontrol)', () => {
  const db = freshDb();

  const user = createRecord(db, 'users', { name: 'Farel' });
  createRecord(db, 'posts', { title: 'Post dengan author', author: user.id });

  const postsMeta = getCollectionByName(db, 'posts')!;
  const posts = db.prepare('SELECT * FROM posts').all() as never[];
  const expanded = expandRecords(db, posts as never, postsMeta, 'author');

  const post = expanded[0] as { expand?: { author?: { name: string } } };
  assert.equal(post.expand?.author?.name, 'Farel', 'single expand harus object, bukan array');
  assert.ok(!Array.isArray(post.expand?.author), 'single expand bukan array');

  db.close();
});
