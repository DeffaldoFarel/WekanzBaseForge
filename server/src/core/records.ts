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
import { getCollectionByName, listCollections, CollectionMeta } from './schema.js';
import { FieldDefinition, validateValue } from './fieldTypes.js';
import { filterToSql, RequestContext } from './query/sqlBuilder.js';
import { decideRule, evaluateRuleOnData, ForbiddenError, CollectionRules } from './rules.js';
import { parseMultipart, extractBoundary, MultipartFile } from './multipart.js';
import { saveFile, deleteFile, deleteRecordFiles, storedFilenames } from './storage.js';
import { isViewCollection } from './schema.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { ftsTableName, sanitizeFtsQuery, ftsFields } from './fts.js';

// M16a: error khusus write ke view collection
export class ViewWriteError extends Error {
  constructor(collection: string) {
    super(`'${collection}' adalah view collection (read-only) — tidak bisa di-INSERT/UPDATE/DELETE`);
    this.name = 'ViewWriteError';
  }
}

// M16a: guard view untuk operasi tulis
function assertNotView(meta: CollectionMeta): void {
  if (isViewCollection(meta)) {
    throw new ViewWriteError(meta.name);
  }
}

// ─── Tipe ────────────────────────────────────────────────────────────────────

export type ForgeRecord = { id: string; created: string; updated: string } & {
  [key: string]: unknown;
};

export interface ListOptions {
  filter?: string;
  sort?: string; // '-streak,+created' → DESC, ASC
  page?: number;
  perPage?: number;
  reqCtx?: RequestContext; // M11: identitas user untuk rules
  search?: string; // M17b: full-text search (jika collection punya FTS index)
}

export interface ListResult {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: ForgeRecord[];
}

// ─── M11: RulesContext — operasi mana pun menerima konteks rules ────────────
// undefined = konteks admin (bypass semua rule) — dipakai admin API M05u.
// Dengan auth = end-user — rules dievaluasi.

export type RulesCtx = RequestContext | undefined;

// M11: pilih rule yang relevan + evaluasi
function ruleFor(meta: CollectionMeta, op: keyof CollectionRules): string | null {
  return meta.rules[op] ?? null;
}

// ─── M14: MULTIPART → DATA (dipanggil dari API layer sebelum createRecord) ──
// Mengubah multipart form menjadi: field teks + nama file tersimpan.
// File fisik ditulis ke disk DI SINI (setelah recordId diketahui).
//
// Flow create: id dibuat dulu → file disimpan sebagai <id>_<filename> →
// data field file = nama tersimpan → INSERT.

export function multipartToRecordData(
  projectId: string,
  meta: CollectionMeta,
  recordId: string,
  body: Buffer,
  contentType: string
): Record<string, unknown> {
  const boundary = extractBoundary(contentType);
  if (!boundary) throw new Error('Malformed multipart: boundary tidak ditemukan');

  const { fields, files } = parseMultipart(body, boundary);
  const data: Record<string, unknown> = { ...fields };
  const fmap = fieldMap(meta);

  // Kelompokkan file per field
  const filesByField = new Map<string, MultipartFile[]>();
  for (const f of files) {
    const arr = filesByField.get(f.fieldName) ?? [];
    arr.push(f);
    filesByField.set(f.fieldName, arr);
  }

  for (const [fieldName, fieldFiles] of filesByField) {
    const field = fmap.get(fieldName);
    if (!field) {
      throw new Error(`Field '${fieldName}' tidak ada di collection '${meta.name}'`);
    }
    if (field.type !== 'file') {
      throw new Error(`Field '${fieldName}' bukan tipe file — upload ditolak`);
    }

    const isMulti = (field.options?.maxSelect ?? 1) > 1;
    const maxSize = field.options?.maxSize ?? 5 * 1024 * 1024; // 5 MB default

    // Validasi ukuran SEBELUM simpan apa pun ke disk
    for (const f of fieldFiles) {
      if (f.data.length > maxSize) {
        throw new Error(
          `File '${f.filename}' melebihi batas ${Math.floor(maxSize / 1024 / 1024)} MB untuk field '${fieldName}'`
        );
      }
    }

    if (isMulti) {
      const stored: string[] = [];
      for (const f of fieldFiles) {
        stored.push(saveFile(projectId, recordId, f.filename, f.data));
      }
      data[fieldName] = stored;
    } else {
      if (fieldFiles.length > 1) {
        throw new Error(`Field '${fieldName}' hanya menerima 1 file (maxSelect=1)`);
      }
      data[fieldName] = saveFile(projectId, recordId, fieldFiles[0].filename, fieldFiles[0].data);
    }
  }

  return data;
}

// ─── M14: hapus file lama yang diganti saat update ──────────────────────────

export function cleanupReplacedFiles(
  projectId: string,
  meta: CollectionMeta,
  recordId: string,
  oldRecord: Record<string, unknown>,
  newData: Record<string, unknown>
): void {
  const fmap = fieldMap(meta);
  for (const [key, field] of fmap) {
    if (field.type !== 'file' || !(key in newData)) continue;
    const oldFiles = storedFilenames(oldRecord[key]);
    const newFiles = storedFilenames(newData[key]);
    for (const f of oldFiles) {
      if (!newFiles.includes(f)) {
        deleteFile(projectId, recordId, f);
      }
    }
  }
}

// ─── M14: hapus SEMUA file record (dipanggil deleteRecord) ──────────────────

export function cleanupAllRecordFiles(
  projectId: string,
  meta: CollectionMeta,
  recordId: string,
  record: Record<string, unknown>
): void {
  const fmap = fieldMap(meta);
  let hasFiles = false;
  for (const [key, field] of fmap) {
    if (field.type === 'file') {
      hasFiles = true;
      for (const f of storedFilenames(record[key])) {
        deleteFile(projectId, recordId, f);
      }
    }
  }
  // Fallback: hapus sisa file dengan prefix record (berjaga kalau ada orphan)
  if (hasFiles) deleteRecordFiles(projectId, recordId);
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
    case 'file': {
      // M14: multi-file disimpan sebagai JSON array string (sama dgn relation)
      const isMulti = (field.options?.maxSelect ?? 1) > 1;
      if (isMulti) {
        return JSON.stringify(value);
      }
      return value;
    }
    case 'geoPoint': {
      // M16b: { lat, lng } → TEXT JSON
      return JSON.stringify(value);
    }
    case 'password': {
      // M16b: HASH SAAT WRITE (M08 reuse) — plain never stored
      // (string apa pun yang lolos validateValue → hash scrypt)
      return hashPassword(value as string);
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
    } else if (field.type === 'file' && typeof value === 'string') {
      // M14: multi-file disimpan sebagai JSON array → parse kembali
      const isMulti = (field.options?.maxSelect ?? 1) > 1;
      if (isMulti) {
        try {
          result[key] = JSON.parse(value);
        } catch {
          result[key] = [];
        }
      }
    } else if (field.type === 'geoPoint' && typeof value === 'string') {
      // M16b: { lat, lng } TEXT JSON → object
      try {
        result[key] = JSON.parse(value);
      } catch {
        result[key] = null;
      }
    } else if (field.type === 'password') {
      // M16b: HASH TIDAK PERNAH DIKEMBALIKAN — field hilang dari response.
      // (Bagi client: field ini write-only. Tidak ada verify endpoint untuk
      // field-level password di M16b — kebutuhan verify = auth collection.)
      delete result[key];
    }
  }

  return result as ForgeRecord;
}

// ─── CREATE ──────────────────────────────────────────────────────────────────

export function createRecord(
  db: DatabaseSync,
  collection: string,
  data: Record<string, unknown>,
  reqCtx?: RequestContext,
  preGeneratedId?: string // M14: multipart butuh id SEBELUM insert (nama file)
): ForgeRecord {
  const meta = mustGetCollection(db, collection);
  const fmap = fieldMap(meta);
  assertNotView(meta); // M16a: view read-only

  // ── M11: createRule dievaluasi terhadap DATA yang dikirim ──
  // Hanya untuk END USER — admin (reqCtx undefined) selalu bypass.
  const cRule = ruleFor(meta, 'createRule');
  if (reqCtx !== undefined) {
    if (cRule === null) {
      throw new ForbiddenError();
    }
    if (cRule.trim() !== '' && !evaluateRuleOnData(cRule, data, reqCtx)) {
      throw new ForbiddenError();
    }
  }

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
    // autodate dikelola sistem → tidak perlu dikirim user
    if (field.type === 'autodate') continue;
    if (field.required && !(field.name in data)) {
      throw new Error(`Field '${field.name}' is required`);
    }
  }

  // ── Bangun INSERT secara dinamis dari skema ──
  const id = preGeneratedId ?? generateId();
  const columns: string[] = ['id'];
  const placeholders: string[] = ['?'];
  const params: unknown[] = [id];

  const now = new Date().toISOString();

  for (const field of meta.fields) {
    // B1: autodate SEPENUHNYA dikelola sistem — nilai dari user diabaikan.
    if (field.type === 'autodate') {
      if (field.options?.onCreate) {
        columns.push(`"${field.name}"`);
        placeholders.push('?');
        params.push(now);
      }
      continue;
    }

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

// ─── B3.2: BATCH CREATE — insert banyak record dalam SATU transaksi ─────────
// Jauh lebih cepat dari createRecord berulang (ingat M02: transaksi = 230x!)
// dan atomik: satu gagal → semua batal (tidak ada setengah jadi).

export function createRecordsBatch(
  db: DatabaseSync,
  collection: string,
  recordsData: Record<string, unknown>[]
): ForgeRecord[] {
  mustGetCollection(db, collection);

  const created: ForgeRecord[] = [];
  db.exec('BEGIN');
  try {
    for (const data of recordsData) {
      created.push(createRecord(db, collection, data));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return created;
}

// ─── READ ONE ────────────────────────────────────────────────────────────────

export function getRecord(
  db: DatabaseSync,
  collection: string,
  id: string,
  reqCtx?: RequestContext
): ForgeRecord | null {
  const meta = mustGetCollection(db, collection);
  const record = getRecordRaw(db, meta, collection, id);
  if (!record) return null;

  // ── M11: viewRule — hanya untuk END USER (admin bypass) ──
  if (reqCtx !== undefined) {
    const vRule = ruleFor(meta, 'viewRule');
    if (vRule === null) return null; // admin-only view → "tidak terlihat"
    if (vRule.trim() !== '' && !evaluateRuleOnData(vRule, record as Record<string, unknown>, reqCtx)) {
      return null; // tidak lolos rule → null (bukan error — semantik PocketBase)
    }
  }

  return record;
}

// M11: ambil record TANPA cek rules — untuk pemakaian INTERNAL
// (createRecord balikin hasil, updateRecord/deleteRecord cek rule sendiri).
function getRecordRaw(
  db: DatabaseSync,
  meta: CollectionMeta,
  collection: string,
  id: string
): ForgeRecord | null {
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
  data: Record<string, unknown>,
  reqCtx?: RequestContext
): ForgeRecord | null {
  const meta = mustGetCollection(db, collection);
  const fmap = fieldMap(meta);
  assertNotView(meta); // M16a: view read-only

  const existing = getRecordRaw(db, meta, collection, id);
  if (!existing) return null;

  // ── M11: updateRule — hanya END USER; record EXISTING harus lolos ──
  const uRule = ruleFor(meta, 'updateRule');
  if (reqCtx !== undefined) {
    if (uRule === null) {
      throw new ForbiddenError();
    }
    if (uRule.trim() !== '' && !evaluateRuleOnData(uRule, existing as Record<string, unknown>, reqCtx)) {
      throw new ForbiddenError();
    }
  }

  // ── M14: simpan file baru yang di-upload via multipart & hapus yang diganti ──
  // data di sini bisa mengandung nama file tersimpan (dari multipartToRecordData)
  // atau file lama yang tetap dipakai — cleanupReplacedFiles membandingkan.

  // Validasi & bangun SET clause
  const setClauses: string[] = [`"updated" = strftime('%Y-%m-%dT%H:%M:%fZ','now')`];
  const params: unknown[] = [];

  const now = new Date().toISOString();

  // B1: autodate dengan onUpdate → perbarui otomatis
  for (const field of meta.fields) {
    if (field.type === 'autodate' && field.options?.onUpdate) {
      setClauses.push(`"${field.name}" = ?`);
      params.push(now);
    }
  }

  for (const [key, value] of Object.entries(data)) {
    const field = fmap.get(key);
    if (!field) {
      throw new Error(`Field '${key}' tidak ada di collection '${collection}'`);
    }
    // B1: autodate dikelola sistem — abaikan nilai dari user
    if (field.type === 'autodate') continue;

    const err = validateValue(field, value);
    if (err) throw new Error(err);

    setClauses.push(`"${key}" = ?`);
    params.push(serializeValue(field, value));
  }

  // ── M14: hapus file lama yang DIGANTI (sebelum UPDATE — kalau UPDATE gagal,
  // file sudah hilang... jadi urutan aman: UPDATE dulu, baru hapus file) ──
  // Catatan arsitektur: cleanup dilakukan oleh API layer setelah sukses
  // (lihat publicRoutes) karena core tidak tahu projectId.

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

// D3: Error khusus saat penghapusan ditolak oleh restrict
export class RestrictError extends Error {
  constructor(
    public referencingCollection: string,
    public referencingField: string,
    public count: number
  ) {
    super(
      `Tidak bisa menghapus: masih ada ${count} record di '${referencingCollection}.${referencingField}' yang merujuk (restrict)`
    );
    this.name = 'RestrictError';
  }
}

// Mencari semua field relation di SEMUA collection yang menunjuk ke
// collection tertentu. Ini kebalikan arah relasi: bukan "record ini menunjuk
// ke mana", melainkan "siapa yang menunjuk ke sini".
interface ReferencingField {
  collection: string;
  field: FieldDefinition;
}

function findReferencingFields(db: DatabaseSync, targetCollection: string): ReferencingField[] {
  const result: ReferencingField[] = [];
  for (const meta of listCollections(db)) {
    for (const field of meta.fields) {
      if (field.type === 'relation' && field.options?.collectionId === targetCollection) {
        result.push({ collection: meta.name, field });
      }
    }
  }
  return result;
}

// Helper: normalisasi nilai multi jadi array (untuk cek referensi)
function idsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === 'string');
  if (typeof value === 'string' && value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      return [];
    }
  }
  return [];
}

export function deleteRecord(
  db: DatabaseSync,
  collection: string,
  id: string,
  reqCtx?: RequestContext
): boolean {
  const meta = mustGetCollection(db, collection);
  assertNotView(meta); // M16a: view read-only

  // ── M11: deleteRule — hanya END USER; record harus ada & lolos rule ──
  const record = getRecordRaw(db, meta, collection, id);
  if (!record) return false;

  const dRule = ruleFor(meta, 'deleteRule');
  if (reqCtx !== undefined) {
    if (dRule === null) {
      throw new ForbiddenError();
    }
    if (dRule.trim() !== '' && !evaluateRuleOnData(dRule, record as Record<string, unknown>, reqCtx)) {
      throw new ForbiddenError();
    }
  }

  // ── D3: Tangani record lain yang merujuk ke record ini ──
  // Semua dibungkus SATU transaksi: kalau ada restrict yang melarang,
  // tidak ada SATUPUN perubahan yang terjadi (atomik — M07!).
  const referencingFields = findReferencingFields(db, collection);

  db.exec('BEGIN');
  try {
    for (const { collection: refCol, field } of referencingFields) {
      const strategy = field.options?.cascadeDelete ?? 'setNull';
      const isMulti = (field.options?.maxSelect ?? 1) > 1;

      // Ambil semua record di collection perujuk (kita periksa satu per satu
      // apakah merujuk ke id yang mau dihapus)
      const rows = db
        .prepare(`SELECT id, "${field.name}" AS refval FROM "${refCol}"`)
        .all() as { id: string; refval: unknown }[];

      for (const row of rows) {
        let refers = false;
        if (isMulti) {
          refers = idsOf(row.refval).includes(id);
        } else {
          refers = row.refval === id;
        }
        if (!refers) continue;

        // Record ini merujuk ke yang mau dihapus → terapkan strategi
        if (strategy === 'restrict') {
          // Hitung berapa banyak yang merujuk (untuk pesan error)
          const count = rows.filter((r) =>
            isMulti ? idsOf(r.refval).includes(id) : r.refval === id
          ).length;
          throw new RestrictError(refCol, field.name, count);
        }

        if (strategy === 'cascade') {
          // Hapus record anak ini juga
          db.prepare(`DELETE FROM "${refCol}" WHERE id = ?`).run(row.id);
        }

        if (strategy === 'setNull') {
          if (isMulti) {
            // Multi: hapus HANYA id ini dari array, sisakan yang lain
            const remaining = idsOf(row.refval).filter((x) => x !== id);
            db.prepare(`UPDATE "${refCol}" SET "${field.name}" = ? WHERE id = ?`).run(
              JSON.stringify(remaining),
              row.id
            );
          } else {
            // Single: kosongkan field relasinya
            db.prepare(`UPDATE "${refCol}" SET "${field.name}" = NULL WHERE id = ?`).run(row.id);
          }
        }
      }
    }

    // Setelah semua rujukan ditangani, baru hapus record aslinya
    const result = db.prepare(`DELETE FROM "${collection}" WHERE id = ?`).run(id);

    db.exec('COMMIT');

    return result.changes > 0;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
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
  let whereParts: string[] = [];
  const params: unknown[] = [];

  // ── M11: listRule — rule jadi WHERE TAMBAHAN sebelum filter user ──
  // Urutan penting: rule dulu (keamanan), filter user belakangan.
  // Hanya END USER (reqCtx !== undefined) — admin bypass.
  const lRule = ruleFor(meta, 'listRule');
  if (options.reqCtx !== undefined) {
    if (lRule === null) {
      // End user + admin-only → tidak ada baris sama sekali
      return { page, perPage, totalItems: 0, totalPages: 1, items: [] };
    }
    if (lRule.trim() !== '') {
      const decided = decideRule(lRule, options.reqCtx, meta.fields);
      if (decided.mode === 'filter' && decided.sql) {
        whereParts.push(`(${decided.sql})`);
        params.push(...(decided.params ?? []));
      }
      // mode 'public' tidak menambah apa-apa
    }
  }

  if (options.filter && options.filter.trim().length > 0) {
    const { where, params: filterParams } = filterToSql(options.filter, meta.fields, options.reqCtx);
    whereParts.push(`(${where})`);
    params.push(...filterParams);
  }

  const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  // ── M17b: full-text search (FTS5) ──
  // Hanya aktif kalau collection punya field options.fulltext (ada FTS table).
  // search user di-sanitasi (quote per token + prefix terakhir).
  let fromClause = `"${collection}"`;
  const searchParams: unknown[] = [];
  const ftsCols = meta.type === 'base' ? ftsFields(meta) : null;
  if (options.search && options.search.trim() !== '' && ftsCols) {
    const ftsQuery = sanitizeFtsQuery(options.search);
    if (ftsQuery === '') {
      // search kosong setelah sanitasi → hasil kosong (konsisten filter tak cocok)
      return { page, perPage, totalItems: 0, totalPages: 1, items: [] };
    }
    fromClause = `"${collection}" JOIN "${ftsTableName(collection)}" ON "${collection}"."id" = "${ftsTableName(collection)}"."record_id"`;
    whereParts.push(`"${ftsTableName(collection)}" MATCH ?`);
    searchParams.push(ftsQuery);
  }
  const whereSqlFts = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  // ── ORDER BY dari sort ──
  // M16a: view tidak menjamin punya kolom created — deteksi dari fields meta
  // (fields view = kolom hasil SELECT; field sistem 'created' hanya ada
  // kalau query-nya memilihnya). buildOrderBy validasi terhadap fields+sys.
  const isView = meta.type === 'view';
  const hasCreated = !isView || meta.fields.some((f) => f.name === 'created');
  let orderSql = hasCreated ? 'ORDER BY "created" DESC' : '';
  if (options.sort && options.sort.trim().length > 0) {
    orderSql = 'ORDER BY ' + buildOrderBy(options.sort, meta);
  }

  // ── Hitung total (untuk pagination) ──
  // M17b: pakai whereSqlFts (sudah termasuk MATCH) + fromClause (join FTS)
  // URUTAN PARAM: params dulu (rule/filter — whereParts awal), search belakangan
  // (MATCH push dilakukan SETELAH rule/filter pada whereParts).
  const countRow = db
    .prepare(`SELECT COUNT(*) AS n FROM ${fromClause} ${whereSqlFts}`)
    .get(...([...params, ...searchParams] as never[])) as { n: number };
  const totalItems = countRow.n;
  const totalPages = Math.max(1, Math.ceil(totalItems / perPage));

  // ── Ambil halaman yang diminta ──
  const offset = (page - 1) * perPage;
  const rows = db
    .prepare(`SELECT "${collection}".* FROM ${fromClause} ${whereSqlFts} ${orderSql} LIMIT ? OFFSET ?`)
    .all(...([...params, ...searchParams, perPage, offset] as never[])) as Record<string, unknown>[];

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
  // M16a: view hanya punya kolom hasil SELECT (tanpa field sistem otomatis)
  const validNames =
    meta.type === 'view'
      ? new Set(meta.fields.map((f) => f.name))
      : new Set([...meta.fields.map((f) => f.name), 'id', 'created', 'updated']);

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
