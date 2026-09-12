import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initSchemaTable, defineCollection, getCollectionByName, rebuildCollection } from '../src/core/schema.js';
import { createRecord, getRecord } from '../src/core/records.js';

test('rebuildCollection: schema edit via API logic', () => {
  const db = new DatabaseSync(':memory:');
  initSchemaTable(db);

  // 1. Create collection
  defineCollection(db, {
    name: 'products',
    fields: [
      { name: 'name', type: 'text', required: true },
      { name: 'price', type: 'number' },
      { name: 'old_tag', type: 'text' },
    ],
  });

  // 2. Insert record
  const r1 = createRecord(db, 'products', {
    name: 'Sepatu Keren',
    price: 150000,
    old_tag: 'promo',
  });
  assert.equal(r1.name, 'Sepatu Keren');

  // 3. Edit schema:
  // - Drop old_tag
  // - Add stock (number, required: true with default 0)
  // - Change price to text
  const updated = rebuildCollection(db, 'products', {
    fields: [
      { name: 'name', type: 'text', required: true },
      { name: 'price', type: 'text' },
      { name: 'stock', type: 'number', required: true },
    ],
  });

  assert.equal(updated.fields.length, 3);
  assert.equal(updated.fields.find(f => f.name === 'old_tag'), undefined);
  assert.equal(updated.fields.find(f => f.name === 'stock')?.type, 'number');

  // 4. Verify existing record survived and converted
  const rec = getRecord(db, 'products', r1.id);
  assert.ok(rec);
  assert.equal(rec.name, 'Sepatu Keren');
  assert.equal(rec.price, '150000'); // Converted to text
  assert.equal(rec.stock, 0); // Default applied
  assert.equal((rec as Record<string, unknown>).old_tag, undefined); // Column dropped
});
