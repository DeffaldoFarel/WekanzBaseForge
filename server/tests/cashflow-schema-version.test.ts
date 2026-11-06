import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initSchemaTable, defineCollection, getCollectionByName, getSchemaVersion, rebuildCollection, updateCollection } from '../src/core/schema.js';
import { createRecord, getRecord } from '../src/core/records.js';
import type { FieldDefinition } from '../src/core/fieldTypes.js';

const contract = {version:1 as const, sourceOwner:'userId', targetOwner:'userId', targetMode:'trackingMode', assetMode:'asset_ledger', tradingMode:'trading_cashflow', flowField:'flowType', quantityField:'amount', valueField:'idr', immutableModeWhenReferenced:true};
const targetFields: FieldDefinition[] = [{name:'userId',type:'text'}, {name:'trackingMode',type:'text'}];
const sourceFields: FieldDefinition[] = [
  {name:'userId',type:'text'}, {name:'accountId',type:'relation',options:{collectionId:'accounts'}},
  {name:'flowType',type:'text'}, {name:'amount',type:'number'}, {name:'idr',type:'number',options:{signed:true}},
];
const enabled: FieldDefinition[] = sourceFields.map(field => field.name === 'accountId' ? {...field, options:{...field.options, cashflowIntegrity:contract}} : field);
const extra: FieldDefinition = {name:'extra',type:'text'};

function fixture() {
  const db = new DatabaseSync(':memory:');
  initSchemaTable(db);
  defineCollection(db,{name:'accounts',fields:targetFields});
  defineCollection(db,{name:'activities',fields:sourceFields});
  defineCollection(db,{name:'unrelated',fields:[{name:'value',type:'text'}]});
  return db;
}

test('core unrelated PATCH and rebuild retain versionless behavior', () => {
  const db=fixture();
  try {
    const fields: FieldDefinition[]=[{name:'value',type:'text'}];
    createRecord(db,'unrelated',{id:'r',value:'preserved'});
    updateCollection(db,'unrelated',{fields:[...fields,extra]});
    rebuildCollection(db,'unrelated',{fields});
    assert.equal(getRecord(db,'unrelated','r')!.value,'preserved');
  } finally {db.close();}
});

test('core activation and active source and target edits require CAS', () => {
  const db=fixture();
  try {
    for (const mutate of [updateCollection,rebuildCollection]) {
      assert.throws(()=>mutate(db,'activities',{fields:enabled}),/schema version/i);
    }
    updateCollection(db,'activities',{fields:enabled,expectedSchemaVersion:getSchemaVersion(db,'activities')});
    for (const mutate of [updateCollection,rebuildCollection]) {
      assert.throws(()=>mutate(db,'activities',{fields:sourceFields}),/schema version/i);
      assert.throws(()=>mutate(db,'accounts',{fields:targetFields}),/schema version/i);
    }
    assert.deepEqual(getCollectionByName(db,'activities')!.fields.find(f=>f.name==='accountId')!.options!.cashflowIntegrity,contract);
  } finally {db.close();}
});

test('core optional CAS distinguishes omission from explicitly invalid versions', () => {
  const db=fixture();
  try {
    const fields: FieldDefinition[]=[{name:'value',type:'text'}];
    for (const mutate of [updateCollection,rebuildCollection]) {
      for(const value of [undefined,null,'1',false,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) {
        assert.throws(()=>mutate(db,'unrelated',{fields,expectedSchemaVersion:value as number}),/schema version/i,String(value));
      }
    }
    const version=getSchemaVersion(db,'unrelated');
    updateCollection(db,'unrelated',{fields:[...fields,extra],expectedSchemaVersion:version});
    for (const mutate of [updateCollection,rebuildCollection]) {
      assert.throws(()=>mutate(db,'unrelated',{fields,expectedSchemaVersion:version}),/schema version/i);
    }
    assert.ok(getCollectionByName(db,'unrelated')!.fields.some(field=>field.name==='extra'));
  } finally {db.close();}
});

test('malformed source markers protect their named target without blocking unrelated edits', () => {
  const db=fixture();
  try {
    for(const marker of [null,false,{}, {...contract,version:99}]) {
      const damaged=sourceFields.map(field=>field.name==='accountId'?{...field,options:{...field.options,cashflowIntegrity:marker}}:field);
      db.prepare('UPDATE _collections SET fields=? WHERE name=?').run(JSON.stringify(damaged),'activities');
      for(const mutate of [updateCollection,rebuildCollection]) {
        assert.throws(()=>mutate(db,'accounts',{fields:targetFields}),/schema version/i);
        assert.throws(()=>mutate(db,'activities',{fields:damaged as FieldDefinition[]}),/schema version|cashflow/i);
        assert.throws(()=>mutate(db,'activities',{fields:damaged as FieldDefinition[],expectedSchemaVersion:getSchemaVersion(db,'activities')}),/cashflow/i);
      }
    }
    const unrelated: FieldDefinition[]=[{name:'value',type:'text'},extra];
    updateCollection(db,'unrelated',{fields:unrelated});
    rebuildCollection(db,'unrelated',{fields:unrelated});
  } finally {db.close();}
});

test('activation advances the target revision so a pre-activation token becomes stale', () => {
  const db = fixture();
  try {
    const targetVersion = getSchemaVersion(db, 'accounts');
    updateCollection(db, 'activities', { fields: enabled, expectedSchemaVersion: getSchemaVersion(db, 'activities') });
    assert.ok(getSchemaVersion(db, 'accounts') > targetVersion);
    assert.throws(() => updateCollection(db, 'accounts', { fields: [...targetFields, extra], expectedSchemaVersion: targetVersion }), /schema version/i);
    updateCollection(db, 'accounts', { fields: [...targetFields, extra], expectedSchemaVersion: getSchemaVersion(db, 'accounts') });
    assert.ok(getCollectionByName(db, 'accounts')!.fields.some(field => field.name === 'extra'));
  } finally { db.close(); }
});

test('source creation advances the target revision before later target edits', () => {
  const db = fixture();
  try {
    const targetVersion = getSchemaVersion(db, 'accounts');
    defineCollection(db, { name: 'newActivities', fields: enabled });
    assert.equal(getSchemaVersion(db, 'accounts'), targetVersion + 1);
    assert.throws(() => updateCollection(db, 'accounts', { fields: [...targetFields, extra], expectedSchemaVersion: targetVersion }), /schema version/i);
  } finally { db.close(); }
});

test('rebuild activation advances the target revision atomically', () => {
  const db = fixture();
  try {
    const targetVersion = getSchemaVersion(db, 'accounts');
    rebuildCollection(db, 'activities', { fields: enabled, expectedSchemaVersion: getSchemaVersion(db, 'activities') });
    assert.equal(getSchemaVersion(db, 'accounts'), targetVersion + 1);
    assert.throws(() => updateCollection(db, 'accounts', { fields: [...targetFields, extra], expectedSchemaVersion: targetVersion }), /schema version/i);
  } finally { db.close(); }
});

test('activating a second cashflow target invalidates that target draft after PATCH and rebuild', () => {
  const db = fixture();
  try {
    defineCollection(db, { name: 'otherAccounts', fields: targetFields });
    const other: FieldDefinition = { name: 'otherAccountId', type: 'relation', options: { collectionId: 'otherAccounts' } };
    const initial = [...enabled, other];
    updateCollection(db, 'activities', { fields: initial, expectedSchemaVersion: getSchemaVersion(db, 'activities') });
    let current = initial;
    for (const mutate of [updateCollection, rebuildCollection]) {
      const targetName = mutate === updateCollection ? 'secondTarget' : 'thirdTarget';
      defineCollection(db, { name: targetName, fields: targetFields });
      const relation: FieldDefinition = { name: `${targetName}Id`, type: 'relation', options: { collectionId: targetName } };
      current = [...current, relation];
      const before = getSchemaVersion(db, targetName);
      const activated = current.map(field => field.name === relation.name
        ? { ...field, options: { ...field.options, cashflowIntegrity: contract } }
        : field);
      mutate(db, 'activities', { fields: activated, expectedSchemaVersion: getSchemaVersion(db, 'activities') });
      assert.ok(getSchemaVersion(db, targetName) > before, mutate.name);
      assert.throws(() => updateCollection(db, targetName, { fields: targetFields, expectedSchemaVersion: before }), /schema version/i);
      current = activated;
    }
  } finally { db.close(); }
});

test('core accepts equivalent reordered cashflow contract keys and still rejects changes', () => {
  const db=fixture();
  try {
    updateCollection(db,'activities',{fields:enabled,expectedSchemaVersion:getSchemaVersion(db,'activities')});
    const reordered=Object.fromEntries(Object.entries(contract).reverse()) as typeof contract;
    const fields=enabled.map(field=>field.name==='accountId'?{...field,options:{...field.options,cashflowIntegrity:reordered}}:field);
    for (const mutate of [updateCollection,rebuildCollection]) {
      mutate(db,'activities',{fields,expectedSchemaVersion:getSchemaVersion(db,'activities')});
      const changed=fields.map(field=>field.name==='accountId'?{...field,options:{...field.options,cashflowIntegrity:{...reordered,assetMode:'other'}}}:field);
      assert.throws(()=>mutate(db,'activities',{fields:changed,expectedSchemaVersion:getSchemaVersion(db,'activities')}),/cashflow/i);
    }
    assert.deepEqual(getCollectionByName(db,'activities')!.fields.find(field=>field.name==='accountId')!.options!.cashflowIntegrity,contract);
  } finally {db.close();}
});

test('malformed prospective markers cannot bypass version and configuration checks', () => {
  const db=fixture();
  try {
    const malformed=sourceFields.map(field=>field.name==='accountId'?{...field,options:{...field.options,cashflowIntegrity:null}}:field) as FieldDefinition[];
    for(const mutate of [updateCollection,rebuildCollection]) {
      assert.throws(()=>mutate(db,'activities',{fields:malformed}),/schema version/i);
      assert.throws(()=>mutate(db,'activities',{fields:malformed,expectedSchemaVersion:getSchemaVersion(db,'activities')}),/cashflow/i);
    }
    assert.equal(getCollectionByName(db,'activities')!.fields.find(f=>f.name==='accountId')!.options!.cashflowIntegrity,undefined);
  } finally {db.close();}
});
