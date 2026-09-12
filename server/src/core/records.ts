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
  data: Record<string, unknown>,
  reqCtx?: RequestContext
): ForgeRecord {
  const meta = mustGetCollection(db, collection);
  const fmap = fieldMap(meta);

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
  const id = generateId();
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
