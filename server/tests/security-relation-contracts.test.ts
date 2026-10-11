// SECURITY: relation existence/ownership + JSON-array contracts (audit #17, #18).
//
// #17: billings.paidHistory is a JSON-in-text field whose stored string must
//      PARSE to an array — end-user writes carrying a non-array payload must
//      be rejected by the server (not just coerced/silently accepted).
// #18: a relation field must reference an EXISTING record in the target
//      collection, owned by the SAME user when the target is user-scoped —
//      an end user must not be able to point a record at another user's row
//      or at a nonexistent id.

import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initSchemaTable, defineCollection } from '../src/core/schema.js';
import { createRecord, updateRecord } from '../src/core/records.js';

const TEST_DIR = path.resolve('../data/rel-contract-test');

after(() => {
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows holds SQLite handles; cleanup failure must not fail a green suite.
  }
});

let counter = 0;
/** Owner rules — same shape the provisioner installs on real collections. */
const ownerRules = {
  listRule: '@request.auth.id != "" && userId = @request.auth.id',
  viewRule: '@request.auth.id != "" && userId = @request.auth.id',
  createRule: '@request.auth.id != "" && userId = @request.auth.id',
  updateRule: '@request.auth.id != "" && userId = @request.auth.id',
  deleteRule: '@request.auth.id != "" && userId = @request.auth.id',
};

function freshDb(): DatabaseSync {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = new DatabaseSync(path.join(TEST_DIR, `t-${Date.now()}-${counter++}.db`));
  db.exec('PRAGMA journal_mode = WAL');
  initSchemaTable(db);

  // investments: user-scoped target collection.
  defineCollection(db, {
    name: 'investments',
    fields: [
      { name: 'userId', type: 'text', required: true },
      { name: 'instrument', type: 'text', required: false },
    ],
    rules: ownerRules,
  });

  // investment_activities: relation to investments + JSON-array paidHistory-like field.
  defineCollection(db, {
    name: 'investment_activities',
    fields: [
      { name: 'userId', type: 'text', required: true },
      { name: 'investmentId', type: 'relation', options: { collectionId: 'investments', maxSelect: 1 } },
      { name: 'flags', type: 'text', required: false, options: { jsonArray: true } },
    ],
    rules: ownerRules,
  });

  // billings-like collection with ONLY the jsonArray contract.
  defineCollection(db, {
    name: 'billings',
    fields: [
      { name: 'userId', type: 'text', required: true },
      { name: 'paidHistory', type: 'text', required: false, options: { jsonArray: true } },
    ],
    rules: ownerRules,
  });

  return db;
}

const userCtx = (id: string) => ({ auth: { id, email: `${id}@x.test` } });

// ── #18: relation existence + ownership ─────────────────────────────────────

test('#18: create with a relation to a MISSING id is rejected', () => {
  const db = freshDb();
  assert.throws(
    () => createRecord(db, 'investment_activities', {
      userId: 'u1',
      investmentId: 'does-not-exist',
    }, userCtx('u1')),
    /does not exist|not found|invalid relation/i,
  );
  db.close();
});

test('#18: create with a relation to ANOTHER USER\'S record is rejected', () => {
  const db = freshDb();
  const foreign = createRecord(db, 'investments', { userId: 'u2', instrument: 'Foreign' });
  assert.throws(
    () => createRecord(db, 'investment_activities', {
      userId: 'u1',
      investmentId: foreign.id,
    }, userCtx('u1')),
    /not owned|owner|forbidden/i,
  );
  db.close();
});

test('#18: create with a relation to the SAME user\'s record succeeds', () => {
  const db = freshDb();
  const own = createRecord(db, 'investments', { userId: 'u1', instrument: 'Own' }, userCtx('u1'));
  const act = createRecord(db, 'investment_activities', {
    userId: 'u1',
    investmentId: own.id,
  }, userCtx('u1'));
  assert.equal((act as Record<string, unknown>).investmentId, own.id);
  db.close();
});

test('#18: update repointing a relation to a missing/foreign id is rejected', () => {
  const db = freshDb();
  const own = createRecord(db, 'investments', { userId: 'u1', instrument: 'Own' }, userCtx('u1'));
  const foreign = createRecord(db, 'investments', { userId: 'u2', instrument: 'F' });
  const act = createRecord(db, 'investment_activities', {
    userId: 'u1',
    investmentId: own.id,
  }, userCtx('u1'));

  assert.throws(
    () => updateRecord(db, 'investment_activities', act.id, { investmentId: 'gone' }, userCtx('u1')),
    /does not exist|not found|invalid relation/i,
  );
  assert.throws(
    () => updateRecord(db, 'investment_activities', act.id, { investmentId: foreign.id }, userCtx('u1')),
    /not owned|owner|forbidden/i,
  );
  db.close();
});

test('#18: admin context (undefined reqCtx) is not restricted by relation ownership', () => {
  const db = freshDb();
  const any = createRecord(db, 'investments', { userId: 'u9', instrument: 'X' });
  // Service/admin import paths must keep working (no reqCtx = privileged).
  const act = createRecord(db, 'investment_activities', {
    userId: 'u1',
    investmentId: any.id,
  });
  assert.equal((act as Record<string, unknown>).investmentId, any.id);
  db.close();
});

// ── #17: jsonArray contract on plain text fields ────────────────────────────

test('#17: a non-array JSON payload for a jsonArray field is rejected on create', () => {
  const db = freshDb();
  assert.throws(
    () => createRecord(db, 'billings', {
      userId: 'u1',
      paidHistory: JSON.stringify({ not: 'an array' }),
    }, userCtx('u1')),
    /must be a JSON array|must be valid JSON/i,
  );
  db.close();
});

test('#17: a plain-text (non-JSON) payload is rejected', () => {
  const db = freshDb();
  assert.throws(
    () => createRecord(db, 'billings', {
      userId: 'u1',
      paidHistory: 'not-json',
    }, userCtx('u1')),
    /must be a JSON array|must be valid JSON/i,
  );
  db.close();
});

test('#17: a valid JSON array payload passes (stored as the JSON string)', () => {
  const db = freshDb();
  const bill = createRecord(db, 'billings', {
    userId: 'u1',
    paidHistory: JSON.stringify(['9_2026', '10_2026']),
  }, userCtx('u1'));
  // Plain-text fields round-trip as strings — the CLIENT adapter JSON.parses
  // them (JSON_ATTRS); the server's job is only to validate the contract.
  assert.equal((bill as Record<string, unknown>).paidHistory, '["9_2026","10_2026"]');
  db.close();
});

test('#17: updating with a non-array payload is rejected too', () => {
  const db = freshDb();
  const bill = createRecord(db, 'billings', {
    userId: 'u1',
    paidHistory: JSON.stringify([]),
  }, userCtx('u1'));
  assert.throws(
    () => updateRecord(db, 'billings', bill.id, { paidHistory: 'oops' }, userCtx('u1')),
    /must be a JSON array|must be valid JSON/i,
  );
  db.close();
});
