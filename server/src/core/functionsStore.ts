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

export interface StoredFunction {
  id: string;
  name: string;
  code: string;
  enabled: boolean;
  timeoutMs: number;
  created: string;
  updated: string;
}

interface FunctionRow {
  id: string;
  name: string;
  code: string;
  enabled: number;
  timeout_ms: number;
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
}

function rowToFunction(row: FunctionRow): StoredFunction {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    enabled: row.enabled === 1,
    timeoutMs: row.timeout_ms,
    created: row.created,
    updated: row.updated,
  };
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export function createFunction(
  db: DatabaseSync,
  def: { name: string; code: string; enabled?: boolean; timeoutMs?: number }
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

  const existing = getFunctionByName(db, def.name);
  if (existing) {
    throw new Error(`Function '${def.name}' already exists`);
  }

  const id = generateId();
  db.prepare(
    `INSERT INTO _functions (id, name, code, enabled, timeout_ms) VALUES (?, ?, ?, ?, ?)`
  ).run(id, def.name, def.code, def.enabled === false ? 0 : 1, timeoutMs);

  return getFunctionByName(db, def.name)!;
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
  updates: { code?: string; enabled?: boolean; timeoutMs?: number }
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

  db.prepare(
    `UPDATE _functions SET
       code = COALESCE(?, code),
       enabled = COALESCE(?, enabled),
       timeout_ms = COALESCE(?, timeout_ms),
       updated = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE name = ?`
  ).run(
    updates.code ?? null,
    updates.enabled === undefined ? null : updates.enabled ? 1 : 0,
    updates.timeoutMs ?? null,
    name
  );

  return getFunctionByName(db, name);
}

export function deleteFunction(db: DatabaseSync, name: string): boolean {
  initFunctionsTable(db);
  const result = db.prepare('DELETE FROM _functions WHERE name = ?').run(name);
  return result.changes > 0;
}
