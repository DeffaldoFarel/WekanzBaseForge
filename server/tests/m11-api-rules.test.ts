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

  test('security: authenticated writer cannot attribute a userId record to another user even under auth-only createRule', () => {
    const db = freshDb();
    defineCollection(db, {
      name: 'overview_notes',
      fields: [
        { name: 'userId', type: 'text', required: true },
        { name: 'title', type: 'text', required: true },
      ],
      rules: {
        listRule: 'userId = @request.auth.id',
        createRule: '@request.auth.id != ""', // matches the live dashboard rule before repair
      },
    });

    assert.throws(
      () => createRecord(db, 'overview_notes', { userId: userB.id, title: 'forged' }, ctxA),
      ForbiddenError,
    );
    assert.equal(listRecords(db, 'overview_notes').totalItems, 0, 'rejected record must not be written');
    const own = createRecord(db, 'overview_notes', { userId: userA.id, title: 'mine' }, ctxA);
    assert.equal(own.userId, userA.id);

    // Explicit service/admin context (undefined) keeps its privileged behavior.
    const imported = createRecord(db, 'overview_notes', { userId: userB.id, title: 'import' });
    assert.equal(imported.userId, userB.id);
    db.close();
  });

  test('security: owner comparison on either side of the equality is enforced', () => {
    const db = freshDb();
    defineCollection(db, {
      name: 'reverse_owned',
      fields: [{ name: 'userId', type: 'text', required: true }, { name: 'title', type: 'text' }],
      rules: { listRule: '@request.auth.id = userId', createRule: '' },
    });
    assert.throws(() => createRecord(db, 'reverse_owned', { userId: userB.id }, ctxA), ForbiddenError);
    assert.equal(createRecord(db, 'reverse_owned', { userId: userA.id }, ctxA).userId, userA.id);
    db.close();
  });

  test('security: explicitly public collection with a userId field keeps its public CRUD contract', () => {
    const db = freshDb();
    defineCollection(db, {
      name: 'public_entries',
      fields: [{ name: 'userId', type: 'text' }, { name: 'title', type: 'text' }],
      rules: { listRule: '', viewRule: '', createRule: '', updateRule: '', deleteRule: '' },
    });
    const rec = createRecord(db, 'public_entries', { userId: 'any-label', title: 'public' }, { auth: null });
    assert.equal(rec.userId, 'any-label');
    const changed = updateRecord(db, 'public_entries', rec.id, { userId: 'new-label' }, { auth: null });
    assert.equal(changed?.userId, 'new-label');
    db.close();
  });

  test('security: public collection mixed with a rule mentioning owner text as a quoted literal remains public', () => {
    const db = freshDb();
    defineCollection(db, {
      name: 'public_with_literal',
      fields: [{ name: 'userId', type: 'text' }, { name: 'title', type: 'text' }],
      rules: { listRule: '', viewRule: '', createRule: '', updateRule: '', deleteRule: '' },
    });
    updateCollectionRules(db, 'public_with_literal', { listRule: 'title = "userId = @request.auth.id"' });
    const created = createRecord(db, 'public_with_literal', { userId: 'label', title: 'userId = @request.auth.id' }, { auth: null });
    assert.equal(created.userId, 'label');
    const updated = updateRecord(db, 'public_with_literal', created.id, { userId: 'new-label' }, { auth: null });
    assert.equal(updated?.userId, 'new-label');
    db.close();
  });

  test('invalid owner rule metadata cannot turn off the create owner guard', () => {
    const db = freshDb();
    defineCollection(db, {
      name: 'bad_owner_rule',
      fields: [{ name: 'userId', type: 'text', required: true }],
      rules: { listRule: '', createRule: '@request.auth.id != ""' },
    });
    // Simulate old persisted metadata that predates full parser validation.
    db.prepare('UPDATE _collections SET rules = ? WHERE name = ?').run(JSON.stringify({
      listRule: 'userId = @request.auth.id #broken',
      createRule: '@request.auth.id != ""',
    }), 'bad_owner_rule');
    assert.throws(() => createRecord(db, 'bad_owner_rule', { userId: userB.id }, ctxA), ForbiddenError);
    db.close();
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

  test('security: owner cannot transfer a userId record to a different account via PATCH', () => {
    const db = freshDb();
    defineCollection(db, {
      name: 'owned_tasks',
      fields: [
        { name: 'userId', type: 'text', required: true },
        { name: 'title', type: 'text', required: true },
      ],
      rules: {
        viewRule: 'userId = @request.auth.id',
        updateRule: 'userId = @request.auth.id',
      },
    });
    const rec = createRecord(db, 'owned_tasks', { userId: userA.id, title: 'mine' });
    assert.throws(
      () => updateRecord(db, 'owned_tasks', rec.id, { userId: userB.id }, ctxA),
      ForbiddenError,
    );
    assert.equal(getRecord(db, 'owned_tasks', rec.id)?.userId, userA.id);
    assert.equal(getRecord(db, 'owned_tasks', rec.id, ctxB), null);
    assert.equal(updateRecord(db, 'owned_tasks', rec.id, { userId: userA.id, title: 'still mine' }, ctxA)?.title, 'still mine');
    assert.equal(updateRecord(db, 'owned_tasks', rec.id, { title: 'updated again' }, ctxA)?.userId, userA.id);
    assert.equal(updateRecord(db, 'owned_tasks', rec.id, { userId: userB.id })?.userId, userB.id, 'service/admin migration stays privileged');
    db.close();
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
