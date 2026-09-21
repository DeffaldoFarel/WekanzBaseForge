// ============================================================================
// D6: TEST NESTED EXPAND
//
// Membuktikan expand bertingkat (a.b, a.b.c) bekerja, tetap batch loading
// di setiap level, dan kedalaman dibatasi.
// ============================================================================

import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initSchemaTable, defineCollection, getCollectionByName } from '../src/core/schema.js';
import { createRecord } from '../src/core/records.js';
import { expandRecords, QueryCounter } from '../src/core/relations.js';

const TEST_DIR = path.resolve('../data/d6-test');

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
let counter = 0;

function freshDb(): DatabaseSync {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(TEST_DIR, `t-${Date.now()}-${counter++}.db`));
  db.exec('PRAGMA journal_mode = WAL');
  initSchemaTable(db);

  // Rantai relasi: habits → users → profiles
  defineCollection(db, { name: 'profiles', fields: [{ name: 'bio', type: 'text' }] });
  defineCollection(db, {
    name: 'users',
    fields: [
      { name: 'name', type: 'text', required: true },
      { name: 'profile', type: 'relation', options: { collectionId: 'profiles' } },
    ],
  });
  defineCollection(db, {
    name: 'habits',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'user', type: 'relation', options: { collectionId: 'users' } },
    ],
  });

  return db;
}

// ════════════════════════════════════════════════════════════════════════════

test('D6: expand 2 level (habit → user → profile) bekerja', () => {
  const db = freshDb();

  const profile = createRecord(db, 'profiles', { bio: 'Halo saya Farel' });
  const user = createRecord(db, 'users', { name: 'Farel', profile: profile.id });
  createRecord(db, 'habits', { title: 'Olahraga', user: user.id });

  const habitsMeta = getCollectionByName(db, 'habits')!;
  const habits = db.prepare('SELECT * FROM habits').all() as never[];
  const expanded = expandRecords(db, habits as never, habitsMeta, 'user.profile');

  const habit = expanded[0] as {
    expand?: { user?: { name: string; expand?: { profile?: { bio: string } } } };
  };

  console.log('\n   🔗 Nested expand:', JSON.stringify(habit.expand, null, 1).slice(0, 300));

  assert.equal(habit.expand?.user?.name, 'Farel', 'level 1 (user) harus ada');
  assert.equal(habit.expand?.user?.expand?.profile?.bio, 'Halo saya Farel', 'level 2 (profile) harus ada');

  db.close();
});

test('D6: setiap level batch loading (bukan N+1 berlapis)', () => {
  const db = freshDb();

  // Buat 5 habits yang merujuk ke 2 users berbeda (dengan profile)
  const p1 = createRecord(db, 'profiles', { bio: 'Bio 1' });
  const p2 = createRecord(db, 'profiles', { bio: 'Bio 2' });
  const u1 = createRecord(db, 'users', { name: 'User 1', profile: p1.id });
  const u2 = createRecord(db, 'users', { name: 'User 2', profile: p2.id });

  for (let i = 0; i < 5; i++) {
    createRecord(db, 'habits', { title: `Habit ${i}`, user: i % 2 === 0 ? u1.id : u2.id });
  }

  const habitsMeta = getCollectionByName(db, 'habits')!;
  const habits = db.prepare('SELECT * FROM habits').all() as never[];

  const counter = new QueryCounter();
  expandRecords(db, habits as never, habitsMeta, 'user.profile', counter);

  console.log(`\n   🚀 Expand 2-level untuk 5 habits: ${counter.count} query`);
  console.log('      (level user: 1 query + level profile: 1 query = 2, bukan 5+5!)');

  // Level user: 1 query untuk semua habits. Level profile: 1 query untuk semua users.
  // Total seharusnya 2 (bukan 5 user-queries + 5 profile-queries = 10)
  assert.ok(counter.count <= 2, `batch loading per level harus ≤2 query, dapat ${counter.count}`);

  db.close();
});

test('D6: kedalaman dibatasi (tidak ada rekursi tak terkendali)', () => {
  const db = freshDb();

  const p = createRecord(db, 'profiles', { bio: 'X' });
  const u = createRecord(db, 'users', { name: 'Y', profile: p.id });
  createRecord(db, 'habits', { title: 'Z', user: u.id });

  const habitsMeta = getCollectionByName(db, 'habits')!;
  const habits = db.prepare('SELECT * FROM habits').all() as never[];

  // Expand dengan spek sangat dalam (di luar batas)
  const expanded = expandRecords(
    db,
    habits as never,
    habitsMeta,
    'user.profile.profile.profile.profile.profile.profile'
  );

  // Tidak boleh crash/hang — harus berhenti dengan anggun
  assert.ok(expanded, 'harus selesai tanpa hang meski spek terlalu dalam');

  db.close();
});

test('D6: expand 1 level tetap bekerja (kontrol regresi)', () => {
  const db = freshDb();

  const u = createRecord(db, 'users', { name: 'Farel' });
  createRecord(db, 'habits', { title: 'Olahraga', user: u.id });

  const habitsMeta = getCollectionByName(db, 'habits')!;
  const habits = db.prepare('SELECT * FROM habits').all() as never[];
  const expanded = expandRecords(db, habits as never, habitsMeta, 'user');

  const habit = expanded[0] as { expand?: { user?: { name: string } } };
  assert.equal(habit.expand?.user?.name, 'Farel');

  db.close();
});
