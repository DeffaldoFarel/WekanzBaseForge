import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initSchemaTable, defineCollection, updateCollection, rebuildCollection, deleteCollection, duplicateCollection, getCollectionByName, getSchemaVersion } from '../src/core/schema.js';
import { createRecord, getRecord } from '../src/core/records.js';

const contract = {version:1 as const, sourceOwner:'userId', targetOwner:'userId', targetMode:'trackingMode', assetMode:'asset_ledger', tradingMode:'trading_cashflow', flowField:'flowType', quantityField:'amount', valueField:'idr', immutableModeWhenReferenced:true};
const fields = [
  {name:'userId', type:'text' as const},
  {name:'accountId', type:'relation' as const, options:{collectionId:'accounts'}},
  {name:'flowType', type:'text' as const}, {name:'amount', type:'number' as const},
  {name:'idr', type:'number' as const, options:{signed:true}},
];
const enabled = fields.map(f => f.name === 'accountId' ? {...f, options:{...f.options, cashflowIntegrity:contract}} : f);
function pair() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cashflow-schema-race-'));
  const db = new DatabaseSync(path.join(dir, 'db.sqlite'));
  db.exec('PRAGMA journal_mode=WAL');
  const other = new DatabaseSync(path.join(dir, 'db.sqlite'));
  other.exec('PRAGMA busy_timeout=1');
  initSchemaTable(db);
  defineCollection(db, {name:'accounts', fields:[{name:'userId', type:'text'}, {name:'trackingMode', type:'text'}]});
  defineCollection(db, {name:'activities', fields});
  return {db, other, close() { db.close(); other.close(); fs.rmSync(dir,{recursive:true,force:true}); }};
}
function interleaveAfterMetadataRead(db: DatabaseSync, action: () => void) {
  let attempted = false;
  let failure: unknown;
  const proxy = new Proxy(db, {get(target, key) {
    if (key === 'prepare') return (sql: string) => {
      const stmt = target.prepare(sql);
      if (!attempted && sql.includes('AS schemaVersion FROM _collections')) return new Proxy(stmt, {get(statement, operation) {
        if (operation === 'get' || operation === 'all') return (...args: any[]) => {
          const result = (statement[operation] as any)(...args);
          attempted = true;
          try { action(); } catch (err) { failure = err; }
          return result;
        };
        const value = Reflect.get(statement, operation, statement);
        return typeof value === 'function' ? value.bind(statement) : value;
      }});
      return stmt;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
  return {proxy, verifyBlocked() { assert.equal(attempted, true); assert.match(String(failure), /locked|busy/i); }};
}

test('schema update locks before metadata so activation cannot interleave', () => {
  const p = pair();
  try {
    const version = getSchemaVersion(p.db, 'activities');
    const race = interleaveAfterMetadataRead(p.db, () => updateCollection(p.other, 'activities', {fields: enabled, expectedSchemaVersion:version}));
    updateCollection(race.proxy, 'activities', {fields});
    race.verifyBlocked();
    assert.throws(() => updateCollection(p.other, 'activities', {fields:enabled,expectedSchemaVersion:version}), /version/i);
    assert.equal(getCollectionByName(p.db, 'activities')!.fields.find(f => f.name === 'accountId')!.options!.cashflowIntegrity, undefined);
  } finally { p.close(); }
});

test('source and target data remain unchanged when constrained target collection deletion is rejected', () => {
  const p=pair();
  try {
    const version=getSchemaVersion(p.db,'activities');
    updateCollection(p.db,'activities',{fields:enabled,expectedSchemaVersion:version});
    createRecord(p.db,'accounts',{id:'a',userId:'u',trackingMode:'trading_cashflow'});
    createRecord(p.db,'activities',{id:'t',userId:'u',accountId:'a',flowType:'deposit',amount:null,idr:3});
    assert.throws(()=>deleteCollection(p.db,'accounts'),/cashflow/i);
    assert.equal(getRecord(p.db,'activities','t')!.accountId,'a');
    assert.equal(getRecord(p.other,'accounts','a')!.trackingMode,'trading_cashflow');
  } finally {p.close();}
});

test('a client supplying a stale schema version cannot overwrite a newer option edit', () => {
  const p = pair();
  try {
    const version = getSchemaVersion(p.db, 'activities');
    updateCollection(p.other, 'activities', {fields:enabled,expectedSchemaVersion:version});
    assert.throws(()=>updateCollection(p.db,'activities',{fields,expectedSchemaVersion:version}),/version/i);
    assert.deepEqual(getCollectionByName(p.db,'activities')!.fields.find(f=>f.name==='accountId')!.options!.cashflowIntegrity,contract);
  } finally {p.close();}
});

test('stale replacement cannot revert flow metadata on an opted-in source', () => {
  const p=pair();
  try {
    updateCollection(p.db,'activities',{fields:enabled,expectedSchemaVersion:getSchemaVersion(p.db,'activities')});
    const original=getCollectionByName(p.db,'activities')!.fields;
    const oldVersion=getSchemaVersion(p.db,'activities');
    const changed=original.map(field=>field.name==='flowType'?{...field,options:{values:['deposit']}}:field);
    updateCollection(p.other,'activities',{fields:changed,expectedSchemaVersion:oldVersion});
    assert.throws(()=>updateCollection(p.db,'activities',{fields:original}),/version/i);
    assert.throws(()=>updateCollection(p.db,'activities',{fields:original,expectedSchemaVersion:oldVersion}),/version/i);
    assert.deepEqual(getCollectionByName(p.db,'activities')!.fields.find(field=>field.name==='flowType')!.options,{values:['deposit']});
  } finally {p.close();}
});

test('unrelated stale CAS is rejected, while a versionless rebuild retains legacy replacement semantics', () => {
  const p = pair();
  try {
    const version = getSchemaVersion(p.db, 'activities');
    createRecord(p.db, 'activities', {id:'r', userId:'u', accountId:'x', idr:1});
    updateCollection(p.other, 'activities', {fields:[...fields, {name:'extra', type:'text'}],expectedSchemaVersion:version});
    p.other.prepare('UPDATE activities SET extra=? WHERE id=?').run('valuable', 'r');
    assert.throws(() => rebuildCollection(p.db, 'activities', {fields, expectedSchemaVersion:version}), /stale|version|conflict/i);
    assert.equal(getRecord(p.db, 'activities', 'r')!.extra, 'valuable');
    // Legacy versionless PUT was always a full replacement, including dropped data.
    rebuildCollection(p.db, 'activities', {fields});
    assert.equal('extra' in getRecord(p.db, 'activities', 'r')!, false);
  } finally { p.close(); }
});

test('source and target stale versionless rebuilds are blocked after activation', () => {
  const p=pair();
  try {
    const targetBefore=getCollectionByName(p.db,'accounts')!.fields;
    const sourceBefore=getCollectionByName(p.db,'activities')!.fields;
    const sourceVersion=getSchemaVersion(p.db,'activities');
    createRecord(p.db,'accounts',{id:'a',userId:'u',trackingMode:'trading_cashflow'});
    createRecord(p.db,'activities',{id:'t',userId:'u',accountId:'a',flowType:'deposit',amount:null,idr:3});
    updateCollection(p.other,'activities',{fields:enabled,expectedSchemaVersion:sourceVersion});
    for(const mutate of [updateCollection,rebuildCollection]) {
      assert.throws(()=>mutate(p.db,'activities',{fields:sourceBefore}),/version/i);
      assert.throws(()=>mutate(p.db,'activities',{fields:sourceBefore,expectedSchemaVersion:sourceVersion}),/version/i);
      assert.throws(()=>mutate(p.db,'accounts',{fields:targetBefore}),/version/i);
    }
    assert.deepEqual(getCollectionByName(p.db,'activities')!.fields.find(f=>f.name==='accountId')!.options!.cashflowIntegrity,contract);
    assert.equal(getRecord(p.other,'activities','t')!.idr,3);
    assert.equal(getRecord(p.other,'accounts','a')!.trackingMode,'trading_cashflow');
  } finally {p.close();}
});

test('two-connection target activation can leave a pre-activation target CAS unchanged', () => {
  const p=pair();
  try {
    const snapshot=getCollectionByName(p.db,'accounts')!;
    const version=snapshot.schemaVersion!;
    updateCollection(p.other,'activities',{fields:enabled,expectedSchemaVersion:getSchemaVersion(p.other,'activities')});
    assert.equal(getSchemaVersion(p.db,'accounts'),version + 1);
    const changed=snapshot.fields.map(field=>field.name==='trackingMode'?{...field,options:{values:['asset_ledger']}}:field);
    assert.throws(()=>updateCollection(p.db,'accounts',{fields:changed,expectedSchemaVersion:version}),/version/i);
    updateCollection(p.db,'accounts',{fields:changed,expectedSchemaVersion:getSchemaVersion(p.db,'accounts')});
    assert.deepEqual(getCollectionByName(p.other,'accounts')!.fields.find(f=>f.name==='trackingMode')!.options,{values:['asset_ledger']});
  } finally {p.close();}
});

test('stale target CAS and invalid candidates cannot change protected data', () => {
  const p=pair();
  try {
    updateCollection(p.db,'activities',{fields:enabled,expectedSchemaVersion:getSchemaVersion(p.db,'activities')});
    createRecord(p.db,'accounts',{id:'a',userId:'u',trackingMode:'trading_cashflow'});
    createRecord(p.db,'activities',{id:'t',userId:'u',accountId:'a',flowType:'deposit',amount:null,idr:3});
    const before=getCollectionByName(p.db,'accounts')!.fields;
    const version=getSchemaVersion(p.db,'accounts');
    updateCollection(p.other,'accounts',{fields:[...before,{name:'extra',type:'text'}],expectedSchemaVersion:version});
    for(const mutate of [updateCollection,rebuildCollection]) {
      assert.throws(()=>mutate(p.db,'accounts',{fields:before,expectedSchemaVersion:version}),/version/i);
    }
    const current=getCollectionByName(p.db,'accounts')!;
    assert.throws(()=>rebuildCollection(p.db,'accounts',{fields:current.fields.filter(f=>f.name!=='trackingMode'),expectedSchemaVersion:current.schemaVersion}),/cashflow/i);
    assert.ok(getCollectionByName(p.other,'accounts')!.fields.some(f=>f.name==='trackingMode'));
    assert.equal(getRecord(p.other,'accounts','a')!.trackingMode,'trading_cashflow');
    assert.equal(getRecord(p.other,'activities','t')!.idr,3);
  } finally {p.close();}
});

test('schema creation locks target lookup before concurrent deletion', () => {
  const p = pair();
  try {
    const race = interleaveAfterMetadataRead(p.db, () => deleteCollection(p.other, 'accounts'));
    defineCollection(race.proxy, {name:'constrained', fields:enabled});
    race.verifyBlocked();
    assert.ok(getCollectionByName(p.db, 'accounts'));
    assert.throws(() => deleteCollection(p.other, 'accounts'), /cashflow/i);
  } finally { p.close(); }
});

test('schema rebuild locks before metadata so activation cannot interleave', () => {
  const p = pair();
  try {
    const version = getSchemaVersion(p.db, 'activities');
    const race = interleaveAfterMetadataRead(p.db, () => updateCollection(p.other, 'activities', {fields:enabled,expectedSchemaVersion:version}));
    rebuildCollection(race.proxy, 'activities', {fields});
    race.verifyBlocked();
    assert.throws(() => updateCollection(p.other, 'activities', {fields:enabled,expectedSchemaVersion:version}), /version/i);
    assert.equal(getCollectionByName(p.db, 'activities')!.fields.find(f=>f.name==='accountId')!.options!.cashflowIntegrity, undefined);
  } finally { p.close(); }
});

test('target rebuild holds the lock before constraint discovery and activation revalidates target', () => {
  const p=pair();
  try {
    const version=getSchemaVersion(p.db,'activities');
    const race=interleaveAfterMetadataRead(p.db,()=>updateCollection(p.other,'activities',{fields:enabled,expectedSchemaVersion:version}));
    // An unprotected target can still be rebuilt versionlessly. Activation
    // must wait, then reject the resulting target when its mode is missing.
    rebuildCollection(race.proxy,'accounts',{fields:[{name:'userId',type:'text'}]});
    race.verifyBlocked();
    assert.throws(()=>updateCollection(p.other,'activities',{fields:enabled,expectedSchemaVersion:version}),/cashflow/i);
    assert.equal(getCollectionByName(p.db,'activities')!.fields.find(f=>f.name==='accountId')!.options!.cashflowIntegrity,undefined);
    assert.deepEqual(getCollectionByName(p.other,'accounts')!.fields.map(f=>f.name),['userId']);
  } finally {p.close();}
});

test('target deletion locks before checking constraints', () => {
  const p = pair();
  try {
    const version = getSchemaVersion(p.db, 'activities');
    const race = interleaveAfterMetadataRead(p.db, () => updateCollection(p.other, 'activities', {fields:enabled,expectedSchemaVersion:version}));
    assert.equal(deleteCollection(race.proxy, 'accounts'), true);
    race.verifyBlocked();
    assert.equal(getCollectionByName(p.db, 'accounts'), undefined);
  } finally { p.close(); }
});

test('duplicate locks before checking source and copying its data', () => {
  const p = pair();
  try {
    const version = getSchemaVersion(p.db, 'activities');
    const race = interleaveAfterMetadataRead(p.db, () => updateCollection(p.other, 'activities', {fields:enabled,expectedSchemaVersion:version}));
    duplicateCollection(race.proxy, 'activities', 'activitiesCopy', {withData:true});
    race.verifyBlocked();
    assert.ok(getCollectionByName(p.db, 'activitiesCopy'));
  } finally { p.close(); }
});

test('a project writer lock also blocks unrelated opt-out record creates', () => {
  const p = pair();
  try {
    defineCollection(p.db, {name:'unrelated',fields:[{name:'value',type:'text'}]});
    p.db.exec('BEGIN IMMEDIATE');
    assert.throws(()=>createRecord(p.other,'unrelated',{value:'safe'}),/locked|busy/i);
    p.db.exec('ROLLBACK');
    assert.equal(createRecord(p.other,'unrelated',{value:'safe'}).value,'safe');
  } finally {p.close();}
});

test('a deferred reader with stale snapshot cannot upgrade and must release its lock', () => {
  const p = pair();
  try {
    p.db.exec('BEGIN');
    getCollectionByName(p.db, 'activities');
    const version = getSchemaVersion(p.db, 'activities');
    updateCollection(p.other, 'activities', {fields:[...fields,{name:'extra',type:'text'}],expectedSchemaVersion:version});
    assert.throws(()=>updateCollection(p.db,'activities',{fields,expectedSchemaVersion:version}), /locked|busy/i);
    p.db.exec('ROLLBACK');
    assert.ok(getCollectionByName(p.other, 'activities')!.fields.some(field=>field.name==='extra'));
    assert.doesNotThrow(()=>defineCollection(p.other,{name:'afterSnapshot',fields:[]}));
  } finally { p.close(); }
});

test('failed nested schema work rolls back its savepoint while caller can commit', () => {
  const p = pair();
  try {
    p.db.exec('BEGIN');
    assert.throws(() => defineCollection(p.db, {name:'badNested', fields:[{name:'value',type:'text'}], indexes:[{name:'invalid-index',fields:['value']}]}));
    assert.equal(getCollectionByName(p.db, 'badNested'), undefined);
    defineCollection(p.db,{name:'goodNested',fields:[]});
    p.db.exec('COMMIT');
    assert.ok(getCollectionByName(p.other, 'goodNested'));
    assert.equal(getCollectionByName(p.other, 'badNested'), undefined);
  } finally { p.close(); }
});

test('collection creation and duplicate failure roll back metadata and physical tables', () => {
  const p = pair();
  try {
    assert.throws(() => defineCollection(p.db, {name:'bad', fields:[{name:'value',type:'text'}], indexes:[{name:'badindex', fields:['missing']}]}));
    assert.equal(getCollectionByName(p.db, 'bad'), undefined);
    assert.equal(p.db.prepare("SELECT name FROM sqlite_master WHERE name='bad'").get(), undefined);
    // A duplicate with a colliding user index must roll back the newly created table.
    p.db.exec('CREATE INDEX conflict_idx ON activities(userId)');
    p.db.prepare('UPDATE _collections SET indexes=? WHERE name=?').run(JSON.stringify([{name:'notvalid-name', fields:['userId']}]), 'activities');
    assert.throws(() => duplicateCollection(p.db, 'activities', 'failedCopy', {withData:true}));
    assert.equal(getCollectionByName(p.db, 'failedCopy'), undefined);
    assert.equal(p.db.prepare("SELECT name FROM sqlite_master WHERE name='failedCopy'").get(), undefined);
    assert.doesNotThrow(() => defineCollection(p.other, {name:'afterFailure', fields:[]}));
  } finally { p.close(); }
});
