// ============================================================================
// M43: MODULE REGISTRY — kode bersama untuk functions ($lib)
//
// Mengapa modul ini ada: function BaseForge adalah satu string kode tanpa
// import/require (sandbox sengaja tertutup). Logika domain yang dipakai banyak
// function (mis. WekanzDashboard shared/domain.ts, 386 baris, di-import 7
// function) harus disalin ke setiap function — satu perbaikan bug disalin 7×.
// Registry ini memisahkan kode bersama ke tabel `_function_modules` dan
// menyuntikkannya ke sandbox sebagai `$lib.<name>`.
//
// MEKANISME: setiap modul dikompilasi TS→CJS (typescript.transpileModule —
// dependensi yang SUDAH ada di server, bukan dependensi baru) lalu dibungkus
// factory IIFE gaya CommonJS:
//
//   $lib['domain'] = (function(module, exports) {
//     /* kode modul — boleh exports.x / module.exports */
//   })({ exports: {} }, {}).exports;
//
// Urutan eval = urutan array `modules` function → dependensi antar-modul
// deterministik (modul awal bisa dipakai modul berikutnya lewat $lib).
//
// KEAMANAN: modul berjalan di isolate yang SAMA dengan function — mewarisi
// batas memori/timeout function dan (seperti function) tanpa akses host.
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import ts from 'typescript';

// ─── Batas ───────────────────────────────────────────────────────────────────

export const MAX_MODULES_PER_FUNCTION = 10;
export const MAX_MODULE_CODE_BYTES = 256 * 1024; // 256 KB per modul
export const MODULE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export interface ModuleMeta {
  name: string;
  sizeBytes: number;
  updated: string;
}

export interface StoredModule {
  name: string;
  code: string;
  created: string;
  updated: string;
}

export class ModuleRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleRegistryError';
  }
}

// ─── Tabel (per project DB, idempotent) ──────────────────────────────────────

export function initModulesTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _function_modules (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      code TEXT NOT NULL,
      created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
}

// ─── Validasi ────────────────────────────────────────────────────────────────

export function isValidModuleName(name: string): boolean {
  return MODULE_NAME_PATTERN.test(name);
}

function validateCode(code: string): void {
  if (typeof code !== 'string' || code.trim() === '') {
    throw new ModuleRegistryError('Module code is required');
  }
  if (Buffer.byteLength(code, 'utf8') > MAX_MODULE_CODE_BYTES) {
    throw new ModuleRegistryError(
      `Module code exceeds ${MAX_MODULE_CODE_BYTES / 1024} KB`
    );
  }
}

// ─── Kompilasi TS → CJS ──────────────────────────────────────────────────────

/**
 * Strip tipe TypeScript dan normalisasi `export` menjadi `exports.*`.
 * Memakai `typescript` yang sudah menjadi dependensi server — BUKAN bundler
 * baru. Pada JS murni, ini pass-through + normalisasi export.
 * Lempar ModuleRegistryError bila ada error sintaks (diagnostic).
 */
export function compileModuleCode(name: string, code: string): string {
  const out = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      // Hapus helper __exportStar dkk bila ada — modul kita flat exports
      importHelpers: false,
      esModuleInterop: false,
    },
    reportDiagnostics: true,
    fileName: `${name}.ts`,
  });
  const errors = (out.diagnostics ?? []).filter(
    (d) => d.category === ts.DiagnosticCategory.Error
  );
  if (errors.length > 0) {
    const first = errors[0];
    const msg = ts.flattenDiagnosticMessageText(first.messageText, ' ');
    throw new ModuleRegistryError(`Module '${name}' has a syntax error: ${msg}`);
  }
  return out.outputText;
}

// ─── Penyusunan prelude modul ────────────────────────────────────────────────

/**
 * Bangun potongan JS yang, bila dieval di dalam isolate, mengisi
 * `$lib[<name>]` dengan ekspor tiap modul (urutan array dipertahankan).
 * Dipanggil functionRunner SEKALI per eksekusi dari daftar nama modul.
 * Modul yang tidak ditemukan dilempar sebagai error kompilasi yang jelas.
 */
export function buildModulesPrelude(db: DatabaseSync, names: string[]): string {
  initModulesTable(db);
  if (names.length === 0) return '';
  if (names.length > MAX_MODULES_PER_FUNCTION) {
    throw new ModuleRegistryError(
      `A function may load at most ${MAX_MODULES_PER_FUNCTION} modules`
    );
  }

  const chunks: string[] = [];
  for (const name of names) {
    const mod = getModule(db, name);
    if (!mod) {
      throw new ModuleRegistryError(`Module '${name}' not found in this project`);
    }
    const compiled = compileModuleCode(name, mod.code);
    // Factory IIFE gaya CJS yang BENAR: `module.exports` dan `exports` harus
    // menunjuk objek YANG SAMA — kalau exports diberi objek baru terpisah,
    // `exports.x = ...` menempel di objek yang dibuang dan .exports kosong.
    // Pola: buat satu objek exports, rujuk lewat keduanya, baca module.exports.
    chunks.push(
      `$lib[${JSON.stringify(name)}] = (function() {\n` +
        `var module = { exports: {} };\n` +
        `var exports = module.exports;\n` +
        `(function(module, exports) {\n${compiled}\n})(module, exports);\n` +
        `return module.exports;\n` +
        `})();\n`
    );
  }
  return chunks.join('\n');
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

/** Set (upsert) satu modul. */
export function setModule(db: DatabaseSync, name: string, code: string): void {
  if (!isValidModuleName(name)) {
    throw new ModuleRegistryError(
      `Invalid module name '${String(name)}' (must match ${MODULE_NAME_PATTERN})`
    );
  }
  validateCode(code);
  // Kompilasi dulu untuk menangkap error sintaks SEJAK disimpan, bukan saat run.
  compileModuleCode(name, code);
  initModulesTable(db);
  db.prepare(
    `INSERT INTO _function_modules (id, name, code)
     VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       code = excluded.code,
       updated = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(crypto.randomUUID(), name, code);
}

/** Satu modul (dengan kode) atau undefined. */
export function getModule(db: DatabaseSync, name: string): StoredModule | undefined {
  initModulesTable(db);
  const row = db
    .prepare('SELECT name, code, created, updated FROM _function_modules WHERE name = ?')
    .get(name) as unknown as StoredModule | undefined;
  return row;
}

/** Metadata semua modul — TANPA kode (untuk listing). */
export function listModules(db: DatabaseSync): ModuleMeta[] {
  initModulesTable(db);
  const rows = db
    .prepare('SELECT name, code, updated FROM _function_modules ORDER BY name ASC')
    .all() as unknown as { name: string; code: string; updated: string }[];
  return rows.map((r) => ({
    name: r.name,
    sizeBytes: Buffer.byteLength(r.code, 'utf8'),
    updated: r.updated,
  }));
}

/** Hapus satu modul. Return true jika ada yang terhapus. */
export function deleteModule(db: DatabaseSync, name: string): boolean {
  initModulesTable(db);
  const res = db.prepare('DELETE FROM _function_modules WHERE name = ?').run(name);
  return res.changes > 0;
}
