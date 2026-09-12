// ============================================================================
// M11: TEST API RULES — row-level security
//
// Skenario utama: collection "notes" dengan field user (pemilik), title.
// Rules:
//   listRule   'user = @request.auth.id'  → hanya lihat catatan sendiri
//   viewRule   'user = @request.auth.id'
//   createRule 'user = @request.auth.id'  → wajib mencatat pemilik = diri
//   updateRule 'user = @request.auth.id'
//   deleteRule 'user = @request.auth.id'
//
// PROOF: user A TIDAK PERNAH bisa menyentuh data user B — di semua operasi.
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initSchemaTable, defineCollection, updateCollectionRules } from '../src/core/schema.js';
import {
  createRecord,
  listRecords,
  getRecord,
  updateRecord,
  deleteRecord,
} from '../src/core/records.js';
import { ForbiddenError } from '../src/core/rules.js';
import { filterToSql } from '../src/core/query/sqlBuilder.js';

const TEST_DIR = path.join(os.tmpdir(), 'baseforge-m11-tests');
let counter = 0;

function freshDb(): DatabaseSync {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(TEST_DIR, `m11-${Date.now()}-${counter++}.db`));
  initSchemaTable(db);

  defineCollection(db, {
    name: 'notes',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'user', type: 'text', required: true },
    ],
  });

  return db;
}

// Identitas palsu untuk test
const userA = { id: 'usr_aaa', email: 'a@x.com' };
const userB = { id: 'usr_bbb', email: 'b@x.com' };
const ctxA = { auth: userA };
const ctxB = { auth: userB };

describe('M11: API Rules', () => {
  test('M11: rules default = null (admin-only) — end user melihat KOSONG', () => {
    const db = freshDb();
    createRecord(db, 'notes', { title: 'rahasia', user: 'usr_aaa' }); // admin

    const result = listRecords(db, 'notes', { reqCtx: ctxA });
    assert.equal(result.totalItems, 0, 'end user + rule null → 0 baris');

    // Tanpa ctx (admin) → tetap terlihat
    const admin = listRecords(db, 'notes');
    assert.equal(admin.totalItems, 1);
  });

  test('M11: rule "" (publik) → anonymous bisa akses', () => {
    const db = freshDb();
    updateCollectionRules(db, 'notes', { listRule: '' });
    createRecord(db, 'notes', { title: 'publik', user: 'siapa' });

    const anon = listRecords(db, 'notes', { reqCtx: { auth: null } });
    assert.equal(anon.totalItems, 1, 'anonymous + rule kosong → boleh');
  });

  test('M11: listRule memfilter — user A hanya melihat catatan A', () => {
    const db = freshDb();
    updateCollectionRules(db, 'notes', { listRule: 'user = @request.auth.id' });

    createRecord(db, 'notes', { title: 'milik A', user: 'usr_aaa' });
    createRecord(db, 'notes', { title: 'milik B', user: 'usr_bbb' });
    createRecord(db, 'notes', { title: 'juga B', user: 'usr_bbb' });

    const seenA = listRecords(db, 'notes', { reqCtx: ctxA });
    assert.equal(seenA.totalItems, 1, 'A hanya melihat 1');
    assert.equal(seenA.items[0].title, 'milik A');

    const seenB = listRecords(db, 'notes', { reqCtx: ctxB });
    assert.equal(seenB.totalItems, 2, 'B melihat 2');

    const anon = listRecords(db, 'notes', { reqCtx: { auth: null } });
    assert.equal(anon.totalItems, 0, 'anonymous + @request → 1=0 → 0 baris');
  });

  test('M11: listRule digabung dengan filter user (AND) — tidak bisa diakali', () => {
    const db = freshDb();
    updateCollectionRules(db, 'notes', { listRule: 'user = @request.auth.id' });
    createRecord(db, 'notes', { title: 'milik B', user: 'usr_bbb' });

    // A mencoba "mencuri" dengan filter sendiri — rule tetap berlaku
    const sneaky = listRecords(db, 'notes', {
      reqCtx: ctxA,
      filter: "title ~ 'B'",
    });
    assert.equal(sneaky.totalItems, 0, 'rule AND filter → data B tetap tersembunyi');
  });

  test('M11: viewRule — record milik orang lain → null (bukan error)', () => {
    const db = freshDb();
    updateCollectionRules(db, 'notes', { viewRule: 'user = @request.auth.id' });
    const recB = createRecord(db, 'notes', { title: 'milik B', user: 'usr_bbb' });

    const seenByA = getRecord(db, 'notes', recB.id, ctxA);
    assert.equal(seenByA, null, 'A melihat record B → null');

    const seenByB = getRecord(db, 'notes', recB.id, ctxB);
    assert.equal(seenByB?.title, 'milik B', 'pemilik bisa melihat');
  });

  test('M11: createRule — user wajib mencatat dirinya sebagai pemilik', () => {
    const db = freshDb();
    updateCollectionRules(db, 'notes', { createRule: 'user = @request.auth.id' });

    // A jujur: mencatat dirinya → boleh
    const ok = createRecord(db, 'notes', { title: 'jujur', user: 'usr_aaa' }, ctxA);
    assert.equal(ok.user, 'usr_aaa');

    // A berpura-pura jadi B → DITOLAK
    assert.throws(() => {
      createRecord(db, 'notes', { title: 'penipuan', user: 'usr_bbb' }, ctxA);
    }, ForbiddenError);
  });

  test('M11: updateRule — A tidak bisa mengubah record B', () => {
    const db = freshDb();
    updateCollectionRules(db, 'notes', { updateRule: 'user = @request.auth.id' });
    const recB = createRecord(db, 'notes', { title: 'milik B', user: 'usr_bbb' });

    assert.throws(() => {
      updateRecord(db, 'notes', recB.id, { title: 'dirampok A' }, ctxA);
    }, ForbiddenError);

    // Pemilik bisa mengubah
    const updated = updateRecord(db, 'notes', recB.id, { title: 'B edit sendiri' }, ctxB);
    assert.equal(updated?.title, 'B edit sendiri');
  });

  test('M11: deleteRule — A tidak bisa menghapus record B', () => {
    const db = freshDb();
    updateCollectionRules(db, 'notes', { deleteRule: 'user = @request.auth.id' });
    const recB = createRecord(db, 'notes', { title: 'milik B', user: 'usr_bbb' });

    assert.throws(() => {
      deleteRecord(db, 'notes', recB.id, ctxA);
    }, ForbiddenError);

    const ok = deleteRecord(db, 'notes', recB.id, ctxB);
    assert.equal(ok, true);
  });

  test('M11: admin selalu bypass — undefined ctx = kekuatan penuh', () => {
    const db = freshDb();
    updateCollectionRules(db, 'notes', {
      listRule: 'user = @request.auth.id',
      deleteRule: 'user = @request.auth.id',
    });
    const recB = createRecord(db, 'notes', { title: 'milik B', user: 'usr_bbb' });

    const adminSees = listRecords(db, 'notes'); // tanpa reqCtx
    assert.equal(adminSees.totalItems, 1, 'admin melihat semua');

    const adminDeletes = deleteRecord(db, 'notes', recB.id); // tanpa reqCtx
    assert.equal(adminDeletes, true, 'admin bisa hapus');
  });

  test('M11: rule dengan field tidak ada → ditolak saat define/update (typo tidak diam)', () => {
    const db = freshDb();
    assert.throws(() => {
      updateCollectionRules(db, 'notes', { listRule: 'owner = @request.auth.id' }); // 'owner' typo!
    }, /owner/);
  });

  test('M11: @request di sisi field → kondisi konstan (1=1 / 1=0)', () => {
    const db = freshDb();
    defineCollection(db, {
      name: 'logs',
      fields: [{ name: 'msg', type: 'text' }],
    });

    createRecord(db, 'logs', { msg: 'x1' });

    // @request.auth.id = 'usr_aaa' → untuk A: TRUE konstan → semua baris
    const sqlA = filterToSql('@request.auth.id = "usr_aaa"', [], ctxA);
    assert.equal(sqlA.where, '1=1');

    // Untuk B: FALSE konstan → tidak ada baris
    const sqlB = filterToSql('@request.auth.id = "usr_aaa"', [], ctxB);
    assert.equal(sqlB.where, '1=0');
  });

  test('M11: rules tersimpan di meta & terbaca kembali (schema-as-data)', () => {
    const db = freshDb();
    const updated = updateCollectionRules(db, 'notes', {
      listRule: 'user = @request.auth.id',
      viewRule: '',
    });
    assert.equal(updated.rules.listRule, 'user = @request.auth.id');
    assert.equal(updated.rules.viewRule, '');
    assert.equal(updated.rules.deleteRule, null, 'yang tidak diset tetap null');
  });
});
