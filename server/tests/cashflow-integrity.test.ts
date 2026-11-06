import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initSchemaTable, defineCollection, rebuildCollection, updateCollection, deleteCollection, duplicateCollection, getCollectionByName, getSchemaVersion } from '../src/core/schema.js';
import { createRecord, updateRecord, deleteRecord, createRecordsBatch } from '../src/core/records.js';
import { exportCollection, importCollection } from '../src/core/collectionJson.js';
import { runFunctionCode } from '../src/core/functionRunner.js';

const constraint = {
  version: 1 as const,
  sourceOwner: 'userId', targetOwner: 'userId', targetMode: 'trackingMode',
  assetMode: 'asset_ledger', tradingMode: 'trading_cashflow',
  flowField: 'flowType', quantityField: 'amount', valueField: 'idr',
  immutableModeWhenReferenced: true,
};

function fixture() {
  const db = new DatabaseSync(':memory:');
  initSchemaTable(db);
  defineCollection(db, { name: 'accounts', fields: [
    { name: 'userId', type: 'text' },
    { name: 'trackingMode', type: 'select', options: { values: ['asset_ledger', 'trading_cashflow'] } },
  ] });
  defineCollection(db, { name: 'activities', fields: [
    { name: 'userId', type: 'text' },
    { name: 'accountId', type: 'relation', options: { collectionId: 'accounts', cashflowIntegrity: constraint } as any },
    { name: 'amount', type: 'number', options: { signed: true } },
    { name: 'idr', type: 'number', options: { signed: true } },
    { name: 'flowType', type: 'select', options: { values: ['deposit', 'withdrawal', 'profit', 'loss'] } },
    { name: 'note', type: 'text' },
  ] });
  createRecord(db, 'accounts', { id: 'trading', userId: 'u1', trackingMode: 'trading_cashflow' });
  return db;
}

test('trading create rejects a missing flow instead of inferring a legacy row', () => {
  const db = fixture();
  try {
    assert.throws(() => createRecord(db, 'activities', { userId: 'u1', accountId: 'trading', amount: null, idr: 100 }), /cashflow/i);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM activities').get() as { n: number }).n, 0);
  } finally { db.close(); }
});

test('the writer lock retries a failed rollback without hiding the original error', () => {
  const db = fixture();
  let firstRollback = true;
  const wrapped = new Proxy(db, { get(target, key) {
    if (key === 'exec') return (sql: string) => {
      if (sql === 'ROLLBACK' && firstRollback) {
        firstRollback = false;
        throw new Error('synthetic rollback error');
      }
      return target.exec(sql);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  try {
    assert.throws(() => createRecord(wrapped, 'activities', { userId: 'u1', accountId: 'trading', idr: 100 }), /cashflow/i);
    assert.equal(firstRollback, false);
    assert.equal(db.isTransaction, false);
    assert.equal(createRecord(db, 'activities', { userId: 'u1', accountId: 'trading', flowType: 'deposit', amount: null, idr: 1 }).idr, 1);
  } finally { db.close(); }
});

test('trading update validates the full resulting row and explicit nulls', () => {
  const db = fixture();
  try {
    createRecord(db, 'activities', { id: 'a', userId: 'u1', accountId: 'trading', flowType: 'deposit', amount: null, idr: 100 });
    assert.throws(() => updateRecord(db, 'activities', 'a', { flowType: null }), /cashflow/i);
    assert.throws(() => updateRecord(db, 'activities', 'a', { idr: -100 }), /cashflow/i);
    assert.throws(() => updateRecord(db, 'activities', 'a', { amount: 1 }), /cashflow/i);
    assert.equal(updateRecord(db, 'activities', 'a', { note: 'ok' })?.idr, 100);
  } finally { db.close(); }
});

test('referenced target owner and immutable tracking mode cannot be changed', () => {
  const db = fixture();
  try {
    createRecord(db, 'activities', { id: 'a', userId: 'u1', accountId: 'trading', flowType: 'deposit', amount: null, idr: 100 });
    assert.throws(() => updateRecord(db, 'accounts', 'trading', { userId: 'u2' }), /cashflow/i);
    assert.throws(() => updateRecord(db, 'accounts', 'trading', { trackingMode: 'asset_ledger' }), /cashflow/i);
    const rawMeta = getCollectionByName(db, 'accounts')!;
    const altered = rawMeta.fields.map(f => f.name === 'trackingMode' ? { ...f, options: { values: ['asset_ledger', 'trading_cashflow', ''] } } : f);
    db.prepare('UPDATE _collections SET fields=? WHERE name=?').run(JSON.stringify(altered), 'accounts');
    assert.throws(() => updateRecord(db, 'accounts', 'trading', { trackingMode: undefined }), /cashflow/i);
  } finally { db.close(); }
});

test('import cannot bypass a constrained collection', () => {
  const db = fixture();
  try {
    const payload = JSON.parse(exportCollection(db, 'activities'));
    payload.records = [{ id: 'malformed', userId: 'u1', accountId: 'trading', amount: null, idr: 100 }];
    assert.throws(() => importCollection(db, JSON.stringify(payload), { mode: 'merge' }), /cashflow/i);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM activities').get() as {n: number}).n, 0);
  } finally { db.close(); }
});

test('failed delete rolls back already-cascaded rows without leaking event snapshots', () => {
  const db = fixture();
  try {
    createRecord(db, 'activities', {id:'valid', userId:'u1', accountId:'trading', flowType:'deposit', amount:null, idr:1});
    defineCollection(db, {name:'cascadeFirst', fields:[{name:'accountId', type:'relation', options:{collectionId:'accounts', cascadeDelete:'cascade'}}]});
    createRecord(db, 'cascadeFirst', {id:'child',accountId:'trading'});
    // Force cascade to execute before the constrained setNull rejection.
    db.prepare("UPDATE _collections SET created='1900-01-01' WHERE name='cascadeFirst'").run();
    const events:{collection:string;record:Record<string,unknown>}[]=[];
    assert.throws(()=>deleteRecord(db, 'accounts','trading',undefined,events), /cashflow/i);
    assert.deepEqual(events, []);
    assert.equal((db.prepare('SELECT count(*) n FROM cascadeFirst').get() as {n:number}).n,1);
    assert.equal((db.prepare('SELECT count(*) n FROM accounts').get() as {n:number}).n,1);
  } finally {db.close();}
});

test('an unknown cascade strategy cannot leave constrained rows orphaned', () => {
  const db = fixture();
  try {
    createRecord(db, 'activities', { id: 'valid', userId: 'u1', accountId: 'trading', flowType: 'deposit', amount: null, idr: 1 });
    const meta = getCollectionByName(db, 'activities')!;
    const fields = meta.fields.map(field => field.name === 'accountId'
      ? { ...field, options: { ...field.options, cascadeDelete: 'invalid' } }
      : field);
    db.prepare('UPDATE _collections SET fields=? WHERE name=?').run(JSON.stringify(fields), 'activities');
    assert.throws(() => deleteRecord(db, 'accounts', 'trading'), /cashflow|cascade/i);
    assert.ok(getCollectionByName(db, 'accounts'));
    assert.equal((db.prepare('SELECT COUNT(*) n FROM accounts').get() as {n:number}).n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM activities').get() as {n:number}).n, 1);
  } finally { db.close(); }
});

test('deleting a target cannot null out a constrained relation', () => {
  const db = fixture();
  try {
    createRecord(db, 'activities', { id: 'a', userId: 'u1', accountId: 'trading', flowType: 'deposit', amount: null, idr: 100 });
    assert.throws(() => deleteRecord(db, 'accounts', 'trading'), /cashflow/i);
    assert.equal((db.prepare('SELECT accountId FROM activities WHERE id = ?').get('a') as {accountId: string}).accountId, 'trading');
  } finally { db.close(); }
});

test('a concurrent target update cannot commit between validation and source insert', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cashflow-race-'));
  const file = path.join(dir, 'race.db');
  const db = new DatabaseSync(file);
  const other = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    // Verify nested/deferred transactions acquire a writer lock too.
    db.exec('BEGIN');
    db.prepare('CREATE TABLE lockprobe(x)').run();
    db.exec('COMMIT');
    db.exec('BEGIN');
    db.prepare('UPDATE lockprobe SET x=x WHERE 0').run();
    assert.throws(() => other.prepare('UPDATE lockprobe SET x=x WHERE 0').run(), /locked|busy/i);
    db.exec('ROLLBACK');
    other.exec('PRAGMA busy_timeout=10');
    initSchemaTable(db);
    defineCollection(db, { name: 'accounts', fields: [
      { name: 'userId', type: 'text' }, { name: 'trackingMode', type: 'text' },
    ] });
    defineCollection(db, { name: 'activities', fields: [
      { name: 'userId', type: 'text' },
      { name: 'accountId', type: 'relation', options: { collectionId: 'accounts', cashflowIntegrity: constraint } },
      { name: 'amount', type: 'number', options: { signed: true } },
      { name: 'idr', type: 'number', options: { signed: true } },
      { name: 'flowType', type: 'text' },
    ] });
    createRecord(db, 'accounts', { id: 'trading', userId: 'u1', trackingMode: 'trading_cashflow' });
    let attempted = false;
    const wrapped = new Proxy(db, {
      get(target, key) {
        if (key === 'prepare') return (sql: string) => {
          if (!attempted && sql.startsWith('INSERT INTO "activities"')) {
            attempted = true;
            // If the source write has a writer lock, this competing update is
            // rejected. Otherwise it succeeds after validation and creates an
            // owner-inconsistent committed row.
            try { updateRecord(other, 'accounts', 'trading', { userId: 'u2' }); } catch {}
          }
          return target.prepare(sql);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    createRecord(wrapped, 'activities', { userId: 'u1', accountId: 'trading', amount: null, idr: 1, flowType: 'deposit' });
    assert.equal(attempted, true);
    assert.equal((db.prepare('SELECT userId FROM accounts WHERE id = ?').get('trading') as {userId: string}).userId, 'u1');
  } finally {
    db.close(); other.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('target deletion cannot race a validated source create', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cashflow-delete-race-'));
  const file = path.join(dir, 'race.db');
  const db = new DatabaseSync(file);
  const other = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    other.exec('PRAGMA busy_timeout=10');
    initSchemaTable(db);
    defineCollection(db, { name: 'accounts', fields: [{ name: 'userId', type: 'text' }, { name: 'trackingMode', type: 'text' }] });
    defineCollection(db, { name: 'activities', fields: [
      { name: 'userId', type: 'text' }, { name: 'accountId', type: 'relation', options: { collectionId: 'accounts', cascadeDelete: 'cascade', cashflowIntegrity: constraint } },
      { name: 'amount', type: 'number', options: { signed: true } }, { name: 'idr', type: 'number', options: { signed: true } }, { name: 'flowType', type: 'text' },
    ] });
    createRecord(db, 'accounts', { id: 'trading', userId: 'u1', trackingMode: 'trading_cashflow' });
    let attempted = false;
    const lockDir = new DatabaseSync(path.join(dir, 'race.db'));
    lockDir.exec('PRAGMA busy_timeout=10');
    const wrapped = new Proxy(other, { get(target, key) {
      if (key === 'prepare') return (sql: string) => {
        const stmt = target.prepare(sql);
        if (!attempted && sql.startsWith('SELECT id, "accountId" AS refval')) {
          return new Proxy(stmt, { get(statement, operation) {
            if (operation === 'all') return (...args: any[]) => {
              const rows = statement.all(...args);
              attempted = true;
              try { createRecord(lockDir, 'activities', { userId: 'u1', accountId: 'trading', amount: null, idr: 1, flowType: 'deposit' }); } catch {}
              return rows;
            };
            const value = Reflect.get(statement, operation, statement);
            return typeof value === 'function' ? value.bind(statement) : value;
          } });
        }
        return stmt;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    try {
      assert.equal(deleteRecord(wrapped, 'accounts', 'trading'), true);
      assert.ok(attempted);
      assert.equal((db.prepare('SELECT COUNT(*) n FROM activities').get() as {n:number}).n, 0);
    } finally { lockDir.close(); }
  } finally { db.close(); other.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent opt-in activation cannot race a pre-existing unchecked create', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cashflow-enable-race-'));
  const file = path.join(dir, 'race.db');
  const db = new DatabaseSync(file);
  const other = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    other.exec('PRAGMA busy_timeout=10');
    initSchemaTable(db);
    defineCollection(db, { name: 'accounts', fields: [{ name: 'userId', type: 'text' }, { name: 'trackingMode', type: 'text' }] });
    const fields = [
      { name: 'userId', type: 'text' as const }, { name: 'accountId', type: 'relation' as const, options: { collectionId: 'accounts' } },
      { name: 'amount', type: 'number' as const, options: { signed: true } }, { name: 'idr', type: 'number' as const, options: { signed: true } }, { name: 'flowType', type: 'text' as const },
    ];
    defineCollection(db, { name: 'activities', fields });
    createRecord(db, 'accounts', { id: 'trading', userId: 'u1', trackingMode: 'trading_cashflow' });
    const enabled = fields.map(f => f.name === 'accountId' ? { ...f, options: { ...f.options, cashflowIntegrity: constraint } } : f);
    let attempted = false;
    const wrapped = new Proxy(db, { get(target, key) {
      if (key === 'prepare') return (sql: string) => {
        if (!attempted && sql.startsWith('INSERT INTO "activities"')) {
          attempted = true;
          try { updateCollection(other, 'activities', { fields: enabled, expectedSchemaVersion: getSchemaVersion(other, 'activities') }); } catch {}
        }
        return target.prepare(sql);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    createRecord(wrapped, 'activities', { userId: 'u1', accountId: 'trading', amount: null, idr: 1 });
    assert.ok(attempted);
    const f = getCollectionByName(db, 'activities')!.fields.find(x => x.name === 'accountId')!;
    assert.equal(f.options?.cashflowIntegrity, undefined);
  } finally { db.close(); other.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent opt-in activation cannot race a pre-existing unchecked merge import', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cashflow-import-race-'));
  const file = path.join(dir, 'race.db');
  const db = new DatabaseSync(file);
  const other = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    other.exec('PRAGMA busy_timeout=10');
    initSchemaTable(db);
    defineCollection(db, { name: 'accounts', fields: [{ name: 'userId', type: 'text' }, { name: 'trackingMode', type: 'text' }] });
    const fields = [
      { name: 'userId', type: 'text' as const }, { name: 'accountId', type: 'relation' as const, options: { collectionId: 'accounts' } },
      { name: 'amount', type: 'number' as const, options: { signed: true } }, { name: 'idr', type: 'number' as const, options: { signed: true } }, { name: 'flowType', type: 'text' as const },
    ];
    defineCollection(db, { name: 'activities', fields });
    createRecord(db, 'accounts', { id: 'trading', userId: 'u1', trackingMode: 'trading_cashflow' });
    const enabled = fields.map(f => f.name === 'accountId' ? { ...f, options: { ...f.options, cashflowIntegrity: constraint } } : f);
    const payload = JSON.parse(exportCollection(db, 'activities'));
    payload.records = [{ id: 'bad', userId: 'u1', accountId: 'trading', amount: null, idr: 1 }];
    let attempted = false;
    const wrapped = new Proxy(db, { get(target, key) {
      if (key === 'prepare') return (sql: string) => {
        if (!attempted && sql.startsWith('INSERT OR REPLACE INTO "activities"')) {
          attempted = true;
          try { updateCollection(other, 'activities', { fields: enabled, expectedSchemaVersion: getSchemaVersion(other, 'activities') }); } catch {}
        }
        return target.prepare(sql);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const imported = importCollection(wrapped, JSON.stringify(payload), { mode: 'merge' });
    assert.equal(imported.importedRecords, 1);
    assert.ok(attempted);
    const f = getCollectionByName(db, 'activities')!.fields.find(x => x.name === 'accountId')!;
    assert.equal(f.options?.cashflowIntegrity, undefined);
  } finally { db.close(); other.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent activation cannot race an in-progress unchecked source delete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cashflow-delete-enable-race-'));
  const file = path.join(dir, 'race.db');
  const db = new DatabaseSync(file);
  const other = new DatabaseSync(file);
  try {
    db.exec('PRAGMA journal_mode=WAL');
    other.exec('PRAGMA busy_timeout=10');
    initSchemaTable(db);
    defineCollection(db, { name: 'accounts', fields: [{ name: 'userId', type: 'text' }, { name: 'trackingMode', type: 'text' }] });
    const fields = [
      { name: 'userId', type: 'text' as const }, { name: 'accountId', type: 'relation' as const, options: { collectionId: 'accounts' } },
      { name: 'amount', type: 'number' as const, options: { signed: true } }, { name: 'idr', type: 'number' as const, options: { signed: true } }, { name: 'flowType', type: 'text' as const },
    ];
    defineCollection(db, { name: 'activities', fields });
    createRecord(db, 'accounts', { id: 'trading', userId: 'u1', trackingMode: 'trading_cashflow' });
    createRecord(db, 'activities', { id: 'a', userId: 'u1', accountId: 'trading', flowType: 'deposit', amount: null, idr: 1 });
    const enabled = fields.map(f => f.name === 'accountId' ? { ...f, options: { ...f.options, cashflowIntegrity: constraint } } : f);
    let attempted = false;
    const wrapped = new Proxy(db, { get(target, key) {
      if (key === 'prepare') return (sql: string) => {
        if (!attempted && sql.startsWith('SELECT id, "accountId" AS refval')) {
          attempted = true;
          try { updateCollection(other, 'activities', { fields: enabled, expectedSchemaVersion: getSchemaVersion(other, 'activities') }); } catch {}
        }
        return target.prepare(sql);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    assert.equal(deleteRecord(wrapped, 'accounts', 'trading'), true);
    assert.ok(attempted);
    const f = getCollectionByName(db, 'activities')!.fields.find(x => x.name === 'accountId')!;
    assert.equal(f.options?.cashflowIntegrity, undefined);
  } finally { db.close(); other.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('trading sign and null matrix rejects invalid writes without inserting', () => {
  const db = fixture();
  try {
    for (const [flow, value] of [['deposit', 5], ['profit', 5], ['withdrawal', -5], ['loss', -5]] as const) {
      const row = createRecord(db, 'activities', { userId: 'u1', accountId: 'trading', amount: null, idr: value, flowType: flow });
      assert.equal(row.idr, value);
      for (const invalid of [0, -value, null]) {
        assert.throws(() => createRecord(db, 'activities', { userId: 'u1', accountId: 'trading', amount: null, idr: invalid, flowType: flow }), /cashflow/i);
      }
      assert.throws(() => createRecord(db, 'activities', { userId: 'u1', accountId: 'trading', amount: 0, idr: value, flowType: flow }), /cashflow/i);
    }
    assert.equal((db.prepare('SELECT COUNT(*) n FROM activities').get() as {n: number}).n, 4);
  } finally { db.close(); }
});

test('source owner and reparenting must always match the destination owner', () => {
  const db = fixture();
  try {
    createRecord(db, 'accounts', { id: 'same', userId: 'u1', trackingMode: 'trading_cashflow' });
    createRecord(db, 'accounts', { id: 'other', userId: 'u2', trackingMode: 'trading_cashflow' });
    createRecord(db, 'activities', { id: 'a', userId: 'u1', accountId: 'trading', flowType: 'deposit', amount: null, idr: 1 });
    assert.throws(() => updateRecord(db, 'activities', 'a', { accountId: 'other' }), /cashflow/i);
    assert.throws(() => updateRecord(db, 'activities', 'a', { userId: 'u2' }), /cashflow/i);
    assert.throws(() => updateRecord(db, 'activities', 'a', { userId: 'u2', accountId: 'other' }), /cashflow/i);
    assert.throws(() => updateRecord(db, 'activities', 'a', { accountId: null }), /cashflow/i);
    assert.equal(updateRecord(db, 'activities', 'a', { accountId: 'same' })?.accountId, 'same');
    createRecord(db, 'accounts', { id: 'asset2', userId: 'u1', trackingMode: 'asset_ledger' });
    assert.equal(updateRecord(db, 'activities', 'a', { accountId: 'asset2', flowType: null, amount: 1, idr: 10 })?.accountId, 'asset2');
    assert.equal(updateRecord(db, 'activities', 'a', { accountId: 'trading', flowType: 'withdrawal', amount: null, idr: -10 })?.accountId, 'trading');
    assert.throws(() => updateRecord(db, 'activities', 'a', { accountId: 'asset2' }), /cashflow/i);
  } finally { db.close(); }
});

test('asset ledger accepts legacy rows but does not accept a trading flow', () => {
  const db = fixture();
  try {
    createRecord(db, 'accounts', { id: 'legacy', userId: 'u1' });
    createRecord(db, 'accounts', { id: 'asset', userId: 'u1', trackingMode: 'asset_ledger' });
    for (const id of ['legacy', 'asset']) {
      const row = createRecord(db, 'activities', { userId: 'u1', accountId: id, amount: 4, idr: -20 });
      assert.equal(row.amount, 4);
      assert.equal(row.idr, -20);
      assert.throws(() => updateRecord(db, 'activities', row.id, { flowType: 'profit' }), /cashflow/i);
    }
  } finally { db.close(); }
});

test('batch works without DatabaseSync.isTransaction (Node 22.5)', () => {
  const db = fixture();
  const oldNode = new Proxy(db, { get(target, key) {
    if (key === 'isTransaction') return undefined;
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  try {
    db.exec('BEGIN');
    const rows = createRecordsBatch(oldNode, 'activities', [
      { userId: 'u1', accountId: 'trading', amount: null, idr: 1, flowType: 'deposit' },
    ]);
    assert.equal(rows.length, 1);
    db.exec('COMMIT');
    assert.equal((db.prepare('SELECT count(*) AS n FROM activities').get() as {n:number}).n, 1);
  } finally { db.close(); }
});

test('batch can nest inside a caller transaction', () => {
  const db=fixture();
  try {
    db.exec('BEGIN');
    assert.equal(createRecordsBatch(db,'activities',[{userId:'u1',accountId:'trading',amount:null,idr:1,flowType:'deposit'}]).length,1);
    db.exec('ROLLBACK');
    assert.equal((db.prepare('SELECT count(*) n FROM activities').get() as {n:number}).n,0);
  } finally {db.close();}
});

test('batch validation is atomic when a later row is invalid', () => {
  const db = fixture();
  try {
    assert.throws(() => createRecordsBatch(db, 'activities', [
      { userId: 'u1', accountId: 'trading', amount: null, idr: 1, flowType: 'deposit' },
      { userId: 'u1', accountId: 'trading', amount: null, idr: 1, flowType: 'loss' },
    ]), /cashflow/i);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM activities').get() as {n: number}).n, 0);
  } finally { db.close(); }
});

test('schema activation rejects existing trading records without explicit flow', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initSchemaTable(db);
    defineCollection(db, { name: 'accounts', fields: [{name: 'userId', type: 'text'}, {name: 'trackingMode', type: 'text'}] });
    const fields = [
      { name: 'userId', type: 'text' as const },
      { name: 'accountId', type: 'relation' as const, options: { collectionId: 'accounts' } },
      { name: 'amount', type: 'number' as const, options: { signed: true } },
      { name: 'idr', type: 'number' as const, options: { signed: true } },
      { name: 'flowType', type: 'text' as const },
    ];
    defineCollection(db, { name: 'activities', fields });
    createRecord(db, 'accounts', { id: 't', userId: 'u1', trackingMode: 'trading_cashflow' });
    createRecord(db, 'activities', { userId: 'u1', accountId: 't', amount: null, idr: 10 });
    const nextFields = fields.map(f => f.name === 'accountId' ? { ...f, options: { ...f.options, cashflowIntegrity: constraint } } : f);
    const expectedSchemaVersion = getSchemaVersion(db, 'activities');
    assert.throws(() => updateCollection(db, 'activities', { fields: nextFields, expectedSchemaVersion }), /cashflow/i);
    assert.throws(() => rebuildCollection(db, 'activities', { fields: nextFields, expectedSchemaVersion }), /cashflow/i);
  } finally { db.close(); }
});

test('rebuild backfills an optional cashflow target mode as legacy NULL, not empty text', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initSchemaTable(db);
    defineCollection(db, { name: 'accounts', fields: [{ name: 'userId', type: 'text' }] });
    defineCollection(db, { name: 'activities', fields: [
      { name: 'userId', type: 'text' },
      { name: 'accountId', type: 'relation', options: { collectionId: 'accounts' } },
      { name: 'amount', type: 'number', options: { signed: true } },
      { name: 'idr', type: 'number', options: { signed: true } },
    ] });
    createRecord(db, 'accounts', { id: 'legacy', userId: 'u1' });
    createRecord(db, 'activities', { id: 'activity', userId: 'u1', accountId: 'legacy', amount: 1, idr: -10 });
    const targetVersion = getSchemaVersion(db, 'accounts');
    rebuildCollection(db, 'accounts', {
      fields: [
        { name: 'userId', type: 'text' },
        { name: 'trackingMode', type: 'select', options: { values: ['asset_ledger', 'trading_cashflow'], maxSelect: 1 } },
      ],
      expectedSchemaVersion: targetVersion,
    });
    assert.equal((db.prepare('SELECT trackingMode FROM accounts WHERE id=?').get('legacy') as { trackingMode: unknown }).trackingMode, null);
    const sourceFields = getCollectionByName(db, 'activities')!.fields.map(field => field.name === 'accountId'
      ? { ...field, options: { ...field.options, cashflowIntegrity: constraint } }
      : field);
    rebuildCollection(db, 'activities', {
      fields: [...sourceFields, { name: 'flowType', type: 'select', options: { values: ['deposit', 'withdrawal', 'profit', 'loss'], maxSelect: 1 } }],
      expectedSchemaVersion: getSchemaVersion(db, 'activities'),
    });
    assert.equal((db.prepare('SELECT flowType FROM activities WHERE id=?').get('activity') as { flowType: unknown }).flowType, null);
  } finally { db.close(); }
});

test('rebuild cannot reinterpret cashflow by resetting a target mode', () => {
  const db = fixture();
  try {
    createRecord(db, 'activities', { id: 'a', userId: 'u1', accountId: 'trading', flowType: 'deposit', amount: null, idr: 10 });
    const meta = getCollectionByName(db, 'accounts')!;
    const fields = meta.fields.map(field => field.name === 'trackingMode'
      ? { ...field, options: { values: ['trading_cashflow'] } }
      : field);
    const expectedSchemaVersion = getSchemaVersion(db, 'accounts');
    assert.throws(() => rebuildCollection(db, 'accounts', { fields: fields.filter(field => field.name !== 'trackingMode'), expectedSchemaVersion }), /cashflow/i);
    assert.throws(() => rebuildCollection(db, 'accounts', { fields: [...fields.filter(field => field.name !== 'trackingMode'), { name: 'trackingMode', type: 'number' }], expectedSchemaVersion }), /cashflow/i);
    assert.equal((db.prepare('SELECT trackingMode FROM accounts WHERE id=?').get('trading') as {trackingMode: string}).trackingMode, 'trading_cashflow');
  } finally { db.close(); }
});

test('valid constrained duplicate copies rows after full validation', () => {
  const db=fixture();
  try {
    createRecord(db,'activities',{id:'valid',userId:'u1',accountId:'trading',amount:null,idr:5,flowType:'deposit'});
    const copy=duplicateCollection(db,'activities','validCopy',{withData:true});
    assert.equal(copy.name,'validCopy');
    assert.equal((db.prepare('SELECT count(*) n FROM validCopy').get() as {n:number}).n,1);
  } finally {db.close();}
});

test('duplicating a source must not copy pre-existing invalid rows', () => {
  const db = fixture();
  try {
    db.prepare('INSERT INTO activities (id, userId, accountId, idr) VALUES (?, ?, ?, ?)').run('bad', 'u1', 'trading', 10);
    assert.throws(() => duplicateCollection(db, 'activities', 'copy', { withData: true }), /cashflow/i);
    assert.equal(getCollectionByName(db, 'copy'), undefined);
  } finally { db.close(); }
});

test('public context and actual function sandbox enforce the same source guard', async () => {
  const db = fixture();
  try {
    const ctx = { auth: { id: 'u1', email: 'u1@example.test' } };
    const meta = getCollectionByName(db, 'activities')!;
    db.prepare('UPDATE _collections SET rules = ? WHERE name = ?').run(JSON.stringify({ ...meta.rules, createRule: '', updateRule: '', viewRule: '' }), 'activities');
    assert.throws(() => createRecord(db, 'activities', { userId: 'u1', accountId: 'trading', amount: null, idr: 1 }, ctx), /cashflow/i);
    const result = await runFunctionCode(`
      try {
        await $db.collection('activities').create({ userId: 'u1', accountId: 'trading', amount: null, idr: 1 });
        return 'accepted';
      } catch (error) { return error.message; }
    `, { projectDb: db, dbAccess: true, timeoutMs: 8000 });
    assert.equal(result.ok, true, String(result.error));
    assert.match(String(result.result), /cashflow/i);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM activities').get() as {n: number}).n, 0);
  } finally { db.close(); }
});

test('unrelated collections remain writable when another collection has corrupt opt-in metadata', () => {
  const db = fixture();
  try {
    defineCollection(db, { name: 'unrelated', fields: [{ name: 'value', type: 'text' }] });
    const meta = getCollectionByName(db, 'activities')!;
    const fields = meta.fields.map(field => field.name === 'accountId'
      ? { ...field, options: { ...field.options, cashflowIntegrity: { ...constraint, version: 99 } } }
      : field);
    db.prepare('UPDATE _collections SET fields=? WHERE name=?').run(JSON.stringify(fields), 'activities');
    assert.throws(() => createRecord(db, 'activities', { userId: 'u1', accountId: 'trading', amount: null, idr: 1, flowType: 'deposit' }), /cashflow/i);
    const row = createRecord(db, 'unrelated', { value: 'before' });
    assert.equal(updateRecord(db, 'unrelated', row.id, { value: 'after' })?.value, 'after');
  } finally { db.close(); }
});

test('unrelated import still works when another collection has corrupt opt-in metadata', () => {
  const db = fixture();
  try {
    defineCollection(db, { name: 'unrelated', fields: [{ name: 'value', type: 'text' }] });
    const exported = JSON.parse(exportCollection(db, 'unrelated'));
    exported.records = [{ id: 'imported', value: 'safe' }];
    const meta = getCollectionByName(db, 'activities')!;
    const fields = meta.fields.map(field => field.name === 'accountId'
      ? { ...field, options: { ...field.options, cashflowIntegrity: { ...constraint, version: 99 } } }
      : field);
    db.prepare('UPDATE _collections SET fields=? WHERE name=?').run(JSON.stringify(fields), 'activities');
    const result = importCollection(db, JSON.stringify(exported), { mode: 'merge' });
    assert.equal(result.importedRecords, 1);
    assert.equal((db.prepare('SELECT value FROM unrelated WHERE id=?').get('imported') as {value: string}).value, 'safe');
  } finally { db.close(); }
});

test('unrelated schema edits work when another collection has corrupt opt-in metadata', () => {
  const db = fixture();
  try {
    defineCollection(db, { name: 'unrelated', fields: [{ name: 'value', type: 'text' }] });
    const meta = getCollectionByName(db, 'activities')!;
    const fields = meta.fields.map(field => field.name === 'accountId'
      ? { ...field, options: { ...field.options, cashflowIntegrity: { ...constraint, version: 99 } } }
      : field);
    db.prepare('UPDATE _collections SET fields=? WHERE name=?').run(JSON.stringify(fields), 'activities');
    const newFields = [{ name: 'value', type: 'text' as const }, { name: 'extra', type: 'text' as const }];
    assert.equal(updateCollection(db, 'unrelated', { fields: newFields, expectedSchemaVersion:getSchemaVersion(db,'unrelated') }).fields.length, 2);
    assert.equal(rebuildCollection(db, 'unrelated', { fields: newFields, expectedSchemaVersion:getSchemaVersion(db,'unrelated') }).fields.length, 2);
  } finally { db.close(); }
});

test('schema edits cannot silently remove an active integrity option', () => {
  const db = fixture();
  try {
    createRecord(db, 'activities', { id: 'a', userId: 'u1', accountId: 'trading', flowType: 'deposit', amount: null, idr: 10 });
    const meta = getCollectionByName(db, 'activities')!;
    const fields = meta.fields.map(f => f.name === 'accountId' ? { ...f, options: { collectionId: 'accounts' } } : f);
    const expectedSchemaVersion = getSchemaVersion(db,'activities');
    assert.throws(() => updateCollection(db, 'activities', { fields, expectedSchemaVersion }), /cashflow/i);
    assert.throws(() => rebuildCollection(db, 'activities', { fields, expectedSchemaVersion }), /cashflow/i);
  } finally { db.close(); }
});

test('target collection deletion cannot strand constrained rows', () => {
  const db = fixture();
  try {
    createRecord(db, 'activities', { id: 'a', userId: 'u1', accountId: 'trading', flowType: 'deposit', amount: null, idr: 10 });
    assert.throws(() => deleteCollection(db, 'accounts'), /cashflow/i);
    assert.ok(getCollectionByName(db, 'accounts'));
  } finally { db.close(); }
});

test('self-target cashflow configuration cannot be activated against old rows', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initSchemaTable(db);
    const fields = [
      {name:'userId', type:'text' as const}, {name:'trackingMode', type:'text' as const},
      {name:'accountId', type:'relation' as const, options:{collectionId:'entries'}},
      {name:'flowType', type:'text' as const}, {name:'amount', type:'number' as const}, {name:'idr', type:'number' as const},
    ];
    defineCollection(db, { name:'entries', fields });
    const enabled = fields.map(f => f.name === 'accountId' ? {...f, options:{...f.options, cashflowIntegrity:constraint}} : f);
    assert.throws(() => updateCollection(db, 'entries', {fields:enabled,expectedSchemaVersion:getSchemaVersion(db,'entries')}), /self|same collection/i);
    assert.equal(getCollectionByName(db, 'entries')!.fields.find(f=>f.name==='accountId')!.options!.cashflowIntegrity, undefined);
  } finally { db.close(); }
});

test('self-target is rejected during creation too', () => {
  const db=new DatabaseSync(':memory:');
  try {
    initSchemaTable(db);
    assert.throws(()=>defineCollection(db,{name:'selfie',fields:[
      {name:'userId',type:'text'},{name:'trackingMode',type:'text'},
      {name:'accountId',type:'relation',options:{collectionId:'selfie',cashflowIntegrity:constraint}},
      {name:'flowType',type:'text'},{name:'amount',type:'number'},{name:'idr',type:'number'},
    ]}),/self|same collection/i);
    assert.equal(getCollectionByName(db,'selfie'),undefined);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='selfie'").get(),undefined);
  } finally {db.close();}
});

test('unknown and malformed option versions fail before schema creation', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initSchemaTable(db);
    defineCollection(db, { name: 'accounts', fields: [{name: 'userId', type: 'text'}, {name: 'trackingMode', type: 'text'}] });
    assert.throws(() => defineCollection(db, { name: 'invalid', fields: [
      { name: 'userId', type: 'text' },
      { name: 'accountId', type: 'relation', options: { collectionId: 'accounts', cashflowIntegrity: { ...constraint, version: 2 } as any } },
      { name: 'amount', type: 'number' }, { name: 'idr', type: 'number' }, { name: 'flowType', type: 'text' },
    ] }), /cashflow/i);
    assert.equal(getCollectionByName(db, 'invalid'), undefined);
  } finally { db.close(); }
});

test('nullable owner relation cascades cannot silently invalidate a source row', () => {
  const db = fixture();
  try {
    defineCollection(db, { name: 'owners', fields: [{ name: 'name', type: 'text' }] });
    // An owner field can be a relation in some schemas; put such a relation on
    // the account and point it at a real owner, then exercise setNull.
    const accountMeta = getCollectionByName(db, 'accounts')!;
    const fields = accountMeta.fields.map(field => field.name === 'userId'
      ? { ...field, type: 'relation' as const, options: { collectionId: 'owners', cascadeDelete: 'setNull' as const } }
      : field);
    assert.throws(() => updateCollection(db, 'accounts', { fields, expectedSchemaVersion:getSchemaVersion(db,'accounts') }), /cashflow/i);
  } finally { db.close(); }
});
