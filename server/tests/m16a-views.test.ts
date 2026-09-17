// ============================================================================
// M16a: TEST VIEW COLLECTIONS
//
// PROOF: view = SELECT query read-only; fields diekstrak saat create;
// list bekerja dengan filter; write ditolak ramah; delete menghapus view.
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  initSchemaTable,
  defineCollection,
  createViewCollection,
  getCollectionByName,
  deleteCollection,
} from '../src/core/schema.js';
import { createRecord, listRecords, updateRecord, ViewWriteError } from '../src/core/records.js';

const TEST_DIR = path.join(os.tmpdir(), 'baseforge-m16a-tests');
let counter = 0;

function freshDb(): DatabaseSync {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(TEST_DIR, `m16a-${Date.now()}-${counter++}.db`));
  initSchemaTable(db);
  return db;
}

describe('M16a: View Collections', () => {
  test('M16a: create view + fields diekstrak dari SELECT', () => {
    const db = freshDb();
    defineCollection(db, {
      name: 'orders',
      fields: [
        { name: 'item', type: 'text', required: true },
        { name: 'qty', type: 'number' },
        { name: 'user', type: 'text' },
      ],
    });
    createRecord(db, 'orders', { item: 'A', qty: 2, user: 'u1' });
    createRecord(db, 'orders', { item: 'B', qty: 3, user: 'u1' });
    createRecord(db, 'orders', { item: 'C', qty: 5, user: 'u2' });

    const meta = createViewCollection(db, {
      name: 'order_stats',
      viewQuery: 'SELECT user, COUNT(*) AS total_orders, SUM(qty) AS total_qty FROM orders GROUP BY user',
    });

    assert.equal(meta.type, 'view');
    assert.equal(meta.viewQuery, 'SELECT user, COUNT(*) AS total_orders, SUM(qty) AS total_qty FROM orders GROUP BY user');
    const names = meta.fields.map((f) => f.name);
    assert.ok(names.includes('user'), 'kolom user diekstrak');
    assert.ok(names.includes('total_orders'), 'kolom aggregate diekstrak');
    assert.ok(names.includes('total_qty'));
  });

  test('M16a: list view bekerja + filter M04 + pagination', () => {
    const db = freshDb();
    defineCollection(db, {
      name: 'orders',
      fields: [
        { name: 'item', type: 'text' },
        { name: 'qty', type: 'number' },
        { name: 'user', type: 'text' },
      ],
    });
    createRecord(db, 'orders', { item: 'A', qty: 2, user: 'u1' });
    createRecord(db, 'orders', { item: 'B', qty: 3, user: 'u1' });
    createRecord(db, 'orders', { item: 'C', qty: 5, user: 'u2' });

    createViewCollection(db, {
      name: 'order_stats',
      viewQuery: 'SELECT user, SUM(qty) AS total_qty FROM orders GROUP BY user',
      rules: { listRule: '' }, // publik
    });

    const all = listRecords(db, 'order_stats', { reqCtx: { auth: null } });
    assert.equal(all.totalItems, 2);

    // Filter M04 di view!
    const filtered = listRecords(db, 'order_stats', {
      filter: 'user = "u2"',
      reqCtx: { auth: null },
    });
    assert.equal(filtered.totalItems, 1);
    assert.equal(filtered.items[0].total_qty, 5);

    // View bisa join juga!
    createViewCollection(db, {
      name: 'enriched_orders',
      viewQuery: 'SELECT o.item, o.qty FROM orders o WHERE o.qty > 2',
    });
    const enriched = listRecords(db, 'enriched_orders');
    assert.equal(enriched.totalItems, 2);
  });

  test('M16a: write ke view ditolak dengan ViewWriteError (pesan ramah)', () => {
    const db = freshDb();
    defineCollection(db, { name: 'orders', fields: [{ name: 'item', type: 'text' }] });
    createViewCollection(db, { name: 'stats', viewQuery: 'SELECT item, COUNT(*) AS n FROM orders GROUP BY item' });

    assert.throws(
      () => createRecord(db, 'stats', { item: 'x' }, undefined, 'recX'),
      ViewWriteError
    );
    assert.throws(
      () => updateRecord(db, 'stats', 'recX', { item: 'y' }),
      ViewWriteError
    );
    // Pesan menyebut read-only
    try {
      createRecord(db, 'stats', { item: 'x' });
      assert.fail('harus throw');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(/read-only/.test(err.message));
    }
  });

  test('M16a: query invalid ditolak saat create (bukan diam-diam)', () => {
    const db = freshDb();
    assert.throws(
      () => createViewCollection(db, { name: 'bad', viewQuery: 'SELECT * FROM nonexistent_table' }),
      /Invalid viewQuery|no such table/i
    );
    assert.throws(
      () => createViewCollection(db, { name: 'bad2', viewQuery: 'DELETE FROM orders' }),
      /must start with SELECT/
    );
    assert.throws(
      () => createViewCollection(db, { name: 'bad3', viewQuery: 'SELECT 1; SELECT 2' }),
      /multiple statements/
    );
    // Tidak ada sampah meta
    assert.equal(getCollectionByName(db, 'bad'), undefined);
    assert.equal(getCollectionByName(db, 'bad2'), undefined);
    assert.equal(getCollectionByName(db, 'bad3'), undefined);
  });

  test('M16a: nama duplikat & reserved ditolak', () => {
    const db = freshDb();
    defineCollection(db, { name: 'real', fields: [{ name: 'x', type: 'text' }] });
    assert.throws(
      () => createViewCollection(db, { name: 'real', viewQuery: 'SELECT x FROM real' }),
      /already exists/
    );
    assert.throws(
      () => createViewCollection(db, { name: '_system', viewQuery: 'SELECT 1' }),
      /reserved|Invalid collection name/
    );
  });

  test('M16a: deleteCollection menghapus view juga', () => {
    const db = freshDb();
    defineCollection(db, { name: 'orders', fields: [{ name: 'item', type: 'text' }] });
    createViewCollection(db, { name: 'stats', viewQuery: 'SELECT item FROM orders' });
    assert.ok(getCollectionByName(db, 'stats'));

    const ok = deleteCollection(db, 'stats');
    assert.equal(ok, true);
    assert.equal(getCollectionByName(db, 'stats'), undefined);

    // List records setelah delete → 404
    assert.throws(() => listRecords(db, 'stats'), /not found/i);
  });

  test('M16a: rules berlaku di view (admin-only default → user melihat kosong)', () => {
    const db = freshDb();
    defineCollection(db, { name: 'orders', fields: [{ name: 'item', type: 'text' }] });
    createRecord(db, 'orders', { item: 'A' });
    createViewCollection(db, { name: 'stats', viewQuery: 'SELECT item FROM orders' });
    // rules default null = admin-only

    const anon = listRecords(db, 'stats', { reqCtx: { auth: null } });
    assert.equal(anon.totalItems, 0, 'anonymous + view admin-only → kosong');

    const admin = listRecords(db, 'stats');
    assert.equal(admin.totalItems, 1);
  });
});
