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
import { CollectionRules, DEFAULT_RULES, validateRuleFields } from './rules.js';
import { createFts, dropFts } from './fts.js';
import {
  FieldDefinition,
  fieldToSql,
  isValidName,
  isSystemName,
} from './fieldTypes.js';

// ─── Tipe data meta ──────────────────────────────────────────────────────────

export interface CollectionDefinition {
  name: string;
  type?: 'base' | 'view' | 'auth';
  fields: FieldDefinition[];
  indexes?: IndexDefinition[];
  rules?: Partial<CollectionRules>; // M11: opsional, default semua null (admin-only)
}

// Definisi index — M06
export interface IndexDefinition {
  name: string;
  fields: string[]; // nama kolom yang di-index (bisa >1 = composite)
  unique?: boolean; // apakah UNIQUE index
}

export interface CollectionMeta {
  id: string;
  name: string;
  fields: FieldDefinition[];
  indexes: IndexDefinition[];
  rules: CollectionRules; // M11: API rules per collection
  type: 'base' | 'view' | 'auth'; // M16a: base = tabel fisik; view = SQL view read-only; auth = user auth collection
  viewQuery: string | null; // M16a: SELECT statement (hanya untuk type=view)
  created: string;
  updated: string;
}

interface CollectionRow {
  id: string;
  name: string;
  fields: string; // JSON string di DB
  indexes: string; // JSON string di DB — M06
  rules: string | null; // JSON string di DB — M11 (null = belum ada kolomnya di DB lama)
  type: string | null; // M16a: 'base' | 'view' (null = base, kompatibel DB lama)
  viewQuery: string | null; // M16a
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

  // M11: kolom rules (JSON dengan 5 rule per collection)
  if (!cols.some((c) => c.name === 'rules')) {
    db.exec(`ALTER TABLE _collections ADD COLUMN rules TEXT`); // NULL = semua rule null (admin-only default)
  }

  // M16a: kolom type + viewQuery (view collections)
  if (!cols.some((c) => c.name === 'type')) {
    db.exec(`ALTER TABLE _collections ADD COLUMN type TEXT NOT NULL DEFAULT 'base'`);
  }
  if (!cols.some((c) => c.name.toLowerCase() === 'viewquery')) {
    db.exec(`ALTER TABLE _collections ADD COLUMN viewQuery TEXT`);
  }

  // ── D5: tabel _migrations — mencatat setiap perubahan skema ──
  // Schema-as-data (M03) sekarang juga punya HISTORY-as-data.
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         TEXT PRIMARY KEY,
      collection TEXT NOT NULL,
      action     TEXT NOT NULL,
      changes    TEXT NOT NULL DEFAULT '{}',
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
}

// ─── D5: Migration recording ─────────────────────────────────────────────────

export type MigrationAction = 'create' | 'add_column' | 'rebuild' | 'drop' | 'update_rules';

export interface MigrationRecord {
  id: string;
  collection: string;
  action: MigrationAction;
  changes: Record<string, unknown>;
  applied_at: string;
}

// Mencatat satu perubahan skema ke _migrations.
// Dipanggil otomatis oleh defineCollection, updateCollection,
// rebuildCollection, dan deleteCollection.
function recordMigration(
  db: DatabaseSync,
  collection: string,
  action: MigrationAction,
  changes: Record<string, unknown>
): void {
  db.prepare(
    'INSERT INTO _migrations (id, collection, action, changes) VALUES (?, ?, ?, ?)'
  ).run(generateId(), collection, action, JSON.stringify(changes));
}

// Membaca history migrasi (urut waktu, terbaru terakhir).
// Kalau collectionName diisi, hanya migrasi untuk collection itu.
export function getMigrations(db: DatabaseSync, collectionName?: string): MigrationRecord[] {
  const sql = collectionName
    ? 'SELECT * FROM _migrations WHERE collection = ? ORDER BY applied_at ASC'
    : 'SELECT * FROM _migrations ORDER BY applied_at ASC';
  const rows = (collectionName
    ? db.prepare(sql).all(collectionName)
    : db.prepare(sql).all()) as unknown as {
    id: string;
    collection: string;
    action: MigrationAction;
    changes: string;
    applied_at: string;
  }[];

  return rows.map((r) => ({
    id: r.id,
    collection: r.collection,
    action: r.action,
    changes: JSON.parse(r.changes) as Record<string, unknown>,
    applied_at: r.applied_at,
  }));
}

// Versi skema sebuah collection = berapa kali ia berubah
export function getSchemaVersion(db: DatabaseSync, collectionName: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM _migrations WHERE collection = ?')
    .get(collectionName) as { n: number };
  return row.n;
}

// ─── SQL GENERATOR — bagian paling ajaib ─────────────────────────────────────
// Menerjemahkan definisi collection menjadi CREATE TABLE lengkap.
// Perhatikan: fungsi ini TIDAK menyentuh database — ia murni
// data → string SQL. Fungsi murni seperti ini mudah di-test!

export function generateCreateTableSql(def: CollectionDefinition): string {
  const isAuth = def.type === 'auth';
  // Kolom SISTEM — selalu ada, seperti PocketBase (id/created/updated)
  const systemColumns = [
    '"id" TEXT PRIMARY KEY',
    ...(isAuth ? ['"password_hash" TEXT NOT NULL'] : []),
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
  const uniqueStr = index.unique ? 'UNIQUE ' : '';
  return `CREATE ${uniqueStr}INDEX IF NOT EXISTS "${index.name}" ON "${collectionName}" (${cols});`;
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
  const isAuth = def.type === 'auth';
  const fieldsToUse = [...def.fields];
  if (isAuth) {
    if (!fieldsToUse.some((f) => f.name === 'email')) {
      fieldsToUse.unshift({ name: 'email', type: 'email', required: true });
    }
    if (!fieldsToUse.some((f) => f.name === 'verified')) {
      fieldsToUse.push({ name: 'verified', type: 'bool', required: false });
    }
  }

  for (const field of fieldsToUse) {
    if (!isValidName(field.name)) {
      throw new Error(`Invalid field name: '${field.name}'`);
    }
    if (['id', 'created', 'updated', 'password_hash'].includes(field.name)) {
      throw new Error(`Field name '${field.name}' is reserved (field sistem)`);
    }
  }

  // ── Simpan definisi ke META table ──
  // Inilah "schema as data": skema disimpan sebagai BARIS DATA.
  const id = generateId();
  const indexes = def.indexes ?? [];
  const rules: CollectionRules = { ...DEFAULT_RULES, ...(def.rules ?? {}) };
  // M11: validasi field rule terhadap skema (typo rule tidak boleh diam)
  for (const [key, rule] of Object.entries(rules)) {
    if (typeof rule === 'string' && rule.trim() !== '') {
      const err = validateRuleFields(rule, fieldsToUse);
      if (err) throw new Error(`${key}: ${err}`);
    }
  }
  db.prepare(
    'INSERT INTO _collections (id, name, fields, indexes, rules, type, viewQuery) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, def.name, JSON.stringify(fieldsToUse), JSON.stringify(indexes), JSON.stringify(rules), def.type ?? 'base', null);

  // ── Generate & eksekusi CREATE TABLE untuk tabel ASLI ──
  const sql = generateCreateTableSql({ ...def, fields: fieldsToUse });
  db.exec(sql);

  // ── Buat UNIQUE INDEX untuk field unique (D1) ──
  for (const field of fieldsToUse) {
    if (field.unique) {
      db.exec(generateUniqueIndexSql(def.name, field));
    }
  }

  if (isAuth) {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "idx_${def.name}_email" ON "${def.name}" ("email");`);
  }

  // ── M17b: FTS5 index untuk field dengan options.fulltext ──
  const ftsFields = def.fields.filter((f) => f.options?.fulltext === true).map((f) => f.name);
  if (ftsFields.length > 0) {
    createFts(db, def.name, ftsFields);
  }

  // ── Buat index yang didefinisikan (M06) ──
  for (const index of indexes) {
    const indexSql = generateCreateIndexSql(def.name, index, def.fields);
    db.exec(indexSql);
  }

  // ── D5: catat migrasi ──
  recordMigration(db, def.name, 'create', { fields: def.fields, indexes });

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

  // ── D5: catat migrasi ──
  recordMigration(db, name, 'add_column', { added: newFields.map((f) => f.name), fields: updates.fields });

  return getCollectionByName(db, name)!;
}

export function deleteCollection(db: DatabaseSync, name: string): boolean {
  const existing = getCollectionByName(db, name);
  if (!existing) return false;

  // Hapus dari meta + drop tabel/view asli
  db.prepare('DELETE FROM _collections WHERE name = ?').run(name);
  if (existing.type === 'view') {
    // M16a: view pakai DROP VIEW, bukan DROP TABLE
    db.exec(`DROP VIEW IF EXISTS "${name}";`);
  } else {
    db.exec(`DROP TABLE IF EXISTS "${name}";`);
    // M17b: bersihkan FTS index + triggers jika ada
    dropFts(db, name);
  }

  // ── D5: catat migrasi ──
  recordMigration(db, name, 'drop', { fields: existing.fields });

  return true;
}

// ─── M16a: VIEW COLLECTIONS — SQL view read-only ────────────────────────────
// "SELECT user, COUNT(*) AS total FROM orders GROUP BY user"
// → collection virtual: fields dari hasil query, read-only, rules tetap jalan.
//
// Aman karena: query dijalankan SEKALI saat create (validasi + ekstrak
// fields via PRAGMA-style stmt.columns()), bukan dieksekusi per request.
// Read = query biasa (rules list/view bekerja); write = ditolak (view
// bukan tabel — SQLite akan error, tapi kita beri pesan lebih ramah).

export function createViewCollection(
  db: DatabaseSync,
  def: { name: string; viewQuery: string; rules?: Partial<CollectionRules> }
): CollectionMeta {
  if (!isValidName(def.name)) {
    throw new Error(`Invalid collection name: '${def.name}'`);
  }
  if (isSystemName(def.name)) {
    throw new Error(`Collection name '${def.name}' is reserved`);
  }
  if (getCollectionByName(db, def.name)) {
    throw new Error(`Collection '${def.name}' already exists`);
  }
  const query = def.viewQuery.trim();
  if (!/^select\s/i.test(query)) {
    throw new Error('viewQuery harus dimulai dengan SELECT');
  }
  // Anti multi-statement
  if (/;\s*\S/i.test(query)) {
    throw new Error('viewQuery tidak boleh mengandung multiple statements');
  }

  // Dry run: validasi + ekstrak kolom hasil
  let columns: { name: string; type: string }[];
  try {
    const stmt = db.prepare(query);
    stmt.all();
    columns = stmt.columns().map((c) => ({ name: c.name, type: String(c.column ?? '') }));
  } catch (err) {
    throw new Error(`viewQuery tidak valid: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (columns.length === 0) {
    throw new Error('viewQuery harus mengembalikan minimal 1 kolom');
  }

  // Fields dari kolom hasil (skip field sistem; semua dibaca sebagai json
  // — fleksibel utk read-only; SQLite mengembalikan tipe aslinya)
  const fields: FieldDefinition[] = [];
  for (const col of columns) {
    if (col.name === 'id' || col.name === 'created' || col.name === 'updated') continue;
    if (fields.some((f) => f.name === col.name)) continue;
    fields.push({ name: col.name, type: 'json' });
  }

  // Simpan meta + buat VIEW fisik
  const id = generateId();
  const rules: CollectionRules = { ...DEFAULT_RULES, ...(def.rules ?? {}) };
  db.prepare(
    `INSERT INTO _collections (id, name, fields, indexes, rules, type, viewQuery) VALUES (?, ?, ?, ?, ?, 'view', ?)`
  ).run(id, def.name, JSON.stringify(fields), '[]', JSON.stringify(rules), query);

  db.exec(`CREATE VIEW "${def.name}" AS ${query}`);

  // D5: catat migrasi
  recordMigration(db, def.name, 'create', { type: 'view', viewQuery: query });

  return getCollectionByName(db, def.name)!;
}

// ─── M16a: helper — apakah collection adalah view? ──────────────────────────

export function isViewCollection(meta: CollectionMeta): boolean {
  return meta.type === 'view';
}

export function isAuthCollection(meta: CollectionMeta): boolean {
  return meta.type === 'auth';
}

// ─── M11: UPDATE RULES — kebijakan keamanan adalah data, jadi bisa diubah ───
// Tanpa menyentuh tabel asli — rules hidup di meta, dievaluasi saat request.

export function updateCollectionRules(
  db: DatabaseSync,
  name: string,
  rules: Partial<CollectionRules>
): CollectionMeta {
  const existing = getCollectionByName(db, name);
  if (!existing) {
    throw new Error(`Collection '${name}' not found`);
  }

  // Validasi field di rule terhadap skema
  for (const [key, rule] of Object.entries(rules)) {
    if (typeof rule === 'string' && rule.trim() !== '') {
      const err = validateRuleFields(rule, existing.fields);
      if (err) throw new Error(`${key}: ${err}`);
    }
  }

  const merged: CollectionRules = { ...existing.rules, ...rules };
  db.prepare(
    `UPDATE _collections SET rules = ?,
     updated = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE name = ?`
  ).run(JSON.stringify(merged), name);

  // D5: catat migrasi
  recordMigration(db, name, 'update_rules', { rules: merged });

  return getCollectionByName(db, name)!;
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
  newDef: { fields: FieldDefinition[]; indexes?: IndexDefinition[] }
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
  const isAuth = existing.type === 'auth';
  const oldFields = existing.fields;
  let newFields = [...newDef.fields];
  if (isAuth) {
    if (!newFields.some((f) => f.name === 'email')) {
      newFields.unshift({ name: 'email', type: 'email', required: true });
    }
    if (!newFields.some((f) => f.name === 'verified')) {
      newFields.push({ name: 'verified', type: 'bool', required: false });
    }
  }

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
    const newTableDef: CollectionDefinition = { name: tempName, fields: newFields, type: existing.type };
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

    if (isAuth) {
      insertCols.push('"password_hash"');
      insertVals.push('"password_hash"');
    }

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
    if (isAuth) {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "idx_${name}_email" ON "${name}" ("email");`);
    }
    const finalIndexes = newDef.indexes !== undefined ? newDef.indexes : existing.indexes;
    for (const index of finalIndexes) {
      // Hanya buat ulang index yang semua kolomnya masih ada
      const allExist = index.fields.every((f) => f === 'id' || f === 'created' || f === 'updated' || newFieldNames.has(f));
      if (allExist) {
        db.exec(generateCreateIndexSql(name, index, newFields));
      }
    }

    // ── 6. Update definisi di _collections ──
    db.prepare(
      `UPDATE _collections SET fields = ?, indexes = ?,
       updated = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE name = ?`
    ).run(JSON.stringify(newFields), JSON.stringify(finalIndexes), name);

    // ── 7. D5: catat migrasi rebuild (dengan before & after) ──
    recordMigration(db, name, 'rebuild', {
      before: oldFields,
      after: newFields,
    });

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

// ─── B3.1: DUPLICATE COLLECTION ──────────────────────────────────────────────
// Menyalin skema collection ke nama baru, opsional beserta datanya.

export function duplicateCollection(
  db: DatabaseSync,
  sourceName: string,
  newName: string,
  options: { withData?: boolean } = {}
): CollectionMeta {
  const source = getCollectionByName(db, sourceName);
  if (!source) {
    throw new Error(`Collection sumber '${sourceName}' tidak ditemukan`);
  }
  if (getCollectionByName(db, newName)) {
    throw new Error(`Collection '${newName}' sudah ada`);
  }

  // Buat collection baru dengan skema sama
  const created = defineCollection(db, {
    name: newName,
    fields: source.fields,
    indexes: source.indexes,
  });

  // Salin data kalau diminta
  if (options.withData) {
    const cols = ['id', 'created', 'updated', ...source.fields.map((f) => `"${f.name}"`)].join(', ');
    db.exec(`INSERT INTO "${newName}" (${cols}) SELECT ${cols} FROM "${sourceName}"`);
  }

  return created;
}

// ─── Helper ──────────────────────────────────────────────────────────────────

function rowToMeta(row: CollectionRow): CollectionMeta {
  return {
    id: row.id,
    name: row.name,
    fields: JSON.parse(row.fields) as FieldDefinition[],
    indexes: JSON.parse(row.indexes ?? '[]') as IndexDefinition[],
    rules: parseRules(row.rules),
    type: row.type === 'view' ? 'view' : row.type === 'auth' ? 'auth' : 'base', // null/unknown → base
    viewQuery: row.viewQuery ?? null,
    created: row.created,
    updated: row.updated,
  };
}

// M11: parse rules dari DB; null/invalid → DEFAULT_RULES (aman)
function parseRules(raw: string | null | undefined): CollectionRules {
  if (!raw) return { ...DEFAULT_RULES };
  try {
    return { ...DEFAULT_RULES, ...(JSON.parse(raw) as Partial<CollectionRules>) };
  } catch {
    return { ...DEFAULT_RULES };
  }
}
