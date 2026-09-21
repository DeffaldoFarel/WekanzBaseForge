// ============================================================================
// BATCH 1: TEST FIELD select, autodate, url
// ============================================================================

import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initSchemaTable, defineCollection } from '../src/core/schema.js';
import { createRecord, updateRecord, getRecord } from '../src/core/records.js';

const TEST_DIR = path.resolve('../data/b1-test');

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

  defineCollection(db, {
    name: 'tasks',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'status', type: 'select', options: { values: ['todo', 'doing', 'done'] } },
      { name: 'link', type: 'url' },
      { name: 'last_touched', type: 'autodate', options: { onCreate: true, onUpdate: true } },
    ],
  });

  return db;
}

// ════════════════════════════════════════════════════════════════════════════
// SELECT
// ════════════════════════════════════════════════════════════════════════════

test('B1-select: nilai valid dari values diterima', () => {
  const db = freshDb();
  const rec = createRecord(db, 'tasks', { title: 'Task 1', status: 'todo' });
  assert.equal(rec.status, 'todo');
  db.close();
});

test('B1-select: nilai di luar values DITOLAK', () => {
  const db = freshDb();
  assert.throws(() => {
    createRecord(db, 'tasks', { title: 'X', status: 'tidak-valid' });
  }, /must be one of/);
  db.close();
});

// ════════════════════════════════════════════════════════════════════════════
// URL
// ════════════════════════════════════════════════════════════════════════════

test('B1-url: URL valid diterima', () => {
  const db = freshDb();
  const rec = createRecord(db, 'tasks', { title: 'T', link: 'https://example.com/page' });
  assert.equal(rec.link, 'https://example.com/page');
  db.close();
});

test('B1-url: URL tidak valid DITOLAK', () => {
  const db = freshDb();
  assert.throws(() => {
    createRecord(db, 'tasks', { title: 'T', link: 'bukan-url' });
  }, /valid URL/);
  db.close();
});

test('B1-url: protokol non-http DITOLAK', () => {
  const db = freshDb();
  assert.throws(() => {
    createRecord(db, 'tasks', { title: 'T', link: 'ftp://x.com' });
  }, /http/);
  db.close();
});

// ════════════════════════════════════════════════════════════════════════════
// AUTODATE
// ════════════════════════════════════════════════════════════════════════════

test('B1-autodate: terisi otomatis saat create (tanpa user mengisi)', () => {
  const db = freshDb();
  const rec = createRecord(db, 'tasks', { title: 'Auto task' });
  assert.ok(rec.last_touched, 'autodate harus terisi otomatis');
  assert.ok(typeof rec.last_touched === 'string');
  db.close();
});

test('B1-autodate: ter-update otomatis saat record diubah', async () => {
  const db = freshDb();
  const rec = createRecord(db, 'tasks', { title: 'Task', last_touched: undefined });
  const created = rec.last_touched as string;

  // Tunggu sedikit agar timestamp berbeda
  await new Promise((r) => setTimeout(r, 10));

  const updated = updateRecord(db, 'tasks', rec.id, { title: 'Task berubah' });
  const touched = updated?.last_touched as string;

  console.log('\n   🕐 autodate create:', created);
  console.log('   🕐 autodate update:', touched);

  assert.ok(touched >= created, 'autodate harus ter-update saat record diubah');
  db.close();
});
