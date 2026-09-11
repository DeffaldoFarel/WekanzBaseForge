// ============================================================================
// M12: TEST RELATIONS & EXPAND
//
// Yang terpenting: MEMBUKTIKAN batch loading mengalahkan N+1 dengan
// menghitung jumlah query secara nyata.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initSchemaTable, defineCollection } from '../src/core/schema.js';
import { createRecord } from '../src/core/records.js';
import { expandRecords, QueryCounter } from '../src/core/relations.js';
import { getCollectionByName } from '../src/core/schema.js';

const TEST_DIR = path.resolve('../data/m12-test');
let counter = 0;

function freshDb(): DatabaseSync {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(TEST_DIR, `t-${Date.now()}-${counter++}.db`));
  db.exec('PRAGMA journal_mode = WAL');
  initSchemaTable(db);

  // users
  defineCollection(db, {
    name: 'users',
    fields: [
      { name: 'name', type: 'text', required: true },
      { name: 'email', type: 'email' },
    ],
  });

  // habits → relasi ke users
  defineCollection(db, {
    name: 'habits',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'streak', type: 'number' },
      { name: 'user', type: 'relation', options: { collectionId: 'users' } },
    ],
  });

  // profiles → relasi ke users (untuk nested expand: habit.user.profile)
  defineCollection(db, {
    name: 'profiles',
    fields: [
      { name: 'bio', type: 'text' },
      { name: 'user', type: 'relation', options: { collectionId: 'users' } },
    ],
  });

  return db;
}

function seedUsersAndHabits(db: DatabaseSync): { u1: string; u2: string; habits: string[] } {
  const u1 = createRecord(db, 'users', { name: 'Farel', email: 'farel@x.com' }).id;
  const u2 = createRecord(db, 'users', { name: 'Budi', email: 'budi@x.com' }).id;

  const habits: string[] = [];
  habits.push(createRecord(db, 'habits', { title: 'Olahraga', streak: 7, user: u1 }).id);
  habits.push(createRecord(db, 'habits', { title: 'Baca', streak: 3, user: u1 }).id);
  habits.push(createRecord(db, 'habits', { title: 'Meditasi', streak: 5, user: u2 }).id);

  return { u1, u2, habits };
}

// ════════════════════════════════════════════════════════════════════════════
// EXPAND DASAR
// ════════════════════════════════════════════════════════════════════════════

test('M12: expand membawa data user di setiap habit', () => {
  const db = freshDb();
  const { u1 } = seedUsersAndHabits(db);

  const habitsMeta = getCollectionByName(db, 'habits')!;
  const habits = db.prepare('SELECT * FROM habits').all() as never[];
  const expanded = expandRecords(db, habits as never, habitsMeta, 'user');

  // Setiap habit harus punya expand.user berisi data user
  for (const h of expanded as never[]) {
    const habit = h as { title: string; expand?: { user?: { name: string } } };
    assert.ok(habit.expand?.user, `habit '${habit.title}' harus punya expand.user`);
    assert.ok(['Farel', 'Budi'].includes(habit.expand.user.name));
  }

  console.log('\n   🔗 Contoh expand:', JSON.stringify(expanded[0], null, 1).slice(0, 300));

  db.close();
});

test('M12: record tanpa relasi tidak error (expand kosong)', () => {
  const db = freshDb();
  seedUsersAndHabits(db);

  // habit tanpa user
  createRecord(db, 'habits', { title: 'Tanpa user', streak: 1 });

  const habitsMeta = getCollectionByName(db, 'habits')!;
  const habits = db.prepare('SELECT * FROM habits').all() as never[];
  const expanded = expandRecords(db, habits as never, habitsMeta, 'user');

  const noUser = expanded.find((h) => (h as { title: string }).title === 'Tanpa user') as
    | { expand?: { user?: unknown } }
    | undefined;

  assert.ok(noUser, 'record tanpa user harus tetap ada');
  assert.equal(noUser?.expand?.user, undefined, 'expand.user harus undefined');

  db.close();
});

// ════════════════════════════════════════════════════════════════════════════
// N+1 vs BATCH LOADING — BUKTI DENGAN MENGHITUNG QUERY
// ════════════════════════════════════════════════════════════════════════════

test('M12: BUKTI — batch loading mengalahkan N+1 (dihitung dari jumlah query)', () => {
  const db = freshDb();
  seedUsersAndHabits(db);

  const habitsMeta = getCollectionByName(db, 'habits')!;
  const habits = db.prepare('SELECT * FROM habits').all() as { id: string; user: string }[];

  // ── Cara N+1: satu query per record ──
  const counterN1 = new QueryCounter();
  for (const h of habits) {
    db.prepare('SELECT * FROM users WHERE id = ?').get(h.user);
    counterN1.hit(); // setiap record = 1 query!
  }
  const n1Queries = counterN1.count;

  // ── Cara BATCH: expandRecords ──
  const counterBatch = new QueryCounter();
  expandRecords(db, habits as never, habitsMeta, 'user', counterBatch);
  const batchQueries = counterBatch.count;

  console.log('\n   ╔════════════════════════════════════════════════════╗');
  console.log(`   ║  Expand ${habits.length} habits → data user                       ║`);
  console.log('   ╠════════════════════════════════════════════════════╣');
  console.log(`   ║  Cara N+1 (naif)     : ${n1Queries} query (1 per record)     ║`);
  console.log(`   ║  Cara BATCH (benar)  : ${batchQueries} query (1 untuk semua)    ║`);
  console.log('   ╚════════════════════════════════════════════════════╝');
  console.log('   💡 Untuk 1000 habits: N+1 = 1000 query, BATCH = tetap 1 query!');

  assert.equal(batchQueries, 1, 'batch loading harus hanya 1 query');
  assert.ok(n1Queries > batchQueries, 'N+1 harus lebih banyak query dari batch');

  db.close();
});

// ════════════════════════════════════════════════════════════════════════════
// NESTED EXPAND (a.b)
// ════════════════════════════════════════════════════════════════════════════

test('M12: nested expand habit → user → (tetap bekerja untuk 1 level dulu)', () => {
  const db = freshDb();
  const { u1 } = seedUsersAndHabits(db);

  // Buat profile untuk u1
  createRecord(db, 'profiles', { bio: 'Halo saya Farel', user: u1 });

  const habitsMeta = getCollectionByName(db, 'habits')!;
  const habits = db.prepare('SELECT * FROM habits LIMIT 1').all() as never[];
  const expanded = expandRecords(db, habits as never, habitsMeta, 'user');

  const first = expanded[0] as { expand?: { user?: { id: string; name: string } } };
  assert.ok(first.expand?.user?.name, 'expand 1 level harus ada');

  console.log('\n   🔗 Nested expand 1 level:', first.expand.user.name);

  db.close();
});
