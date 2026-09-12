// ============================================================================
// M15a: FUNCTIONS STORE — kode function sebagai DATA (schema-as-data lagi!)
//
// Tabel _functions per project (di database project, bukan platform):
//   id, name (unique), code, enabled, timeout_ms, created, updated
//
// Kenapa di DB project? Function milik project — ikut backup (B2!),
// ikut terhapus saat project dihapus. Konsisten dengan filosofi
// "satu file SQLite = satu project lengkap" ala PocketBase.
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import { generateId } from './router.js';

export interface FunctionTrigger {
  collection: string; // nama collection yang dipantau
  actions: ('create' | 'update' | 'delete')[]; // aksi yang memicu
}

export interface StoredFunction {
  id: string;
  name: string;
  code: string;
  enabled: boolean;
  timeoutMs: number;
  triggers: FunctionTrigger[]; // M15b: kosong = hanya callable
  created: string;
  updated: string;
}

interface FunctionRow {
  id: string;
  name: string;
  code: string;
  enabled: number;
  timeout_ms: number;
  triggers: string | null; // JSON string — M15b
  created: string;
  updated: string;
}

// ─── Validasi nama (sama ketat dengan collection) ────────────────────────────

export function isValidFunctionName(name: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(name) && name.length <= 64;
}

// ─── Init tabel (idempotent) ─────────────────────────────────────────────────

export function initFunctionsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _functions (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      code TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      timeout_ms INTEGER NOT NULL DEFAULT 2000,
      created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);

  // M15b: kolom triggers (JSON array of { collection, actions })
  const cols = db.prepare(`PRAGMA table_info(_functions)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'triggers')) {
    db.exec(`ALTER TABLE _functions ADD COLUMN triggers TEXT NOT NULL DEFAULT '[]'`);
  }
}

function rowToFunction(row: FunctionRow): StoredFunction {
  let triggers: FunctionTrigger[] = [];
  try {
    const parsed = JSON.parse(row.triggers ?? '[]');
    if (Array.isArray(parsed)) triggers = parsed;
  } catch {
    triggers = [];
  }
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    enabled: row.enabled === 1,
    timeoutMs: row.timeout_ms,
    triggers,
    created: row.created,
    updated: row.updated,
  };
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export function createFunction(
  db: DatabaseSync,
  def: { name: string; code: string; enabled?: boolean; timeoutMs?: number; triggers?: FunctionTrigger[] }
): StoredFunction {
  if (!isValidFunctionName(def.name)) {
    throw new Error(
      `Invalid function name: '${def.name}' (hanya a-z, 0-9, _, diawali huruf, max 64)`
    );
  }
  if (typeof def.code !== 'string' || def.code.trim() === '') {
    throw new Error('Function code wajib diisi');
  }
  if (def.code.length > 100_000) {
    throw new Error('Function code terlalu besar (max 100KB)');
  }

  const timeoutMs = def.timeoutMs ?? 2000;
  if (timeoutMs < 100 || timeoutMs > 30_000) {
    throw new Error('timeoutMs harus antara 100 dan 30000 ms');
  }

  const triggers = validateTriggers(def.triggers ?? []);

  const existing = getFunctionByName(db, def.name);
  if (existing) {
    throw new Error(`Function '${def.name}' already exists`);
  }

  const id = generateId();
  db.prepare(
    `INSERT INTO _functions (id, name, code, enabled, timeout_ms, triggers) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, def.name, def.code, def.enabled === false ? 0 : 1, timeoutMs, JSON.stringify(triggers));

  return getFunctionByName(db, def.name)!;
}

// M15b: validasi spec trigger — collection harus ada, actions harus valid
function validateTriggers(
  triggers: FunctionTrigger[],
  validCollections?: Set<string>
): FunctionTrigger[] {
  const validActions = new Set(['create', 'update', 'delete']);
  for (const t of triggers) {
    if (!t || typeof t.collection !== 'string' || t.collection.trim() === '') {
      throw new Error('Trigger butuh collection yang valid');
    }
    if (validCollections && !validCollections.has(t.collection)) {
      throw new Error(`Trigger collection '${t.collection}' tidak ada di project ini`);
    }
    if (!Array.isArray(t.actions) || t.actions.length === 0) {
      throw new Error(`Trigger '${t.collection}' butuh minimal 1 action (create/update/delete)`);
    }
    for (const a of t.actions) {
      if (!validActions.has(a)) {
        throw new Error(`Action '${String(a)}' tidak valid (hanya create/update/delete)`);
      }
    }
  }
  return triggers;
}

export function listFunctions(db: DatabaseSync): StoredFunction[] {
  initFunctionsTable(db);
  const rows = db.prepare('SELECT * FROM _functions ORDER BY created ASC').all() as unknown as FunctionRow[];
  return rows.map(rowToFunction);
}

export function getFunctionByName(db: DatabaseSync, name: string): StoredFunction | undefined {
  initFunctionsTable(db);
  const row = db.prepare('SELECT * FROM _functions WHERE name = ?').get(name) as unknown as FunctionRow | undefined;
  return row ? rowToFunction(row) : undefined;
}

export function updateFunction(
  db: DatabaseSync,
  name: string,
  updates: { code?: string; enabled?: boolean; timeoutMs?: number; triggers?: FunctionTrigger[] }
): StoredFunction | undefined {
  const existing = getFunctionByName(db, name);
  if (!existing) return undefined;

  if (updates.code !== undefined) {
    if (typeof updates.code !== 'string' || updates.code.trim() === '') {
      throw new Error('Function code wajib diisi');
    }
    if (updates.code.length > 100_000) throw new Error('Function code terlalu besar (max 100KB)');
  }
  if (updates.timeoutMs !== undefined && (updates.timeoutMs < 100 || updates.timeoutMs > 30_000)) {
    throw new Error('timeoutMs harus antara 100 dan 30000 ms');
  }
  let triggersJson: string | null = null;
  if (updates.triggers !== undefined) {
    triggersJson = JSON.stringify(validateTriggers(updates.triggers));
  }

  db.prepare(
    `UPDATE _functions SET
       code = COALESCE(?, code),
       enabled = COALESCE(?, enabled),
       timeout_ms = COALESCE(?, timeout_ms),
       triggers = COALESCE(?, triggers),
       updated = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE name = ?`
  ).run(
    updates.code ?? null,
    updates.enabled === undefined ? null : updates.enabled ? 1 : 0,
    updates.timeoutMs ?? null,
    triggersJson,
    name
  );

  return getFunctionByName(db, name);
}

export function deleteFunction(db: DatabaseSync, name: string): boolean {
  initFunctionsTable(db);
  const result = db.prepare('DELETE FROM _functions WHERE name = ?').run(name);
  return result.changes > 0;
}
