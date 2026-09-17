// ============================================================================
// M16c: IMPORT/EXPORT JSON — collection sebagai JSON portabel
//
// Export: seluruh collection (meta + records) → satu JSON:
// {
//   "format": "baseforge-collection",
//   "version": 1,
//   "collection": { name, fields, indexes, rules, type, viewQuery },
//   "records": [ { ...row serialized }, ... ]
// }
//
// Import (mode):
//   - "create" (default): buat collection baru; gagal kalau nama sudah ada
//   - "replace": DROP collection lama (jika ada) → import bersih
//   - "merge": pakai collection lama; record di-upsert by id
//
// Kenapa format self-describing? Import antar project/instance jadi
// trivial: export dari project A → import ke project B tanpa konversi.
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import {
  getCollectionByName,
  defineCollection,
  deleteCollection,
  CollectionMeta,
  CollectionDefinition,
} from './schema.js';
import { filterToSql } from './query/sqlBuilder.js';

const EXPORT_FORMAT = 'baseforge-collection';
const EXPORT_VERSION = 1;

// ─── EXPORT ──────────────────────────────────────────────────────────────────

export function exportCollection(db: DatabaseSync, name: string): string {
  const meta = getCollectionByName(db, name);
  if (!meta) {
    throw new Error(`Collection '${name}' not found`);
  }

  let records: Record<string, unknown>[] = [];
  if (meta.type === 'base') {
    rows: for (const row of db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[]) {
      records.push(row);
    }
  }
  // view: records kosong (tidak punya data fisik — query dieksekusi ulang saat import)

  return JSON.stringify({
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    collection: {
      name: meta.name,
      fields: meta.fields,
      indexes: meta.indexes,
      rules: meta.rules,
      type: meta.type,
      viewQuery: meta.viewQuery,
    },
    records,
  });
}

// ─── IMPORT ──────────────────────────────────────────────────────────────────

export interface ImportOptions {
  mode?: 'create' | 'replace' | 'merge';
}

export interface ImportResult {
  collection: CollectionMeta;
  importedRecords: number;
  skippedRecords: number;
  mode: string;
}

export function importCollection(
  db: DatabaseSync,
  json: string,
  options: ImportOptions = {}
): ImportResult {
  // ── Parse & validasi format ──
  let data: {
    format?: string;
    version?: number;
    collection?: {
      name?: string;
      fields?: CollectionDefinition['fields'];
      indexes?: CollectionDefinition['indexes'];
      rules?: Partial<CollectionMeta['rules']>;
      type?: string;
      viewQuery?: string | null;
    };
    records?: Record<string, unknown>[];
  };
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (data.format !== EXPORT_FORMAT) {
    throw new Error(`Unknown format: '${data.format}' (expected '${EXPORT_FORMAT}')`);
  }
  if (!data.collection?.name || !Array.isArray(data.collection.fields)) {
    throw new Error('Incomplete import data: collection.name & collection.fields are required');
  }

  const mode = options.mode ?? 'create';
  const name = data.collection.name;
  const existing = getCollectionByName(db, name);

  // ── Mode create: tolak kalau sudah ada ──
  if (mode === 'create' && existing) {
    throw new Error(`Collection '${name}' sudah ada (gunakan mode 'replace' atau 'merge')`);
  }

  // ── Mode replace: hapus lama dulu ──
  if (mode === 'replace' && existing) {
    deleteCollection(db, name);
  }

  // ── Buat collection jika belum ada (setelah replace / mode create / merge baru) ──
  let meta: CollectionMeta;
  const current = getCollectionByName(db, name);
  if (!current) {
    if (data.collection.type === 'view') {
      if (!data.collection.viewQuery) {
        throw new Error('View collection requires viewQuery');
      }
      meta = importView(db, name, data.collection.viewQuery, data.collection.rules);
    } else {
      meta = defineCollection(db, {
        name,
        fields: data.collection.fields,
        indexes: data.collection.indexes ?? [],
        rules: data.collection.rules,
      });
    }
  } else {
    meta = current;
  }

  // ── Import records (base only) ──
  let imported = 0;
  let skipped = 0;
  if (meta.type === 'base' && Array.isArray(data.records)) {
    const fieldMap = new Map(meta.fields.map((f) => [f.name, f]));
    const insertSql = buildUpsertSql(name, meta);

    for (const rec of data.records) {
      try {
        const { columns, params } = serializeImportRecord(rec, fieldMap, meta);
        db.prepare(insertSql.replace('%COLUMNS%', columns.join(', ')).replace('%PLACEHOLDERS%', placeholders(columns.length))).run(
          ...(params as never[])
        );
        imported++;
      } catch {
        skipped++; // record bermasalah (validasi/unique) — lanjut sisanya
      }
    }
  }

  return {
    collection: getCollectionByName(db, name)!,
    importedRecords: imported,
    skippedRecords: skipped,
    mode,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function importView(
  db: DatabaseSync,
  name: string,
  viewQuery: string,
  rules?: Partial<CollectionMeta['rules']>
): CollectionMeta {
  // Re-use createViewCollection via dynamic import terhindar — panggil fungsi
  // dari schema langsung (sudah di-import).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return createViewCollectionForImport(db, name, viewQuery, rules);
}

// createViewCollection di schema.ts dipakai langsung (import di atas)
import { createViewCollection } from './schema.js';
function createViewCollectionForImport(
  db: DatabaseSync,
  name: string,
  viewQuery: string,
  rules?: Partial<CollectionMeta['rules']>
): CollectionMeta {
  return createViewCollection(db, { name, viewQuery, rules });
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

function buildUpsertSql(name: string, meta: CollectionMeta): string {
  // Upsert by id (INSERT OR REPLACE — record dengan id sama ditimpa)
  return `INSERT OR REPLACE INTO "${name}" (%COLUMNS%) VALUES (%PLACEHOLDERS%)`;
}

function serializeImportRecord(
  rec: Record<string, unknown>,
  fieldMap: Map<string, import('./fieldTypes.js').FieldDefinition>,
  meta: CollectionMeta
): { columns: string[]; params: unknown[] } {
  // Kolom: id + field yang ada di meta (abaikan field asing — tidak crash)
  const columns = ['id'];
  const params: unknown[] = [String(rec.id ?? generateIdForImport())];

  for (const [key, value] of Object.entries(rec)) {
    if (key === 'id') continue;
    const field = fieldMap.get(key);
    if (!field) continue; // field asing → skip (skema menang)
    columns.push(`"${key}"`);
    // Serialize sesuai tipe (duplikasi ringan dari records.serializeValue
    // — untuk import, nilai dari export kita sendiri sudah bentuk DB)
    params.push(serializeImportValue(field.type, value));
  }

  return { columns, params };
}

function generateIdForImport(): string {
  // id ringan untuk record tanpa id (alphabet sama generateId router)
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 15; i++) {
    id += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return id;
}

function serializeImportValue(type: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'bool':
      return value === true || value === 1 ? 1 : 0;
    case 'json':
    case 'geoPoint':
      return typeof value === 'string' ? value : JSON.stringify(value);
    case 'relation':
    case 'file': {
      const isMulti = true; // diserahkan ke skema; array → JSON string
      if (Array.isArray(value)) return JSON.stringify(value);
      return value;
    }
    case 'password':
      // Password dari export sudah berupa hash (plain tidak pernah di-export
      // karena deserialize menghapusnya) — simpan apa adanya
      return typeof value === 'string' ? value : null;
    default:
      return value;
  }
}

// ─── Helper: query builder re-export untuk filter opsional (tidak dipakai
// di import path sekarang, tapi menjaga API siap untuk import dengan filter)
export { filterToSql };
