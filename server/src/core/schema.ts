// ============================================================================
// M03: SCHEMA MANAGER — jantung meta-tables
//
// Di sinilah "skema sebagai data" menjadi nyata:
//   1. Definisi collection disimpan sebagai BARIS di tabel _collections
//   2. Kita membaca baris itu → men-generate SQL CREATE TABLE
//   3. Tabel asli terbentuk — tanpa ada yang menulis SQL dengan tangan
//
// Ini persis cara PocketBase bekerja. Setelah file ini, kamu tidak akan
// pernah melihat "CREATE TABLE" dengan cara yang sama lagi.
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import { generateId } from './router.js';
import {
  FieldDefinition,
  fieldToSql,
  isValidName,
  isSystemName,
} from './fieldTypes.js';

// ─── Tipe data meta ──────────────────────────────────────────────────────────

export interface CollectionDefinition {
  name: string;
  fields: FieldDefinition[];
}

export interface CollectionMeta {
  id: string;
  name: string;
  fields: FieldDefinition[];
  created: string;
  updated: string;
}

interface CollectionRow {
  id: string;
  name: string;
  fields: string; // JSON string di DB
  created: string;
  updated: string;
}

// ─── Inisialisasi tabel meta ─────────────────────────────────────────────────
// _collections = "database di dalam database".
// Diawali underscore: konvensi PocketBase untuk tabel sistem.

export function initSchemaTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _collections (
      id      TEXT PRIMARY KEY,
      name    TEXT UNIQUE NOT NULL,
      fields  TEXT NOT NULL DEFAULT '[]',
      created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
}

// ─── SQL GENERATOR — bagian paling ajaib ─────────────────────────────────────
// Menerjemahkan definisi collection menjadi CREATE TABLE lengkap.
// Perhatikan: fungsi ini TIDAK menyentuh database — ia murni
// data → string SQL. Fungsi murni seperti ini mudah di-test!

export function generateCreateTableSql(def: CollectionDefinition): string {
  // Kolom SISTEM — selalu ada, seperti PocketBase (id/created/updated)
  const systemColumns = [
    '"id" TEXT PRIMARY KEY',
    `"created" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    `"updated" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
  ];

  // Kolom USER — dari definisi fields
  const userColumns = def.fields.map(fieldToSql);

  const allColumns = [...systemColumns, ...userColumns].join(',\n  ');

  return `CREATE TABLE "${def.name}" (\n  ${allColumns}\n);`;
}

// ─── CRUD untuk collections (meta-level) ─────────────────────────────────────

export function defineCollection(
  db: DatabaseSync,
  def: CollectionDefinition
): CollectionMeta {
  // ── Validasi nama collection ──
  if (!isValidName(def.name)) {
    throw new Error(
      `Invalid collection name: '${def.name}' (hanya a-z, 0-9, _, diawali huruf)`
    );
  }
  if (isSystemName(def.name)) {
    throw new Error(`Collection name '${def.name}' is reserved (underscore = sistem)`);
  }

  // ── Cek duplikat ──
  const existing = getCollectionByName(db, def.name);
  if (existing) {
    throw new Error(`Collection '${def.name}' already exists`);
  }

  // ── Validasi semua field ──
  for (const field of def.fields) {
    if (!isValidName(field.name)) {
      throw new Error(`Invalid field name: '${field.name}'`);
    }
    if (['id', 'created', 'updated'].includes(field.name)) {
      throw new Error(`Field name '${field.name}' is reserved (field sistem)`);
    }
  }

  // ── Simpan definisi ke META table ──
  // Inilah "schema as data": skema disimpan sebagai BARIS DATA.
  const id = generateId();
  db.prepare(
    'INSERT INTO _collections (id, name, fields) VALUES (?, ?, ?)'
  ).run(id, def.name, JSON.stringify(def.fields));

  // ── Generate & eksekusi CREATE TABLE untuk tabel ASLI ──
  const sql = generateCreateTableSql(def);
  db.exec(sql);

  return getCollectionByName(db, def.name)!;
}

export function getCollectionByName(
  db: DatabaseSync,
  name: string
): CollectionMeta | undefined {
  const row = db
    .prepare('SELECT * FROM _collections WHERE name = ?')
    .get(name) as unknown as CollectionRow | undefined;

  if (!row) return undefined;
  return rowToMeta(row);
}

export function listCollections(db: DatabaseSync): CollectionMeta[] {
  const rows = db
    .prepare('SELECT * FROM _collections ORDER BY created ASC')
    .all() as unknown as CollectionRow[];
  return rows.map(rowToMeta);
}

// ─── Update collection: untuk M03, hanya dukung TAMBAH kolom ────────────────
// SQLite tidak bisa mengubah/menghapus kolom dengan mudah (harus rebuild
// tabel — itu materi advanced). PocketBase pun punya mekanisme khusus.
// Untuk M03: tambah kolom = ALTER TABLE ADD COLUMN. Aman & cukup.

export function updateCollection(
  db: DatabaseSync,
  name: string,
  updates: { fields: FieldDefinition[] }
): CollectionMeta {
  const existing = getCollectionByName(db, name);
  if (!existing) {
    throw new Error(`Collection '${name}' not found`);
  }

  const existingNames = new Set(existing.fields.map((f) => f.name));
  const newFields = updates.fields.filter((f) => !existingNames.has(f.name));

  // Tolak jika ada field lama yang hilang (= hapus kolom, tidak didukung)
  const removedFields = existing.fields.filter(
    (f) => !updates.fields.some((nf) => nf.name === f.name)
  );
  if (removedFields.length > 0) {
    throw new Error(
      `Removing fields is not supported yet (would drop: ${removedFields
        .map((f) => f.name)
        .join(', ')}). SQLite needs table rebuild for that.`
    );
  }

  // Tambah kolom baru satu per satu via ALTER TABLE
  for (const field of newFields) {
    const columnSql = fieldToSql(field);
    db.exec(`ALTER TABLE "${name}" ADD COLUMN ${columnSql};`);
  }

  // Update definisi di meta table
  db.prepare(
    `UPDATE _collections SET fields = ?,
     updated = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE name = ?`
  ).run(JSON.stringify(updates.fields), name);

  return getCollectionByName(db, name)!;
}

export function deleteCollection(db: DatabaseSync, name: string): boolean {
  const existing = getCollectionByName(db, name);
  if (!existing) return false;

  // Hapus dari meta + drop tabel asli
  db.prepare('DELETE FROM _collections WHERE name = ?').run(name);
  db.exec(`DROP TABLE IF EXISTS "${name}";`);
  return true;
}

// ─── Helper ──────────────────────────────────────────────────────────────────

function rowToMeta(row: CollectionRow): CollectionMeta {
  return {
    id: row.id,
    name: row.name,
    fields: JSON.parse(row.fields) as FieldDefinition[],
    created: row.created,
    updated: row.updated,
  };
}
