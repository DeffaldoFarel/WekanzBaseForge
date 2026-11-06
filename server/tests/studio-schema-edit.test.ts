import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStudioSchemaEdit, studioSchemaSaveErrorMessage } from '../../dashboard/lib/schemaEdit';

const fields = [{ name: 'value', type: 'text' as const }];

test('Studio schema payload stays paired with its draft baseline', () => {
  assert.deepEqual(buildStudioSchemaEdit({ schemaVersion: 3 }, fields, [{ name: 'idx_value', fields: ['value'] }]), {
    fields,
    indexes: [{ name: 'idx_value', fields: ['value'] }],
    expectedSchemaVersion: 3,
  });
  assert.deepEqual(buildStudioSchemaEdit({ schemaVersion: 0 }, fields, []), {
    fields,
    indexes: [],
    expectedSchemaVersion: 0,
  });
});

test('Studio never sends a malformed schema version', () => {
  for (const schemaVersion of [undefined, null, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3']) {
    assert.throws(() => buildStudioSchemaEdit({ schemaVersion: schemaVersion as number }, fields, []), /reload/i, String(schemaVersion));
  }
});

test('Studio conflict explains that reload requires explicit review', () => {
  assert.equal(studioSchemaSaveErrorMessage({ code: 'SCHEMA_VERSION_CONFLICT' }),
    'Schema changed elsewhere. Reload and review the current schema before saving; your draft was preserved.');
  assert.equal(studioSchemaSaveErrorMessage(new Error('Cashflow integrity target is missing')),
    'This schema change violates cashflow integrity. Review the affected relation and its history before saving.');
  assert.equal(studioSchemaSaveErrorMessage(new Error('offline')), 'Failed to update schema');
});
