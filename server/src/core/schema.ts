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
  indexes?: IndexDefinition[];
}

// Definisi index — M06
export interface IndexDefinition {
  name: string;
  fields: string[]; // nama kolom yang di-index (bisa >1 = composite)
}

export interface CollectionMeta {
  id: string;
  name: string;
  fields: FieldDefinition[];
  indexes: IndexDefinition[];
  created: string;
  updated: string;
}

interface CollectionRow {
  id: string;
  name: string;
  fields: string; // JSON string di DB
  indexes: string; // JSON string di DB — M06
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
      indexes TEXT NOT NULL DEFAULT '[]',
      created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);

  // Migrasi ringan: kalau tabel _collections lama belum punya kolom
  // indexes, tambahkan (ALTER TABLE). Ini pelajaran kecil migrasi skema!
  const cols = db.prepare(`PRAGMA table_info(_collections)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'indexes')) {
    db.exec(`ALTER TABLE _collections ADD COLUMN indexes TEXT NOT NULL DEFAULT '[]'`);
  }
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

// ─── Index SQL generator — M06 ───────────────────────────────────────────────
// Membuat CREATE INDEX untuk satu definisi index.
// Nama index & kolom divalidasi (sama seperti field — tidak bisa via binding!)

export function generateCreateIndexSql(
  collectionName: string,
  index: IndexDefinition,
  validFields: FieldDefinition[]
): string {
  const validNames = new Set([...validFields.map((f) => f.name), 'id', 'created', 'updated']);

  if (!isValidName(index.name)) {
    throw new Error(`Invalid index name: '${index.name}'`);
  }
  if (index.fields.length === 0) {
    throw new Error(`Index '${index.name}' harus punya minimal 1 field`);
  }

  for (const fieldName of index.fields) {
    if (!validNames.has(fieldName)) {
      throw new Error(
        `Index '${index.name}' merujuk field '${fieldName}' yang tidak ada di collection '${collectionName}'`
      );
    }
  }

  const cols = index.fields.map((f) => `"${f}"`).join(', ');
  return `CREATE INDEX IF NOT EXISTS "${index.name}" ON "${collectionName}" (${cols});`;
}

// ─── Unique index generator — D1 ─────────────────────────────────────────────
// Untuk setiap field dengan unique: true, kita buat UNIQUE INDEX.
// SQLite yang menegakkan keunikan secara atomik — tidak bisa dilewati
// race condition (lihat D1 docs: validasi di kode saja tidak cukup).

export function generateUniqueIndexSql(
  collectionName: string,
  field: FieldDefinition
): string {
  if (!isValidName(field.name)) {
    throw new Error(`Invalid field name for unique index: '${field.name}'`);
  }
  const indexName = `idx_${collectionName}_${field.name}_unique`;
  return `CREATE UNIQUE INDEX IF NOT EXISTS "${indexName}" ON "${collectionName}" ("${field.name}");`;
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
  const indexes = def.indexes ?? [];
  db.prepare(
    'INSERT INTO _collections (id, name, fields, indexes) VALUES (?, ?, ?, ?)'
  ).run(id, def.name, JSON.stringify(def.fields), JSON.stringify(indexes));

  // ── Generate & eksekusi CREATE TABLE untuk tabel ASLI ──
  const sql = generateCreateTableSql(def);
  db.exec(sql);

  // ── Buat UNIQUE INDEX untuk field unique (D1) ──
  for (const field of def.fields) {
    if (field.unique) {
      db.exec(generateUniqueIndexSql(def.name, field));
    }
  }

  // ── Buat index yang didefinisikan (M06) ──
  for (const index of indexes) {
    const indexSql = generateCreateIndexSql(def.name, index, def.fields);
    db.exec(indexSql);
  }

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

// ─── D4: REBUILD COLLECTION — ubah skema tanpa kehilangan data ──────────────
//
// SQLite tidak bisa DROP/ALTER kolom secara langsung. Solusinya pola
// "rebuild": buat tabel baru dengan skema baru, pindahkan data, ganti.
// SEMUA dalam SATU transaksi — kalau gagal di tengah, tabel lama utuh.
//
// Yang bisa dilakukan (yang tidak bisa oleh updateCollection biasa):
//   - Hapus kolom
//   - Ubah tipe kolom
//   - Ubah required
//   - Sekaligus tambah kolom baru

export function rebuildCollection(
  db: DatabaseSync,
  name: string,
  newDef: { fields: FieldDefinition[] }
): CollectionMeta {
  const existing = getCollectionByName(db, name);
  if (!existing) {
    throw new Error(`Collection '${name}' not found`);
  }

  // Validasi nama field baru
  for (const field of newDef.fields) {
    if (!isValidName(field.name)) {
      throw new Error(`Invalid field name: '${field.name}'`);
    }
    if (['id', 'created', 'updated'].includes(field.name)) {
      throw new Error(`Field name '${field.name}' is reserved (field sistem)`);
    }
  }

  const tempName = `${name}__rebuild`;
  const oldFields = existing.fields;
  const newFields = newDef.fields;

  // Kolom yang ada di KEDUA skema (lama & baru) — hanya ini yang bisa di-copy
  const newFieldNames = new Set(newFields.map((f) => f.name));
  const commonFields = oldFields.filter((f) => newFieldNames.has(f.name));

  // Deteksi kolom yang berubah tipenya — nilainya perlu CAST saat copy
  const typeChanged = new Map<string, string>(); // fieldName → newType
  for (const nf of newFields) {
    const of = oldFields.find((f) => f.name === nf.name);
    if (of && of.type !== nf.type) {
      typeChanged.set(nf.name, nf.type);
    }
  }

  db.exec('BEGIN');
  try {
    // ── 1. Buat tabel baru dengan skema baru ──
    const newTableDef: CollectionDefinition = { name: tempName, fields: newFields };
    db.exec(generateCreateTableSql(newTableDef));

    // ── 2. Copy data dari tabel lama ──
    // Bangun daftar kolom untuk SELECT dengan transformasi tipe bila perlu
    const selectCols: string[] = ['id', 'created', 'updated'];
    for (const field of commonFields) {
      if (typeChanged.has(field.name)) {
        // Tipe berubah → konversi nilai saat copy.
        // Untuk number→text: printf('%g') menghilangkan trailing zero
        // (CAST biasa menghasilkan "42.0", kita ingin "42").
        const newType = typeChanged.get(field.name);
        if (newType === 'text' && field.type === 'number') {
          selectCols.push(`printf('%g', "${field.name}") AS "${field.name}"`);
        } else {
          const targetSqlType = newType === 'number' ? 'REAL' : 'TEXT';
          selectCols.push(`CAST("${field.name}" AS ${targetSqlType}) AS "${field.name}"`);
        }
      } else {
        selectCols.push(`"${field.name}"`);
      }
    }

    // Untuk kolom BARU yang required tapi tidak ada di skema lama,
    // kita perlu memberi nilai default saat copy (atau gagal karena NOT NULL)
    const oldFieldNames = new Set(oldFields.map((f) => f.name));
    const insertCols: string[] = ['id', 'created', 'updated', ...commonFields.map((f) => `"${f.name}"`)];
    const insertVals: string[] = [...selectCols];
    for (const nf of newFields) {
      if (!oldFieldNames.has(nf.name)) {
        // Kolom baru → isi nilai default agar tidak melanggar NOT NULL
        insertCols.push(`"${nf.name}"`);
        insertVals.push(defaultValueForType(nf));
      }
    }

    const copySql = `INSERT INTO "${tempName}" (${insertCols.join(', ')})
                     SELECT ${insertVals.join(', ')} FROM "${name}"`;
    db.exec(copySql);

    // ── 3. Hapus tabel lama ──
    db.exec(`DROP TABLE "${name}"`);

    // ── 4. Rename tabel baru menjadi nama asli ──
    db.exec(`ALTER TABLE "${tempName}" RENAME TO "${name}"`);

    // ── 5. Buat ulang index (unique D1 + custom M06) ──
    for (const field of newFields) {
      if (field.unique) {
        db.exec(generateUniqueIndexSql(name, field));
      }
    }
    for (const index of existing.indexes) {
      // Hanya buat ulang index yang semua kolomnya masih ada
      const allExist = index.fields.every((f) => f === 'id' || f === 'created' || f === 'updated' || newFieldNames.has(f));
      if (allExist) {
        db.exec(generateCreateIndexSql(name, index, newFields));
      }
    }

    // ── 6. Update definisi di _collections ──
    db.prepare(
      `UPDATE _collections SET fields = ?,
       updated = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE name = ?`
    ).run(JSON.stringify(newFields), name);

    db.exec('COMMIT');
    return getCollectionByName(db, name)!;
  } catch (err) {
    db.exec('ROLLBACK');
    throw new Error(
      `Rebuild collection '${name}' gagal (tidak ada data yang hilang): ${err instanceof Error ? err.message : err}`
    );
  }
}

// Nilai default untuk kolom BARU yang required saat rebuild
function defaultValueForType(field: FieldDefinition): string {
  switch (field.type) {
    case 'number':
      return '0';
    case 'bool':
      return '0';
    case 'json':
      return `'null'`;
    default:
      return `''`;
  }
}

// ─── Helper ──────────────────────────────────────────────────────────────────

function rowToMeta(row: CollectionRow): CollectionMeta {
  return {
    id: row.id,
    name: row.name,
    fields: JSON.parse(row.fields) as FieldDefinition[],
    indexes: JSON.parse(row.indexes ?? '[]') as IndexDefinition[],
    created: row.created,
    updated: row.updated,
  };
}
