import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import type { CollectionMeta } from './schema.js';
import { getCollectionByName, listCollections } from './schema.js';
import { safeRollback } from './txUtil.js';
import { isValidName, type FieldDefinition } from './fieldTypes.js';

type Contract = NonNullable<NonNullable<FieldDefinition['options']>['cashflowIntegrity']>;
export interface CashflowRule { relation: FieldDefinition; config: Contract; target: CollectionMeta }

export function hasCashflowOptIn(db: DatabaseSync): boolean {
  return listCollections(db).some(meta => meta.fields.some(field => field.options &&
    Object.prototype.hasOwnProperty.call(field.options, 'cashflowIntegrity')));
}

/**
 * Lock before reading metadata even when no constraint is active yet. Otherwise
 * a schema migration could enable and validate an option after an unguarded
 * writer read the old schema but before that writer inserts its row.
 *
 * A caller's deferred transaction must similarly obtain the writer lock first.
 * If its earlier reads made the snapshot stale, SQLite rejects the upgrade.
 */
let savepointCounter = 0;
export function withCashflowWriteLock<T>(db: DatabaseSync, work: () => T): T {
  // DatabaseSync.isTransaction is absent before Node 22.16. Detect an outer
  // transaction by SQLite's BEGIN error instead; never treat busy/IO errors as
  // evidence of nesting. A savepoint protects each nested operation on failure.
  let nested = false;
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (err) {
    if (!(err instanceof Error) || !/cannot start a transaction within a transaction/i.test(err.message)) throw err;
    nested = true;
  }
  if (nested) {
    const savepoint = `cashflow_write_${++savepointCounter}`;
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
      // Upgrade a caller's deferred transaction before reading metadata. A
      // stale read snapshot fails with SQLITE_BUSY rather than bypassing it.
      db.prepare('UPDATE _collections SET name = name WHERE 0').run();
      const value = work();
      db.exec(`RELEASE ${savepoint}`);
      return value;
    } catch (err) {
      try {
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
      } catch (rollbackError) {
        console.error('[engine] nested cashflow rollback failed:', rollbackError);
      }
      throw err;
    }
  }
  try {
    const value = work();
    db.exec('COMMIT');
    return value;
  } catch (err) {
    return safeRollback(db, err);
  }
}

/** Parse on every write: malformed/corrupt/newer metadata is never ignored. */
export function cashflowRules(db: DatabaseSync, meta: CollectionMeta): CashflowRule[] {
  const rules: CashflowRule[] = [];
  for (const relation of meta.fields) {
    const options = relation.options;
    if (!options || !Object.prototype.hasOwnProperty.call(options, 'cashflowIntegrity')) continue;
    const raw = options.cashflowIntegrity as unknown;
    const fail = (message: string): never => { throw new Error(`Invalid cashflow integrity configuration: ${message}`); };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('expected object');
    const c = raw as Record<string, unknown>;
    const allowed = ['version', 'sourceOwner', 'targetOwner', 'targetMode', 'assetMode', 'tradingMode', 'flowField', 'quantityField', 'valueField', 'immutableModeWhenReferenced'];
    if (Object.keys(c).some(key => !allowed.includes(key))) fail('unknown option');
    if (c.version !== 1) fail('unsupported version');
    if (c.immutableModeWhenReferenced !== undefined && typeof c.immutableModeWhenReferenced !== 'boolean') fail('invalid immutableModeWhenReferenced');
    for (const key of ['sourceOwner', 'targetOwner', 'targetMode', 'flowField', 'quantityField', 'valueField']) {
      if (typeof c[key] !== 'string' || !isValidName(c[key] as string)) fail(`invalid ${key}`);
    }
    if (typeof c.assetMode !== 'string' || !c.assetMode || typeof c.tradingMode !== 'string' || !c.tradingMode || c.assetMode === c.tradingMode) fail('invalid modes');
    if (meta.type !== 'base' || relation.type !== 'relation' || (options.maxSelect !== undefined && options.maxSelect !== 1) || typeof options.collectionId !== 'string' || !isValidName(options.collectionId)) fail('requires a single relation to a named collection');
    if (options.collectionId!.toLowerCase() === meta.name.toLowerCase()) fail('self-target (same collection) is not supported');
    const target = getCollectionByName(db, options.collectionId!);
    if (!target || target.type !== 'base') fail('target collection not found or not a base collection');
    const sourceNames = [relation.name, c.sourceOwner, c.flowField, c.quantityField, c.valueField] as string[];
    if (new Set(sourceNames).size !== sourceNames.length || c.targetOwner === c.targetMode) fail('overlapping fields');
    const sourceField = (key: string) => meta.fields.find(f => f.name === c[key]);
    const targetField = (key: string) => target!.fields.find(f => f.name === c[key]);
    if (sourceField('sourceOwner')?.type !== 'text' || targetField('targetOwner')?.type !== 'text') fail('owners must be text fields');
    if (!['text', 'select'].includes(targetField('targetMode')?.type ?? '') || !['text', 'select'].includes(sourceField('flowField')?.type ?? '')) fail('mode and flow must be text or select');
    if ((targetField('targetMode')?.options?.maxSelect ?? 1) !== 1 || (sourceField('flowField')?.options?.maxSelect ?? 1) !== 1) fail('mode and flow must be single-valued');
    if (sourceField('quantityField')?.type !== 'number' || sourceField('valueField')?.type !== 'number') fail('quantity and value must be numeric');
    rules.push({ relation, config: c as unknown as Contract, target: target! });
  }
  return rules;
}

export function assertCashflowRecord(db: DatabaseSync, rules: CashflowRule[], data: Record<string, unknown>): void {
  for (const { relation, config: c, target } of rules) {
    const id = data[relation.name];
    const sourceOwner = data[c.sourceOwner];
    if (typeof id !== 'string' || !id || typeof sourceOwner !== 'string' || !sourceOwner) throw new Error('Cashflow integrity requires a relation and source owner');
    const row = db.prepare(`SELECT "${c.targetOwner}" AS owner, "${c.targetMode}" AS mode FROM "${target.name}" WHERE id = ?`).get(id) as {owner: unknown; mode: unknown} | undefined;
    if (!row || typeof row.owner !== 'string' || !row.owner || row.owner !== sourceOwner) throw new Error('Cashflow integrity target is missing or owner does not match');
    const flow = data[c.flowField];
    if (row.mode === null || row.mode === c.assetMode) {
      if (flow !== null && flow !== undefined) throw new Error('Cashflow integrity forbids a flow on an asset record');
    } else if (row.mode === c.tradingMode) {
      const quantity = data[c.quantityField];
      const value = data[c.valueField];
      if (quantity !== null && quantity !== undefined) throw new Error('Cashflow integrity requires a null quantity');
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Cashflow integrity requires a finite value');
      if (!((flow === 'deposit' || flow === 'profit') && value > 0) && !((flow === 'withdrawal' || flow === 'loss') && value < 0)) throw new Error('Cashflow integrity requires a valid flow and nonzero signed value');
    } else {
      throw new Error('Cashflow integrity target mode is invalid');
    }
  }
}

export function assertCashflowReparent(_db: DatabaseSync, rules: CashflowRule[], previous: Record<string, unknown>, candidate: Record<string, unknown>): void {
  for (const {config: c} of rules) {
    if (previous[c.sourceOwner] !== candidate[c.sourceOwner]) {
      throw new Error('Cashflow integrity forbids changing a source owner');
    }
  }
}

/** Guard target mutations; historically referenced rows cannot change owner. */
export function assertCashflowTargetUpdate(
  db: DatabaseSync, target: CollectionMeta, id: string,
  previous: Record<string, unknown>, candidate: Record<string, unknown>,
): void {
  for (const source of listCollections(db)) {
    // Corrupt metadata must fail closed for its named target, but cannot
    // change the behavior of unrelated collections.
    if (!source.fields.some(field => field.options &&
      Object.prototype.hasOwnProperty.call(field.options, 'cashflowIntegrity') &&
      field.options.collectionId === target.name)) continue;
    for (const rule of cashflowRules(db, source)) {
      if (rule.target.name !== target.name) continue;
      const c = rule.config;
      const ownerChanged = previous[c.targetOwner] !== candidate[c.targetOwner];
      const oldMode = previous[c.targetMode] ?? c.assetMode;
      const newMode = candidate[c.targetMode] ?? c.assetMode;
      if (!ownerChanged && oldMode === newMode) continue;
      const refs = db.prepare(`SELECT * FROM "${source.name}" WHERE "${rule.relation.name}" = ?`).all(id) as Record<string, unknown>[];
      if (refs.length === 0) continue;
      if (ownerChanged) throw new Error('Cashflow integrity forbids changing a referenced target owner');
      if (c.immutableModeWhenReferenced) throw new Error('Cashflow integrity forbids changing a referenced target mode');
      // Without immutability, a mode change is allowed only when all existing
      // children are valid under the candidate mode.
      for (const row of refs) {
        const flow = row[c.flowField];
        const value = row[c.valueField];
        const quantity = row[c.quantityField];
        if (newMode === c.assetMode && (flow === null || flow === undefined)) continue;
        if (newMode === c.tradingMode && (quantity === null || quantity === undefined) &&
          typeof value === 'number' && Number.isFinite(value) &&
          (((flow === 'deposit' || flow === 'profit') && value > 0) ||
           ((flow === 'withdrawal' || flow === 'loss') && value < 0))) continue;
        throw new Error('Cashflow integrity target mode change would invalidate a referenced row');
      }
    }
  }
}

export function assertCashflowOptionsPreserved(before: FieldDefinition[], after: FieldDefinition[]): void {
  for (const field of before) {
    if (!field.options || !Object.prototype.hasOwnProperty.call(field.options, 'cashflowIntegrity')) continue;
    const replacement = after.find(next => next.name === field.name);
    if (!replacement?.options || !Object.prototype.hasOwnProperty.call(replacement.options, 'cashflowIntegrity') ||
        !isDeepStrictEqual(replacement.options.cashflowIntegrity, field.options.cashflowIntegrity) ||
        replacement.type !== field.type || replacement.options.collectionId !== field.options.collectionId) {
      throw new Error('Cashflow integrity option cannot be removed or changed by schema edit');
    }
  }
}

/** Validate affected constrained sources after metadata changes in a transaction. */
export function assertCashflowDataAffectedBy(db: DatabaseSync, collection: string): void {
  for (const meta of listCollections(db)) {
    // Ignore unrelated constraints, including unknown future versions. Schema
    // edits to either a source or its declared target still fail closed.
    if (!meta.fields.some(field => field.options &&
        Object.prototype.hasOwnProperty.call(field.options, 'cashflowIntegrity') &&
        (meta.name === collection || field.options.collectionId === collection))) continue;
    const rules = cashflowRules(db, meta);
    if (rules.length === 0) continue;
    for (const row of db.prepare(`SELECT * FROM "${meta.name}"`).all() as Record<string, unknown>[]) {
      assertCashflowRecord(db, rules, row);
    }
  }
}