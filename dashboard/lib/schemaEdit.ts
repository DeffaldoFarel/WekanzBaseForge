import type { FieldDef, IndexDef } from './api';

/** A CAS token belongs to the exact schema snapshot from which the draft came. */
export function buildStudioSchemaEdit(
  baseline: { schemaVersion?: number },
  fields: FieldDef[],
  indexes: IndexDef[],
): { fields: FieldDef[]; indexes: IndexDef[]; expectedSchemaVersion: number } {
  const version = baseline.schemaVersion;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    throw new Error('Schema version is unavailable. Reload and review the current schema before saving.');
  }
  return { fields, indexes, expectedSchemaVersion: version };
}

export function studioSchemaSaveErrorMessage(error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : '';
  if (code === 'SCHEMA_VERSION_CONFLICT' || /schema version/i.test(message)) {
    return 'Schema changed elsewhere. Reload and review the current schema before saving; your draft was preserved.';
  }
  if (/cashflow integrity/i.test(message)) {
    return 'This schema change violates cashflow integrity. Review the affected relation and its history before saving.';
  }
  return 'Failed to update schema';
}
