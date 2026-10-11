// ============================================================================
// SECURITY: validateValue must enforce MEANING, not only shape.
// Audit findings: negative amounts, invalid dates, and non-array subtasks
// were accepted because 'number' had no floor and 'date' checked nothing.
// ============================================================================

import { test } from 'node:test';
import assert from 'node:assert';
import { validateValue, type FieldDefinition } from '../src/core/fieldTypes.js';

const numberField = (options?: FieldDefinition['options']): FieldDefinition =>
  ({ name: 'amount', type: 'number', required: false, options });

const dateField = (name = 'tanggal'): FieldDefinition =>
  ({ name, type: 'date', required: false });

test('security: numbers without an explicit floor reject negatives (amount cannot be < 0)', () => {
  // Explicit min always wins — including negative mins.
  assert.equal(validateValue(numberField({ min: -10 }), -5), null);
  assert.equal(validateValue(numberField({ min: -10 }), -11) !== null, true);

  // No explicit min → default floor 0 (amounts, limits, prices).
  assert.equal(validateValue(numberField(), -0.01) !== null, true);
  assert.equal(validateValue(numberField(), -1000) !== null, true);
  assert.equal(validateValue(numberField(), 0), null);
  assert.equal(validateValue(numberField(), 12.5), null);

  // noDecimal still enforced.
  assert.equal(validateValue(numberField({ noDecimal: true }), 1.5) !== null, true);
});

test('security: date fields reject invalid calendar values', () => {
  assert.equal(validateValue(dateField(), '2026-10-11'), null);
  assert.equal(validateValue(dateField(), '2026-10-11T08:30:00.000Z'), null);
  assert.equal(validateValue(dateField(), '2026-02-30') !== null, true, 'Feb 30 does not exist');
  assert.equal(validateValue(dateField(), 'not-a-date') !== null, true);
  assert.equal(validateValue(dateField(), '13/10/2026') !== null, true, 'DD/MM/YYYY is not ISO');
  assert.equal(validateValue(dateField(), '') !== null, true, 'empty string is not a date');
  assert.equal(validateValue(dateField(), 123) !== null, true, 'numbers are not date strings');
});

test('security: jsonArray text fields must parse to an array', () => {
  const subtasks: FieldDefinition =
    ({ name: 'subtasks', type: 'text', required: false, options: { jsonArray: true } });
  assert.equal(validateValue(subtasks, JSON.stringify([{ title: 'a', isCompleted: false }])), null);
  assert.equal(validateValue(subtasks, '[]'), null);
  assert.equal(validateValue(subtasks, '{"title":"not an array"}') !== null, true);
  assert.equal(validateValue(subtasks, 'plain text') !== null, true);
});

test('security: backendManaged fields reject end-user writes but allow service context', async () => {
  const { createRecord, updateRecord } = await import('../src/core/records.js');
  const { ForbiddenError } = await import('../src/core/rules.js');
  const { initPlatformDb, closePlatformDb, createProject, provisionProjectStorage } = await import('../src/core/platformDb.js');
  const { getProjectDb, closeAllProjectDbs } = await import('../src/core/projectDbManager.js');
  const { defineCollection } = await import('../src/core/schema.js');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.resolve('../data/sec-field-mgd-test');
  fs.rmSync(dir, { recursive: true, force: true });
  process.env.DATA_DIR = dir;
  initPlatformDb();
  const project = createProject('secfieldmgd', 'sec-field-managed', {
    auth: true, storage: true, functions: true, realtime: true,
  });
  provisionProjectStorage(project.id);
  const db = getProjectDb(project.id);
  defineCollection(db, {
    name: 'missions',
    fields: [
      { name: 'userId', type: 'text', required: true },
      { name: 'generalStatus', type: 'text', options: { backendManaged: true } },
    ],
    rules: {
      listRule: '@request.auth.id != "" && userId = @request.auth.id',
      viewRule: '',
      createRule: '@request.auth.id != "" && userId = @request.auth.id',
      updateRule: '@request.auth.id != "" && userId = @request.auth.id',
      deleteRule: '',
    },
  });

  const user = { auth: { id: 'u1' } };
  // End user forging generalStatus on CREATE → forbidden.
  let threw = false;
  try { createRecord(db, 'missions', { userId: 'u1', generalStatus: 'Done' }, user); }
  catch (e) { threw = e instanceof ForbiddenError; }
  assert.equal(threw, true, 'create with forged generalStatus must be forbidden');

  // Clean create (no generalStatus) then forged PATCH → forbidden.
  const rec = createRecord(db, 'missions', { userId: 'u1' }, user);
  threw = false;
  try { updateRecord(db, 'missions', rec.id as string, { generalStatus: 'Done' }, user); }
  catch (e) { threw = e instanceof ForbiddenError; }
  assert.equal(threw, true, 'patch with forged generalStatus must be forbidden');

  // Service context (undefined reqCtx) may still write it.
  const rec2 = updateRecord(db, 'missions', rec.id as string, { generalStatus: 'Done' }, undefined);
  assert.equal((rec2 as Record<string, unknown>).generalStatus, 'Done');

  closeAllProjectDbs();
  closePlatformDb();
  fs.rmSync(dir, { recursive: true, force: true });
});
