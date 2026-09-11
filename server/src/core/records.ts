// ============================================================================
// M05: RECORD API — CRUD generik untuk SEMUA collection
//
// Di sinilah M03 (skema) dan M04 (query parser) bertemu:
//   - Skema memberi tahu kita field apa yang valid & tipenya
//   - Query parser menerjemahkan filter string → SQL
//   - File ini merangkainya menjadi CRUD yang bekerja untuk collection APAPUN
//
// Tidak ada satu pun nama collection/field yang di-hardcode di sini.
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import { generateId } from './router.js';
import { getCollectionByName, CollectionMeta } from './schema.js';
import { FieldDefinition, validateValue } from './fieldTypes.js';
import { filterToSql } from './query/sqlBuilder.js';

// ─── Tipe ────────────────────────────────────────────────────────────────────

export type ForgeRecord = { id: string; created: string; updated: string } & {
  [key: string]: unknown;
};

export interface ListOptions {
  filter?: string;
  sort?: string; // '-streak,+created' → DESC, ASC
  page?: number;
  perPage?: number;
}

export interface ListResult {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: ForgeRecord[];
}

// ─── Helper: ambil skema collection (gagal jelas kalau tidak ada) ────────────

function mustGetCollection(db: DatabaseSync, name: string): CollectionMeta {
  const meta = getCollectionByName(db, name);
  if (!meta) {
    throw new Error(`Collection '${name}' tidak ditemukan`);
  }
  return meta;
}

function fieldMap(meta: CollectionMeta): Map<string, FieldDefinition> {
  return new Map(meta.fields.map((f) => [f.name, f]));
}

// ─── D1: Error translator — error mesin → pesan ramah untuk produksi ────────
// SQLite melempar error mentah seperti:
//   "UNIQUE constraint failed: users.email"
// Untuk produksi, kita terjemahkan menjadi pesan yang bisa ditampilkan ke user:
//   "Email 'farel@x.com' sudah digunakan"

export class DuplicateError extends Error {
  constructor(
    public field: string,
    public value: unknown
  ) {
    super(`Nilai '${String(value)}' sudah digunakan untuk field '${field}' (harus unik)`);
    this.name = 'DuplicateError';
  }
}

function translateConstraintError(err: unknown, meta: CollectionMeta, data: Record<string, unknown>): never {
  const message = err instanceof Error ? err.message : String(err);

  // Pola error SQLite: "UNIQUE constraint failed: <table>.<column>"
  const match = message.match(/UNIQUE constraint failed: \w+\.(\w+)/i);
  if (match) {
    const column = match[1];
    const field = meta.fields.find((f) => f.name === column);
    if (field) {
      throw new DuplicateError(column, data[column]);
    }
    throw new DuplicateError(column, data[column]);
  }

  // Bukan error constraint → lempar apa adanya
  throw err;
}

// ─── SERIALIZE: nilai user → bentuk simpan di SQLite ────────────────────────
// bool → 1/0, json → string JSON. Tipe lain apa adanya.

function serializeValue(field: FieldDefinition, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (field.type) {
    case 'bool':
      return value === true ? 1 : 0;
    case 'json':
      return JSON.stringify(value);
    case 'relation': {
      // D2: multi-relation disimpan sebagai JSON array string
      const isMulti = (field.options?.maxSelect ?? 1) > 1;
      if (isMulti) {
        return JSON.stringify(value); // ['a','b'] → '["a","b"]'
      }
      return value; // single: string biasa
    }
    default:
      return value;
  }
}

// ─── DESERIALIZE: baris mentah SQLite → bentuk yang diharapkan user ─────────
// Kebalikan serialize: 1/0 → true/false, string JSON → object.

function deserializeRow(meta: CollectionMeta, row: Record<string, unknown>): ForgeRecord {
  const fmap = fieldMap(meta);
  const result: Record<string, unknown> = { ...row };

  for (const [key, value] of Object.entries(result)) {
    const field = fmap.get(key);
    if (!field || value === null) continue;

    if (field.type === 'bool') {
      result[key] = value === 1;
    } else if (field.type === 'json' && typeof value === 'string') {
      try {
        result[key] = JSON.parse(value);
      } catch {
        result[key] = value; // biarkan apa adanya kalau bukan JSON valid
      }
    } else if (field.type === 'relation' && typeof value === 'string') {
      // D2: multi-relation disimpan sebagai JSON array → parse kembali
      const isMulti = (field.options?.maxSelect ?? 1) > 1;
      if (isMulti) {
        try {
          result[key] = JSON.parse(value);
        } catch {
          result[key] = [];
        }
      }
      // single relation: biarkan string apa adanya
    }
  }

  return result as ForgeRecord;
}

// ─── CREATE ──────────────────────────────────────────────────────────────────

export function createRecord(
  db: DatabaseSync,
  collection: string,
  data: Record<string, unknown>
): ForgeRecord {
  const meta = mustGetCollection(db, collection);
  const fmap = fieldMap(meta);

  // ── Validasi setiap field yang dikirim user ──
  for (const [key, value] of Object.entries(data)) {
    const field = fmap.get(key);
    if (!field) {
      throw new Error(`Field '${key}' tidak ada di collection '${collection}'`);
    }
    const err = validateValue(field, value);
    if (err) throw new Error(err);
  }

  // ── Validasi field required yang TIDAK dikirim ──
  for (const field of meta.fields) {
    if (field.required && !(field.name in data)) {
      throw new Error(`Field '${field.name}' is required`);
    }
  }

  // ── Bangun INSERT secara dinamis dari skema ──
  const id = generateId();
  const columns: string[] = ['id'];
  const placeholders: string[] = ['?'];
  const params: unknown[] = [id];

  for (const field of meta.fields) {
    if (field.name in data) {
      columns.push(`"${field.name}"`);
      placeholders.push('?');
      params.push(serializeValue(field, data[field.name]));
    }
  }

  const sql = `INSERT INTO "${collection}" (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`;
  try {
    db.prepare(sql).run(...(params as never[]));
  } catch (err) {
    translateConstraintError(err, meta, data as Record<string, unknown>);
  }

  return getRecord(db, collection, id)!;
}

// ─── READ ONE ────────────────────────────────────────────────────────────────

export function getRecord(
  db: DatabaseSync,
  collection: string,
  id: string
): ForgeRecord | null {
  const meta = mustGetCollection(db, collection);
  const row = db
    .prepare(`SELECT * FROM "${collection}" WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;

  if (!row) return null;
  return deserializeRow(meta, row);
}

// ─── UPDATE ──────────────────────────────────────────────────────────────────

export function updateRecord(
  db: DatabaseSync,
  collection: string,
  id: string,
  data: Record<string, unknown>
): ForgeRecord | null {
  const meta = mustGetCollection(db, collection);
  const fmap = fieldMap(meta);

  const existing = getRecord(db, collection, id);
  if (!existing) return null;

  // Validasi & bangun SET clause
  const setClauses: string[] = [`"updated" = strftime('%Y-%m-%dT%H:%M:%fZ','now')`];
  const params: unknown[] = [];

  for (const [key, value] of Object.entries(data)) {
    const field = fmap.get(key);
    if (!field) {
      throw new Error(`Field '${key}' tidak ada di collection '${collection}'`);
    }
    const err = validateValue(field, value);
    if (err) throw new Error(err);

    setClauses.push(`"${key}" = ?`);
    params.push(serializeValue(field, value));
  }

  params.push(id);
  const sql = `UPDATE "${collection}" SET ${setClauses.join(', ')} WHERE id = ?`;
  try {
    db.prepare(sql).run(...(params as never[]));
  } catch (err) {
    translateConstraintError(err, meta, data as Record<string, unknown>);
  }

  return getRecord(db, collection, id);
}

// ─── DELETE ──────────────────────────────────────────────────────────────────

export function deleteRecord(
  db: DatabaseSync,
  collection: string,
  id: string
): boolean {
  mustGetCollection(db, collection);
  const result = db
    .prepare(`DELETE FROM "${collection}" WHERE id = ?`)
    .run(id);
  return result.changes > 0;
}

// ─── LIST (dengan filter M04 + sort + pagination) ───────────────────────────

export function listRecords(
  db: DatabaseSync,
  collection: string,
  options: ListOptions = {}
): ListResult {
  const meta = mustGetCollection(db, collection);

  const page = Math.max(1, options.page ?? 1);
  const perPage = Math.min(500, Math.max(1, options.perPage ?? 20));

  // ── WHERE dari filter (memakai query parser M04!) ──
  let whereSql = '';
  const params: unknown[] = [];
  if (options.filter && options.filter.trim().length > 0) {
    const { where, params: filterParams } = filterToSql(options.filter, meta.fields);
    whereSql = `WHERE ${where}`;
    params.push(...filterParams);
  }

  // ── ORDER BY dari sort ──
  let orderSql = 'ORDER BY "created" DESC'; // default: terbaru dulu
  if (options.sort && options.sort.trim().length > 0) {
    orderSql = 'ORDER BY ' + buildOrderBy(options.sort, meta);
  }

  // ── Hitung total (untuk pagination) ──
  const countRow = db
    .prepare(`SELECT COUNT(*) AS n FROM "${collection}" ${whereSql}`)
    .get(...(params as never[])) as { n: number };
  const totalItems = countRow.n;
  const totalPages = Math.max(1, Math.ceil(totalItems / perPage));

  // ── Ambil halaman yang diminta ──
  const offset = (page - 1) * perPage;
  const rows = db
    .prepare(`SELECT * FROM "${collection}" ${whereSql} ${orderSql} LIMIT ? OFFSET ?`)
    .all(...([...params, perPage, offset] as never[])) as Record<string, unknown>[];

  return {
    page,
    perPage,
    totalItems,
    totalPages,
    items: rows.map((r) => deserializeRow(meta, r)),
  };
}

// ─── Helper: parse sort string → ORDER BY ────────────────────────────────────
// '-streak,+created' → '"streak" DESC, "created" ASC'
// Nama field divalidasi terhadap skema (tidak bisa disisipi SQL!)

function buildOrderBy(sort: string, meta: CollectionMeta): string {
  const validNames = new Set([...meta.fields.map((f) => f.name), 'id', 'created', 'updated']);

  const parts = sort.split(',').map((part) => {
    const trimmed = part.trim();
    let direction = 'ASC';
    let name = trimmed;

    if (trimmed.startsWith('-')) {
      direction = 'DESC';
      name = trimmed.slice(1);
    } else if (trimmed.startsWith('+')) {
      name = trimmed.slice(1);
    }

    if (!validNames.has(name)) {
      throw new Error(`Sort field '${name}' tidak ada di collection '${meta.name}'`);
    }
    return `"${name}" ${direction}`;
  });

  return parts.join(', ');
}
