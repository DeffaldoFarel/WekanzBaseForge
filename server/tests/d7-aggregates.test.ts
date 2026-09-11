// ============================================================================
// D7: TEST AGGREGATES
//
// Membuktikan count/sum/avg/min/max + GROUP BY bekerja dengan benar.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initSchemaTable, defineCollection } from '../src/core/schema.js';
import { createRecord } from '../src/core/records.js';
import { aggregate, AggregateSingleResult, AggregateGroupResult } from '../src/core/aggregates.js';

const TEST_DIR = path.resolve('../data/d7-test');
let counter = 0;

function freshDb(): DatabaseSync {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(TEST_DIR, `t-${Date.now()}-${counter++}.db`));
  db.exec('PRAGMA journal_mode = WAL');
  initSchemaTable(db);

  defineCollection(db, {
    name: 'habits',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'streak', type: 'number' },
      { name: 'category', type: 'text' },
    ],
  });

  // Seed data
  // category health: streak 7, 3  → sum 10, avg 5, count 2
  // category learn:  streak 10, 2  → sum 12, avg 6, count 2
  createRecord(db, 'habits', { title: 'Olahraga', streak: 7, category: 'health' });
  createRecord(db, 'habits', { title: 'Tidur awal', streak: 3, category: 'health' });
  createRecord(db, 'habits', { title: 'Baca buku', streak: 10, category: 'learn' });
  createRecord(db, 'habits', { title: 'Kursus', streak: 2, category: 'learn' });

  return db;
}

// ════════════════════════════════════════════════════════════════════════════

test('D7: count menghitung jumlah record', () => {
  const db = freshDb();

  const result = aggregate(db, 'habits', { function: 'count' }) as AggregateSingleResult;
  console.log('\n   🔢 COUNT habits:', result.value);
  assert.equal(result.value, 4);

  db.close();
});

test('D7: count dengan filter (reuse M04 parser)', () => {
  const db = freshDb();

  const result = aggregate(db, 'habits', {
    function: 'count',
    filter: 'streak > 5',
  }) as AggregateSingleResult;

  console.log('   🔢 COUNT streak>5:', result.value, '(harus 2: Olahraga 7, Baca 10)');
  assert.equal(result.value, 2);

  db.close();
});

test('D7: sum menjumlahkan field number', () => {
  const db = freshDb();

  const result = aggregate(db, 'habits', { function: 'sum', field: 'streak' }) as AggregateSingleResult;
  console.log('   ➕ SUM streak:', result.value, '(harus 22: 7+3+10+2)');
  assert.equal(result.value, 22);

  db.close();
});

test('D7: avg menghitung rata-rata', () => {
  const db = freshDb();

  const result = aggregate(db, 'habits', { function: 'avg', field: 'streak' }) as AggregateSingleResult;
  console.log('   📊 AVG streak:', result.value, '(harus 5.5)');
  assert.equal(result.value, 5.5);

  db.close();
});

test('D7: min dan max bekerja', () => {
  const db = freshDb();

  const min = aggregate(db, 'habits', { function: 'min', field: 'streak' }) as AggregateSingleResult;
  const max = aggregate(db, 'habits', { function: 'max', field: 'streak' }) as AggregateSingleResult;

  assert.equal(min.value, 2);
  assert.equal(max.value, 10);

  db.close();
});

test('D7: GROUP BY menghasilkan agregat per kelompok', () => {
  const db = freshDb();

  const result = aggregate(db, 'habits', {
    function: 'avg',
    field: 'streak',
    groupBy: 'category',
  }) as AggregateGroupResult;

  console.log('\n   📊 AVG streak per category:');
  for (const g of result.groups) console.log(`      ${g.group}: ${g.value}`);

  assert.equal(result.groups.length, 2);

  const health = result.groups.find((g) => g.group === 'health');
  const learn = result.groups.find((g) => g.group === 'learn');

  assert.equal(health?.value, 5);  // (7+3)/2
  assert.equal(learn?.value, 6);   // (10+2)/2

  db.close();
});

test('D7: GROUP BY dengan count per kategori', () => {
  const db = freshDb();

  const result = aggregate(db, 'habits', {
    function: 'count',
    groupBy: 'category',
  }) as AggregateGroupResult;

  assert.equal(result.groups.length, 2);
  for (const g of result.groups) {
    assert.equal(g.value, 2); // setiap kategori punya 2
  }

  db.close();
});

test('D7: validasi — aggregate numerik pada field non-number DITOLAK', () => {
  const db = freshDb();

  assert.throws(() => {
    aggregate(db, 'habits', { function: 'sum', field: 'title' });
  }, /number/);

  db.close();
});

test('D7: validasi — field yang tidak ada DITOLAK', () => {
  const db = freshDb();

  assert.throws(() => {
    aggregate(db, 'habits', { function: 'sum', field: 'hantu' });
  }, /tidak ada/);

  assert.throws(() => {
    aggregate(db, 'habits', { function: 'count', groupBy: 'hantu' });
  }, /tidak ada/);

  db.close();
});
