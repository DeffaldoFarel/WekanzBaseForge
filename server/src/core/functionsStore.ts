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
import { parseCron, validateTimezone } from './cronParser.js';

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
  schedule: string | null; // M15c: cron expression (null = bukan scheduled)
  httpAllow: string[]; // M25: allowlist host utk $http (kosong = $http off)
  timezone: string; // M39: IANA timezone utk schedule (default "UTC")
  dbAccess: boolean; // M41: izin akses $db in-process (default false = off)
  modules: string[]; // M43: nama modul $lib yang di-load (urutan = urutan eval)
  memoryMb: number; // M44: plafon memori isolate (16–256 MB, default 32)
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
  schedule: string | null; // M15c
  http_allow: string | null; // JSON string — M25
  timezone: string | null; // M39
  db_access: number | null; // M41 (0/1)
  modules: string | null; // M43: JSON array nama modul
  memory_mb: number | null; // M44
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

  // M15c: kolom schedule (cron expression, nullable)
  if (!cols.some((c) => c.name === 'schedule')) {
    db.exec(`ALTER TABLE _functions ADD COLUMN schedule TEXT`);
  }

  // M25: kolom http_allow (JSON array hostname allowlist)
  if (!cols.some((c) => c.name === 'http_allow')) {
    db.exec(`ALTER TABLE _functions ADD COLUMN http_allow TEXT NOT NULL DEFAULT '[]'`);
  }

  // M39: kolom timezone (IANA name, default "UTC")
  if (!cols.some((c) => c.name === 'timezone')) {
    db.exec(`ALTER TABLE _functions ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'`);
  }

  // M41: kolom db_access (0/1) — default 0 supaya function lama tidak berubah
  if (!cols.some((c) => c.name === 'db_access')) {
    db.exec(`ALTER TABLE _functions ADD COLUMN db_access INTEGER NOT NULL DEFAULT 0`);
  }

  // M43: kolom modules (JSON array nama modul $lib)
  if (!cols.some((c) => c.name === 'modules')) {
    db.exec(`ALTER TABLE _functions ADD COLUMN modules TEXT NOT NULL DEFAULT '[]'`);
  }

  // M44: kolom memory_mb (16–256, default 32)
  if (!cols.some((c) => c.name === 'memory_mb')) {
    db.exec(`ALTER TABLE _functions ADD COLUMN memory_mb INTEGER NOT NULL DEFAULT 32`);
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
  let httpAllow: string[] = [];
  try {
    const parsed = JSON.parse(row.http_allow ?? '[]');
    if (Array.isArray(parsed)) httpAllow = parsed.filter((h) => typeof h === 'string');
  } catch {
    httpAllow = [];
  }
  let modules: string[] = [];
  try {
    const parsed = JSON.parse(row.modules ?? '[]');
    if (Array.isArray(parsed)) modules = parsed.filter((m) => typeof m === 'string');
  } catch {
    modules = [];
  }
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    enabled: row.enabled === 1,
    timeoutMs: row.timeout_ms,
    triggers,
    schedule: row.schedule ?? null,
    httpAllow,
    timezone: row.timezone ?? 'UTC',
    dbAccess: row.db_access === 1,
    modules,
    memoryMb: row.memory_mb ?? 32,
    created: row.created,
    updated: row.updated,
  };
}

// M25: validasi allowlist — '*' (semua host publik) atau daftar hostname.
// Entry literal (tanpa wildcard) = opt-in eksplisit, termasuk host privat.
function validateHttpAllow(list: string[] | undefined | null): string[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    throw new Error('httpAllow must be an array of hostnames');
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new Error('httpAllow entries must be non-empty strings');
    }
    const entry = raw.trim().toLowerCase();
    if (entry.length > 253) {
      throw new Error(`httpAllow entry too long: '${entry}'`);
    }
    // host: `*` | `*.domain.tld` | `domain.tld` | `sub.domain.tld` | IP
    const pattern = entry === '*' ? true : /^\*?[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(entry);
    if (!pattern) {
      throw new Error(`Invalid httpAllow entry: '${entry}' (expected hostname, '*.hostname', or '*')`);
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      out.push(entry);
    }
  }
  return out;
}

// M43: validasi daftar nama modul — harus array string nama valid
function validateModules(list: string[] | undefined | null): string[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    throw new Error('modules must be an array of module names');
  }
  if (list.length > 10) {
    throw new Error('A function may load at most 10 modules');
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(raw)) {
      throw new Error(`Invalid module name in modules: '${String(raw)}'`);
    }
    if (!seen.has(raw)) {
      seen.add(raw);
      out.push(raw);
    }
  }
  return out;
}

// M44: plafon timeout dinaikkan 30s → 120s (default tetap 2000ms). BaseForge
// berbagi SATU event loop, jadi plafon lebih ketat dari Appwrite (~15 mnt)
// memang disengaja — satu function macet menahan semua request.
export const MAX_FUNCTION_TIMEOUT_MS = 120_000;
// M44: plafon memori isolate (16–256 MB). 256 MB = plafon Supabase Edge;
// di atas itu function harus dipecah, bukan diberi heap lebih besar.
export const MIN_FUNCTION_MEMORY_MB = 16;
export const MAX_FUNCTION_MEMORY_MB = 256;

// M44: validasi memory_mb
function validateMemoryMb(value: number | undefined | null): number {
  if (value === undefined || value === null) return 32;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error('memoryMb must be an integer (MB)');
  }
  if (value < MIN_FUNCTION_MEMORY_MB || value > MAX_FUNCTION_MEMORY_MB) {
    throw new Error(
      `memoryMb must be between ${MIN_FUNCTION_MEMORY_MB} and ${MAX_FUNCTION_MEMORY_MB} MB`
    );
  }
  return value;
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export function createFunction(
  db: DatabaseSync,
  def: { name: string; code: string; enabled?: boolean; timeoutMs?: number; triggers?: FunctionTrigger[]; schedule?: string | null; httpAllow?: string[]; timezone?: string; dbAccess?: boolean; modules?: string[]; memoryMb?: number }
): StoredFunction {
  if (!isValidFunctionName(def.name)) {
    throw new Error(
      `Invalid function name: '${def.name}' (only a-z, 0-9, _, must start with a letter, max 64)`
    );
  }
  if (typeof def.code !== 'string' || def.code.trim() === '') {
    throw new Error('Function code is required');
  }
  if (def.code.length > 100_000) {
    throw new Error('Function code is too large (max 100KB)');
  }

  const timeoutMs = def.timeoutMs ?? 2000;
  if (timeoutMs < 100 || timeoutMs > MAX_FUNCTION_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be between 100 and ${MAX_FUNCTION_TIMEOUT_MS} ms`);
  }
  const memoryMb = validateMemoryMb(def.memoryMb);

  const triggers = validateTriggers(def.triggers ?? []);
  const httpAllow = validateHttpAllow(def.httpAllow ?? []);
  const modules = validateModules(def.modules ?? []);

  // M15c: validasi schedule (cron) — invalid ditolak di pintu
  let schedule: string | null = null;
  if (def.schedule !== undefined && def.schedule !== null) {
    if (typeof def.schedule !== 'string' || def.schedule.trim() === '') {
      schedule = null;
    } else {
      parseCron(def.schedule); // lempar kalau invalid
      schedule = def.schedule.trim();
    }
  }

  // M39: validasi timezone (IANA) — default UTC
  const timezone = def.timezone?.trim() || 'UTC';
  validateTimezone(timezone); // lempar kalau invalid

  const existing = getFunctionByName(db, def.name);
  if (existing) {
    throw new Error(`Function '${def.name}' already exists`);
  }

  const id = generateId();
  db.prepare(
    `INSERT INTO _functions (id, name, code, enabled, timeout_ms, triggers, schedule, http_allow, timezone, db_access, modules, memory_mb) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, def.name, def.code, def.enabled === false ? 0 : 1, timeoutMs, JSON.stringify(triggers), schedule, JSON.stringify(httpAllow), timezone, def.dbAccess === true ? 1 : 0, JSON.stringify(modules), memoryMb);

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
      throw new Error('Trigger requires a valid collection');
    }
    if (validCollections && !validCollections.has(t.collection)) {
      throw new Error(`Trigger collection '${t.collection}' does not exist in this project`);
    }
    if (!Array.isArray(t.actions) || t.actions.length === 0) {
      throw new Error(`Trigger '${t.collection}' requires at least 1 action (create/update/delete)`);
    }
    for (const a of t.actions) {
      if (!validActions.has(a)) {
        throw new Error(`Action '${String(a)}' is not valid (only create/update/delete)`);
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
  updates: { code?: string; enabled?: boolean; timeoutMs?: number; triggers?: FunctionTrigger[]; schedule?: string | null; httpAllow?: string[]; timezone?: string; dbAccess?: boolean; modules?: string[]; memoryMb?: number }
): StoredFunction | undefined {
  const existing = getFunctionByName(db, name);
  if (!existing) return undefined;

  if (updates.code !== undefined) {
    if (typeof updates.code !== 'string' || updates.code.trim() === '') {
      throw new Error('Function code is required');
    }
    if (updates.code.length > 100_000) throw new Error('Function code is too large (max 100KB)');
  }
  if (updates.timeoutMs !== undefined && (updates.timeoutMs < 100 || updates.timeoutMs > MAX_FUNCTION_TIMEOUT_MS)) {
    throw new Error(`timeoutMs must be between 100 and ${MAX_FUNCTION_TIMEOUT_MS} ms`);
  }
  // M44: memory_mb — integer valid / tidak disentuh
  let memoryMbValue: number | null = null;
  if (updates.memoryMb !== undefined) {
    memoryMbValue = validateMemoryMb(updates.memoryMb);
  }
  let triggersJson: string | null = null;
  if (updates.triggers !== undefined) {
    triggersJson = JSON.stringify(validateTriggers(updates.triggers));
  }
  // M25: httpAllow — array valid / kosong
  let httpAllowJson: string | null = null;
  if (updates.httpAllow !== undefined) {
    httpAllowJson = JSON.stringify(validateHttpAllow(updates.httpAllow));
  }
  // M43: modules — array valid / kosong
  let modulesJson: string | null = null;
  if (updates.modules !== undefined) {
    modulesJson = JSON.stringify(validateModules(updates.modules));
  }
  // M15c: schedule — string valid / null (hapus schedule)
  let scheduleValue: string | null | undefined;
  if (updates.schedule !== undefined) {
    if (updates.schedule === null || (typeof updates.schedule === 'string' && updates.schedule.trim() === '')) {
      scheduleValue = null;
    } else {
      parseCron(updates.schedule); // lempar kalau invalid
      scheduleValue = updates.schedule.trim();
    }
  }

  // M39: timezone — valid IANA name (null = tidak diubah)
  let timezoneValue: string | null | undefined;
  if (updates.timezone !== undefined) {
    const tz = updates.timezone?.trim() || 'UTC';
    validateTimezone(tz);
    timezoneValue = tz;
  }

  db.prepare(
    `UPDATE _functions SET
       code = COALESCE(?, code),
       enabled = COALESCE(?, enabled),
       timeout_ms = COALESCE(?, timeout_ms),
       triggers = COALESCE(?, triggers),
       schedule = ?,
       http_allow = COALESCE(?, http_allow),
       timezone = COALESCE(?, timezone),
       db_access = COALESCE(?, db_access),
       modules = COALESCE(?, modules),
       memory_mb = COALESCE(?, memory_mb),
       updated = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE name = ?`
  ).run(
    updates.code ?? null,
    updates.enabled === undefined ? null : updates.enabled ? 1 : 0,
    updates.timeoutMs ?? null,
    triggersJson,
    scheduleValue !== undefined ? scheduleValue : existing.schedule, // undefined = tidak disentuh
    httpAllowJson,
    timezoneValue ?? null,
    updates.dbAccess === undefined ? null : updates.dbAccess ? 1 : 0,
    modulesJson,
    memoryMbValue,
    name
  );

  return getFunctionByName(db, name);
}

export function deleteFunction(db: DatabaseSync, name: string): boolean {
  initFunctionsTable(db);
  const result = db.prepare('DELETE FROM _functions WHERE name = ?').run(name);
  return result.changes > 0;
}
