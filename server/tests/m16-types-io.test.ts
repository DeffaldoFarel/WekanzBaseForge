// ============================================================================
// M16b + M16c: TEST FIELD TYPES BARU & IMPORT/EXPORT JSON
//
// M16b PROOF:
// - editor: string bebas tersimpan
// - geoPoint: {lat,lng} valid; lat/lng di luar range ditolak
// - password: plain → hash saat write; hash TIDAK PERNAH di response
//
// M16c PROOF:
// - export → JSON self-describing dengan semua records
// - import mode create/replace/merge (upsert by id)
// - password field: yang ter-export adalah HASH (plain tidak pernah ada)
// - round-trip: export A → import ke collection baru → data identik
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initSchemaTable, defineCollection, getCollectionByName, createViewCollection } from '../src/core/schema.js';
import { createRecord, getRecord, listRecords, updateRecord } from '../src/core/records.js';
import { exportCollection, importCollection } from '../src/core/collectionJson.js';
import { verifyPassword } from '../src/auth/password.js';

const TEST_DIR = path.join(os.tmpdir(), 'baseforge-m16-tests');
let counter = 0;

function freshDb(): DatabaseSync {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(TEST_DIR, `m16-${Date.now()}-${counter++}.db`));
  initSchemaTable(db);
  return db;
}

// ════════════════════════════════════════════════════════════════════════════
// M16b: FIELD TYPES
// ════════════════════════════════════════════════════════════════════════════

describe('M16b: field type editor', () => {
  test('M16b: editor — string bebas (HTML) tersimpan & kembali utuh', () => {
    const db = freshDb();
    defineCollection(db, { name: 'posts', fields: [{ name: 'body', type: 'editor' }] });
    const html = '<p>Halo <strong>dunia</strong></p>';
    const rec = createRecord(db, 'posts', { body: html });
    assert.equal(getRecord(db, 'posts', rec.id)?.body, html);
  });

  test('M16b: editor menolak non-string', () => {
    const db = freshDb();
    defineCollection(db, { name: 'posts', fields: [{ name: 'body', type: 'editor' }] });
    assert.throws(() => createRecord(db, 'posts', { body: 123 }), /must be a string/);
  });
});

describe('M16b: field type geoPoint', () => {
  test('M16b: geoPoint valid — {lat,lng} object di response', () => {
    const db = freshDb();
    defineCollection(db, { name: 'places', fields: [{ name: 'loc', type: 'geoPoint' }] });
    const rec = createRecord(db, 'places', { loc: { lat: -6.2088, lng: 106.8456 } });
    assert.deepEqual(getRecord(db, 'places', rec.id)?.loc, { lat: -6.2088, lng: 106.8456 });
  });

  test('M16b: geoPoint di luar range ditolak', () => {
    const db = freshDb();
    defineCollection(db, { name: 'places', fields: [{ name: 'loc', type: 'geoPoint' }] });
    assert.throws(() => createRecord(db, 'places', { loc: { lat: 95, lng: 0 } }), /lat.*-90.*90/i);
    assert.throws(() => createRecord(db, 'places', { loc: { lat: 0, lng: -200 } }), /lng.*-180.*180/i);
    assert.throws(() => createRecord(db, 'places', { loc: { lat: 'x', lng: 0 } }), /numeric/);
    assert.throws(() => createRecord(db, 'places', { loc: [1, 2] }), /object/);
  });

  test('M16b: geoPoint bisa di-update & ter-serialize di list', () => {
    const db = freshDb();
    defineCollection(db, { name: 'places', fields: [{ name: 'loc', type: 'geoPoint' }] });
    const rec = createRecord(db, 'places', { loc: { lat: 0, lng: 0 } });
    updateRecord(db, 'places', rec.id, { loc: { lat: 10.5, lng: -20.25 } });
    const items = listRecords(db, 'places');
    assert.deepEqual(items.items[0].loc, { lat: 10.5, lng: -20.25 });
  });
});

describe('M16b: field type password (hash-only)', () => {
  test('M16b: password plain → hash tersimpan, TIDAK PERNAH di response', () => {
    const db = freshDb();
    defineCollection(db, { name: 'secrets', fields: [{ name: 'pin', type: 'password' }] });

    const rec = createRecord(db, 'secrets', { pin: 'rahasiaKuat123' });

    // Response tidak mengandung field pin (hash tidak pernah keluar!)
    const fetched = getRecord(db, 'secrets', rec.id) as Record<string, unknown>;
    assert.equal('pin' in fetched, false, 'field password harus hilang dari response');
    assert.equal(JSON.stringify(fetched).includes('rahasiaKuat123'), false, 'plain tidak bocor');

    // Tapi di DB tersimpan sebagai hash scrypt (bisa diverifikasi)
    const raw = db.prepare('SELECT pin FROM secrets WHERE id = ?').get(rec.id) as { pin: string };
    assert.ok(raw.pin.startsWith('scrypt:'), 'tersimpan sebagai hash scrypt');
    assert.ok(verifyPassword('rahasiaKuat123', raw.pin), 'hash cocok dengan plain');
    assert.equal(verifyPassword('salah', raw.pin), false);
  });

  test('M16b: password terlalu pendek ditolak', () => {
    const db = freshDb();
    defineCollection(db, { name: 'secrets', fields: [{ name: 'pin', type: 'password' }] });
    assert.throws(() => createRecord(db, 'secrets', { pin: 'pendek' }), /minimal 8/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// M16c: IMPORT/EXPORT JSON
// ════════════════════════════════════════════════════════════════════════════

describe('M16c: export/import JSON', () => {
  function makeSampleData(db: DatabaseSync): void {
    defineCollection(db, {
      name: 'products',
      fields: [
        { name: 'title', type: 'text', required: true },
        { name: 'price', type: 'number' },
        { name: 'active', type: 'bool' },
        { name: 'tags', type: 'json' },
        { name: 'secret', type: 'password' },
      ],
    });
    createRecord(db, 'products', {
      title: 'Kopi',
      price: 25000,
      active: true,
      tags: ['minuman', 'nikmat'],
      secret: 'passwordProduk1',
    });
    createRecord(db, 'products', { title: 'Gula', price: 15000, active: false, tags: [] });
  }

  test('M16c: export menghasilkan JSON self-describing + records', () => {
    const db = freshDb();
    makeSampleData(db);

    const json = exportCollection(db, 'products');
    const data = JSON.parse(json);

    assert.equal(data.format, 'baseforge-collection');
    assert.equal(data.version, 1);
    assert.equal(data.collection.name, 'products');
    assert.equal(data.collection.fields.length, 5);
    assert.equal(data.records.length, 2);

    // Password field: export berisi HASH, bukan plain
    assert.ok(data.records[0].secret.startsWith('scrypt:'), 'export berisi hash');
    assert.equal(JSON.stringify(data).includes('passwordProduk1'), false, 'plain tidak pernah ter-export');
  });

  test('M16c: round-trip export → import (collection baru) → data identik', () => {
    const dbA = freshDb();
    makeSampleData(dbA);
    const json = exportCollection(dbA, 'products');

    // "Instance lain": DB baru, import
    const dbB = freshDb();
    const result = importCollection(dbB, json, { mode: 'create' });
    assert.equal(result.importedRecords, 2);
    assert.equal(result.skippedRecords, 0);

    // Bandingkan data
    const itemsA = listRecords(dbA, 'products').items;
    const itemsB = listRecords(dbB, 'products').items;
    assert.equal(itemsB.length, 2);
    assert.equal(itemsB[0].title, itemsA[0].title);
    assert.deepEqual(itemsB[0].tags, itemsA[0].tags);
    // password hash ikut ter-import (sama dengan asal)
    const rawA = dbA.prepare('SELECT secret FROM products WHERE id = ?').get(itemsA[0].id) as { secret: string };
    const rawB = dbB.prepare('SELECT secret FROM products WHERE id = ?').get(itemsA[0].id) as { secret: string };
    assert.equal(rawB.secret, rawA.secret, 'hash ter-preserve');
  });

  test('M16c: mode create menolak kalau collection sudah ada', () => {
    const db = freshDb();
    makeSampleData(db);
    const json = exportCollection(db, 'products');

    assert.throws(() => importCollection(db, json, { mode: 'create' }), /sudah ada/);
  });

  test('M16c: mode replace menghapus lama → import bersih', () => {
    const db = freshDb();
    makeSampleData(db);
    const json = exportCollection(db, 'products');

    // Ubah satu record lama (data "kotor")
    updateRecord(db, 'products', (listRecords(db, 'products').items[0] as any).id, { title: 'DIRTY' });

    const result = importCollection(db, json, { mode: 'replace' });
    assert.equal(result.importedRecords, 2);
    const titles = listRecords(db, 'products').items.map((i) => i.title);
    assert.equal(titles.includes('DIRTY'), false, 'data lama hilang, diganti export bersih');
  });

  test('M16c: mode merge upsert by id (id sama ditimpa, id baru masuk)', () => {
    const dbA = freshDb();
    makeSampleData(dbA);
    const json = exportCollection(dbA, 'products');

    const dbB = freshDb();
    importCollection(dbB, json, { mode: 'create' });

    // Ubah di dbA lalu export ulang — listRecords order DESC, ambil record 'Kopi' eksplisit
    const kopiA = listRecords(dbA, 'products').items.find((i) => i.title === 'Kopi') as any;
    updateRecord(dbA, 'products', kopiA.id, { price: 99999 });
    const json2 = exportCollection(dbA, 'products');

    // Merge ke dbB: id sama → ditimpa (upsert)
    const result = importCollection(dbB, json2, { mode: 'merge' });
    assert.equal(result.importedRecords, 2);

    const merged = listRecords(dbB, 'products').items.find((i) => i.title === 'Kopi') as any;
    assert.equal(merged.price, 99999, 'upsert menimpa record lama');
    assert.equal(listRecords(dbB, 'products').totalItems, 2, 'tidak ada duplikat');
  });

  test('M16c: import JSON rusak / format salah → pesan jelas', () => {
    const db = freshDb();
    assert.throws(() => importCollection(db, '{invalid json', {}), /JSON tidak valid/);
    assert.throws(
      () => importCollection(db, JSON.stringify({ format: 'lain', collection: {} })),
      /Format tidak dikenal/
    );
  });

  test('M16c: export view → records kosong; import membuat view yang sama', () => {
    const dbA = freshDb();
    defineCollection(dbA, { name: 'orders', fields: [{ name: 'qty', type: 'number' }, { name: 'user', type: 'text' }] });
    createRecord(dbA, 'orders', { qty: 2, user: 'u1' });

    const meta = createViewCollection(dbA, { name: 'stats', viewQuery: 'SELECT user, SUM(qty) AS total FROM orders GROUP BY user' });
    assert.equal(meta.type, 'view');

    const json = exportCollection(dbA, 'stats');
    const data = JSON.parse(json);
    assert.equal(data.collection.type, 'view');
    assert.equal(data.records.length, 0, 'view tidak punya records fisik');

    // Import ke DB baru → view dibuat ulang
    const dbB = freshDb();
    defineCollection(dbB, { name: 'orders', fields: [{ name: 'qty', type: 'number' }, { name: 'user', type: 'text' }] });
    createRecord(dbB, 'orders', { qty: 7, user: 'u9' });
    const result = importCollection(dbB, json, { mode: 'create' });
    assert.equal(result.collection.type, 'view');
    // View bekerja di DB baru
    const items = listRecords(dbB, 'stats');
    assert.equal(items.totalItems, 1);
    assert.equal(items.items[0].total, 7);
  });
});
