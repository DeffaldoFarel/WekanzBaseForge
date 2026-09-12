// ============================================================================
// M17: TEST — menutup 100% gap SQL Database
//
// M17a: operator any-match ?=, ?!=, ?~, ?> (array/multi-value via json_each)
// M17b: FTS5 full-text search (?search=) — trigger-synced, prefix match,
//       digabung dengan rules + filter
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initSchemaTable, defineCollection, deleteCollection, getCollectionByName, updateCollectionRules } from '../src/core/schema.js';
import { createRecord, listRecords, updateRecord, deleteRecord } from '../src/core/records.js';
import { filterToSql } from '../src/core/query/sqlBuilder.js';
import { sanitizeFtsQuery } from '../src/core/fts.js';

const TEST_DIR = path.join(os.tmpdir(), 'baseforge-m17-tests');
let counter = 0;

function freshDb(): DatabaseSync {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(TEST_DIR, `m17-${Date.now()}-${counter++}.db`));
  initSchemaTable(db);
  return db;
}

// ════════════════════════════════════════════════════════════════════════════
// M17a: ANY-MATCH OPERATOR
// ════════════════════════════════════════════════════════════════════════════

describe('M17a: any-match operator (?=, ?!=, ?~)', () => {
  function setup(db: DatabaseSync): void {
    defineCollection(db, {
      name: 'articles',
      fields: [
        { name: 'title', type: 'text' },
        // multi-relation simulasi: tags sebagai json array
        { name: 'tags', type: 'json' },
      ],
    });
    // tags disimpan sebagai JSON array string (serialize json)
    createRecord(db, 'articles', { title: 'Kopi Gayo', tags: ['minuman', 'nikmat', 'aceh'] });
    createRecord(db, 'articles', { title: 'Teh Hijau', tags: ['minuman', 'sehat'] });
    createRecord(db, 'articles', { title: 'Renang', tags: ['olahraga'] });
  }

  test('M17a: ?= — AT LEAST ONE elemen cocok', () => {
    const db = freshDb();
    setup(db);
    const res = listRecords(db, 'articles', { filter: 'tags ?= "minuman"' });
    assert.equal(res.totalItems, 2, 'Kopi & Teh punya tag minuman');
    const titles = res.items.map((i) => i.title).sort();
    assert.deepEqual(titles, ['Kopi Gayo', 'Teh Hijau']);
  });

  test('M17a: ?!= — TIDAK ADA elemen yang cocok', () => {
    const db = freshDb();
    setup(db);
    const res = listRecords(db, 'articles', { filter: 'tags ?!= "minuman"' });
    assert.equal(res.totalItems, 1, 'hanya Renang tanpa tag minuman');
    assert.equal(res.items[0].title, 'Renang');
  });

  test('M17a: ?~ — elemen mengandung substring', () => {
    const db = freshDb();
    setup(db);
    const res = listRecords(db, 'articles', { filter: 'tags ?~ "sehat"' });
    assert.equal(res.totalItems, 1);
    assert.equal(res.items[0].title, 'Teh Hijau');
  });

  test('M17a: filter ?= digabung && dengan filter biasa', () => {
    const db = freshDb();
    setup(db);
    const res = listRecords(db, 'articles', {
      filter: 'tags ?= "minuman" && title ~ "Kopi"',
    });
    assert.equal(res.totalItems, 1);
    assert.equal(res.items[0].title, 'Kopi Gayo');
  });

  test('M17a: ?= pada multi-relation (id array)', () => {
    const db = freshDb();
    defineCollection(db, { name: 'users', fields: [{ name: 'name', type: 'text' }] });
    const u1 = createRecord(db, 'users', { name: 'Budi' });
    const u2 = createRecord(db, 'users', { name: 'Sari' });
    defineCollection(db, {
      name: 'projects',
      fields: [{ name: 'title', type: 'text' }, { name: 'members', type: 'json' }],
    });
    createRecord(db, 'projects', { title: 'A', members: [u1.id, u2.id] });
    createRecord(db, 'projects', { title: 'B', members: [u2.id] });

    const res = listRecords(db, 'projects', { filter: `members ?= "${u1.id}"` });
    assert.equal(res.totalItems, 1);
    assert.equal(res.items[0].title, 'A');
  });

  test('M17a: SQL yang dihasilkan pakai json_each (parameterized)', () => {
    const { where, params } = filterToSql('tags ?= "merah"', [{ name: 'tags', type: 'json' }]);
    assert.ok(where.includes('json_each'), 'harus pakai json_each');
    assert.ok(where.includes('EXISTS'));
    assert.deepEqual(params, ['merah']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// M17b: FTS5 FULL-TEXT SEARCH
// ════════════════════════════════════════════════════════════════════════════

describe('M17b: sanitizeFtsQuery', () => {
  test('M17b: token di-quote + prefix di token terakhir', () => {
    assert.equal(sanitizeFtsQuery('kopi gayo'), '"kopi" "gayo"*');
    assert.equal(sanitizeFtsQuery('kopi'), '"kopi"*');
  });

  test('M17b: karakter FTS berbahaya dibuang (anti syntax error)', () => {
    // quote user dibuang; tiap token di-quote terpisah (phrase per token)
    // M18e: token punct-only (`--`) dibuang sanitizer baru
    assert.equal(sanitizeFtsQuery('kopi" OR 1=1 --'), '"kopi" "OR" "1=1"*');
    assert.equal(sanitizeFtsQuery('   '), '');
    assert.equal(sanitizeFtsQuery('""""'), '');
  });
});

describe('M17b: FTS5 search integration', () => {
  function setup(db: DatabaseSync): { ids: string[] } {
    defineCollection(db, {
      name: 'books',
      fields: [
        { name: 'title', type: 'text', options: { fulltext: true } },
        { name: 'author', type: 'text', options: { fulltext: true } },
        { name: 'year', type: 'number' },
      ],
    });
    const a = createRecord(db, 'books', { title: 'Laskar Pelangi', author: 'Andrea Hirata', year: 2005 });
    const b = createRecord(db, 'books', { title: 'Bumi Manusia', author: 'Pramoedya', year: 1980 });
    const c = createRecord(db, 'books', { title: 'Cantik Itu Luka', author: 'Eka Kurniawan', year: 2002 });
    return { ids: [a.id, b.id, c.id] };
  }

  test('M17b: search single term — prefix match', () => {
    const db = freshDb();
    const { ids } = setup(db);
    const res = listRecords(db, 'books', { search: 'laskar' });
    assert.equal(res.totalItems, 1);
    assert.equal(res.items[0].id, ids[0]);
  });

  test('M17b: search multi-term — AND semantics', () => {
    const db = freshDb();
    setup(db);
    assert.equal(listRecords(db, 'books', { search: 'bumi manusia' }).totalItems, 1);
    assert.equal(listRecords(db, 'books', { search: 'bumi laskar' }).totalItems, 0, 'AND: tak ada dokumen memuat keduanya');
  });

  test('M17b: search multi-field (title + author)', () => {
    const db = freshDb();
    const { ids } = setup(db);
    const res = listRecords(db, 'books', { search: 'pramoedya' });
    assert.equal(res.totalItems, 1);
    assert.equal(res.items[0].id, ids[1], 'author field ikut ter-index');
  });

  test('M17b: FTS index tersinkron otomatis saat UPDATE & DELETE', () => {
    const db = freshDb();
    const { ids } = setup(db);

    // UPDATE: ubah title — index ikut
    updateRecord(db, 'books', ids[2], { title: 'Keajaiban Toko Kelontong' });
    assert.equal(listRecords(db, 'books', { search: 'cantik' }).totalItems, 0, 'term lama hilang');
    assert.equal(listRecords(db, 'books', { search: 'kelontong' }).totalItems, 1, 'term baru ada');

    // DELETE: hapus — index ikut
    deleteRecord(db, 'books', ids[1]);
    assert.equal(listRecords(db, 'books', { search: 'bumi' }).totalItems, 0);
  });

  test('M17b: search digabung dengan rules (own-data tetap berlaku)', () => {
    const db = freshDb();
    defineCollection(db, {
      name: 'notes',
      fields: [
        { name: 'body', type: 'text', options: { fulltext: true } },
        { name: 'owner', type: 'text' },
      ],
    });
    createRecord(db, 'notes', { body: 'rahasia penting', owner: 'userA' });
    createRecord(db, 'notes', { body: 'penting juga', owner: 'userB' });
    // listRule own-data
    updateCollectionRules(db, 'notes', { listRule: 'owner = @request.auth.id' });

    const res = listRecords(db, 'notes', {
      search: 'penting',
      reqCtx: { auth: { id: 'userA', email: 'a@x.com' } },
    });
    assert.equal(res.totalItems, 1, 'A hanya melihat miliknya walau keduanya match');
    assert.equal(res.items[0].owner, 'userA');
  });

  test('M17b: search + filter biasa digabung (AND)', () => {
    const db = freshDb();
    setup2(db);
    const res = listRecords(db, 'books', {
      search: 'bumi',
      filter: 'year > 2000',
    });
    // Bumi Manusia (1980) match text tapi gagal filter tahun → 0
    assert.equal(res.totalItems, 0);
  });

  test('M17b: collection tanpa FTS field → search diabaikan (semua record)', () => {
    const db = freshDb();
    defineCollection(db, { name: 'plain', fields: [{ name: 'x', type: 'text' }] });
    createRecord(db, 'plain', { x: 'hello' });
    // tidak ada options.fulltext → tidak ada FTS table → search diabaikan
    const res = listRecords(db, 'plain', { search: 'hello' });
    assert.equal(res.totalItems, 1, 'tanpa FTS index, search param tidak crash');
  });

  test('M17b: deleteCollection membersihkan FTS table + triggers', () => {
    const db = freshDb();
    setup2(db);
    deleteCollection(db, 'books');
    // FTS table harus hilang — query ke sana error
    let thrown = false;
    try {
      db.prepare(`SELECT * FROM _fts_books`).all();
    } catch {
      thrown = true;
    }
    assert.equal(thrown, true, 'FTS table harus sudah di-drop');
  });
});

function setup2(db: DatabaseSync): void {
  defineCollection(db, {
    name: 'books',
    fields: [
      { name: 'title', type: 'text', options: { fulltext: true } },
      { name: 'author', type: 'text', options: { fulltext: true } },
      { name: 'year', type: 'number' },
    ],
  });
  createRecord(db, 'books', { title: 'Laskar Pelangi', author: 'Andrea Hirata', year: 2005 });
  createRecord(db, 'books', { title: 'Bumi Manusia', author: 'Pramoedya', year: 1980 });
  createRecord(db, 'books', { title: 'Cantik Itu Luka', author: 'Eka Kurniawan', year: 2002 });
}
