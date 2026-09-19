// ============================================================================
// Ops-16 — Custom profile field untuk `_auth_users`
//
// Paritas Supabase, versi TERVALIDASI: admin mendefinisikan skema (nama, tipe,
// required, user_editable), server memvalidasi nilainya memakai engine field
// yang sudah ada (`core/fieldTypes.ts`), dan nilainya disimpan sebagai KOLOM SQL
// asli di `_auth_users` — bukan blob JSON. Konsekuensinya bisa di-index,
// bisa di-query, dan bisa dipakai di API rules.
//
// Perbandingan dengan Supabase:
//   user_metadata  → JSON bebas, bisa diubah user sendiri, TANPA validasi
//   app_metadata   → JSON bebas, read-only bagi user
//   Ops-16         → kolom SQL tervalidasi + flag `user_editable` yang memisahkan
//                    keduanya, tanpa kehilangan validasi
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import {
  validateValue,
  isValidName,
  isReservedFieldName,
  type FieldDefinition,
  type FieldType,
} from '../core/fieldTypes.js';

/** Tipe field yang MASUK AKAL untuk profil user. */
const ALLOWED_PROFILE_TYPES: FieldType[] = [
  'text',
  'number',
  'bool',
  'email',
  'url',
  'date',
  'select',
  'json',
];

/**
 * Nama yang tidak boleh dipakai sebagai custom field: kolom sistem `_auth_users`
 * plus alias yang dipakai di respons API. Case-insensitive karena SQLite
 * menganggap "Email" dan "email" kolom yang SAMA — menolak hanya huruf kecil
 * akan meloloskan 'Email' lalu gagal sebagai 500 saat ALTER TABLE.
 */
const RESERVED_AUTH_COLUMNS = [
  'id',
  'email',
  'password_hash',
  'name',
  'avatar_url',
  'avatarurl',
  'verified',
  'disabled',
  'created',
  'updated',
  'profile',
  'mfaenabled',
];

export interface AuthFieldDefinition {
  name: string;
  type: FieldType;
  required: boolean;
  /**
   * `true`  → user boleh mengubahnya sendiri via PATCH /auth/me (≈ user_metadata)
   * `false` → hanya Admin API (≈ app_metadata) — untuk role/tier/quota
   */
  userEditable: boolean;
  options?: FieldDefinition['options'];
  created: string;
}

interface AuthFieldRow {
  name: string;
  type: string;
  required: number;
  user_editable: number;
  options: string | null;
  created: string;
}

export function initAuthFieldsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _auth_fields (
      name          TEXT PRIMARY KEY,
      type          TEXT NOT NULL,
      required      INTEGER NOT NULL DEFAULT 0,
      user_editable INTEGER NOT NULL DEFAULT 1,
      options       TEXT,
      created       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
}

function rowToAuthField(row: AuthFieldRow): AuthFieldDefinition {
  return {
    name: row.name,
    type: row.type as FieldType,
    required: row.required === 1,
    userEditable: row.user_editable === 1,
    options: row.options ? (JSON.parse(row.options) as FieldDefinition['options']) : undefined,
    created: row.created,
  };
}

export function listAuthFields(db: DatabaseSync): AuthFieldDefinition[] {
  initAuthFieldsTable(db);
  const rows = db
    .prepare('SELECT * FROM _auth_fields ORDER BY created ASC')
    .all() as unknown as AuthFieldRow[];
  return rows.map(rowToAuthField);
}

/** Bentuk `FieldDefinition` agar bisa dioper ke `validateValue` yang sudah ada. */
function toFieldDefinition(f: AuthFieldDefinition): FieldDefinition {
  return { name: f.name, type: f.type, required: f.required, options: f.options };
}

export class AuthFieldError extends Error {}

/**
 * Menambahkan satu custom field: baris di `_auth_fields` + kolom fisik di
 * `_auth_users`.
 *
 * PENTING — kenapa TIDAK memakai `fieldToSql()`:
 * `fieldToSql` menghasilkan `"bio" TEXT NOT NULL` untuk field required, dan
 * SQLite MENOLAK `ALTER TABLE ADD COLUMN ... NOT NULL` tanpa DEFAULT bila tabel
 * sudah berisi baris ("Cannot add a NOT NULL column with default value NULL" —
 * diverifikasi langsung terhadap node:sqlite). Kolom custom karena itu SELALU
 * ditambahkan nullable; `required` ditegakkan di lapisan aplikasi saat register.
 * Ini juga yang membuat penambahan field aman bagi user yang sudah terdaftar.
 */
export function defineAuthField(
  db: DatabaseSync,
  def: {
    name: string;
    type: FieldType;
    required?: boolean;
    userEditable?: boolean;
    options?: FieldDefinition['options'];
  }
): AuthFieldDefinition {
  initAuthFieldsTable(db);

  if (!isValidName(def.name)) {
    throw new AuthFieldError(
      `Invalid field name '${def.name}' (letters, digits, underscore; must start with a letter; max 64 chars)`
    );
  }
  if (isReservedFieldName(def.name) || RESERVED_AUTH_COLUMNS.includes(def.name.toLowerCase())) {
    throw new AuthFieldError(`Field name '${def.name}' is reserved`);
  }
  if (!ALLOWED_PROFILE_TYPES.includes(def.type)) {
    throw new AuthFieldError(
      `Field type '${def.type}' is not supported for profiles (allowed: ${ALLOWED_PROFILE_TYPES.join(', ')})`
    );
  }

  // Duplikat case-insensitive: SQLite menganggap "Bio" dan "bio" kolom yang sama.
  const existing = listAuthFields(db);
  if (existing.some((f) => f.name.toLowerCase() === def.name.toLowerCase())) {
    throw new AuthFieldError(`Field '${def.name}' already exists`);
  }

  const cols = db
    .prepare('PRAGMA table_info(_auth_users)')
    .all() as unknown as { name: string }[];
  const columnExists = cols.some((c) => c.name.toLowerCase() === def.name.toLowerCase());

  // Kolom fisik: SELALU nullable (lihat catatan di docblock).
  if (!columnExists) {
    const sqlType = def.type === 'number' ? 'REAL' : def.type === 'bool' ? 'INTEGER' : 'TEXT';
    db.exec(`ALTER TABLE _auth_users ADD COLUMN "${def.name}" ${sqlType}`);
  }

  db.prepare(
    'INSERT INTO _auth_fields (name, type, required, user_editable, options) VALUES (?, ?, ?, ?, ?)'
  ).run(
    def.name,
    def.type,
    def.required ? 1 : 0,
    def.userEditable === false ? 0 : 1,
    def.options ? JSON.stringify(def.options) : null
  );

  const created = db
    .prepare('SELECT * FROM _auth_fields WHERE name = ?')
    .get(def.name) as unknown as AuthFieldRow;
  return rowToAuthField(created);
}

/**
 * Menghapus definisi field. Kolom fisiknya ikut di-DROP (SQLite mendukung
 * ALTER TABLE DROP COLUMN — diverifikasi) sehingga tidak meninggalkan data
 * yatim yang tak terjangkau API namun tetap ada di disk.
 */
export function deleteAuthField(db: DatabaseSync, name: string): boolean {
  initAuthFieldsTable(db);
  const result = db.prepare('DELETE FROM _auth_fields WHERE name = ?').run(name);
  if (result.changes === 0) return false;

  try {
    db.exec(`ALTER TABLE _auth_users DROP COLUMN "${name}"`);
  } catch {
    // Kolom mungkin sudah tidak ada (mis. dihapus manual). Definisinya sudah
    // terhapus — itu yang menentukan visibilitas lewat API.
  }
  return true;
}

export type ProfileValues = Record<string, unknown>;

/**
 * Memvalidasi objek `profile` dari klien terhadap definisi yang tersimpan.
 *
 * @param mode  'register' → `required` DITEGAKKAN (field wajib harus terisi)
 *              'update'   → `required` TIDAK ditegakkan; hanya field yang
 *                           DIKIRIM yang divalidasi (partial update).
 *
 * Kenapa `required` tidak berlaku saat update: menambahkan field required ke
 * project yang sudah punya user membuat semua baris lama bernilai NULL. Kalau
 * PATCH menegakkan required, user lama tidak bisa mengubah namanya sendiri
 * hanya karena ada field baru yang belum pernah mereka isi.
 *
 * @returns pesan error pertama, atau null bila valid.
 */
export function validateProfileValues(
  fields: AuthFieldDefinition[],
  values: ProfileValues,
  mode: 'register' | 'update'
): string | null {
  const byName = new Map(fields.map((f) => [f.name, f]));

  for (const key of Object.keys(values)) {
    if (!byName.has(key)) {
      return `Unknown profile field '${key}'`;
    }
  }

  if (mode === 'register') {
    for (const f of fields) {
      if (f.required && (values[f.name] === undefined || values[f.name] === null)) {
        return `Field '${f.name}' is required`;
      }
    }
  }

  for (const [key, value] of Object.entries(values)) {
    const f = byName.get(key)!;
    // Pada update, null berarti "kosongkan" — sah untuk field opsional.
    if (value === null && mode === 'update') {
      if (f.required) return `Field '${f.name}' cannot be set to null`;
      continue;
    }
    const err = validateValue(toFieldDefinition(f), value);
    if (err) return err;
  }

  return null;
}

/** Mengubah nilai profil menjadi bentuk yang bisa disimpan SQLite. */
export function toStorageValue(field: AuthFieldDefinition, value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (field.type === 'bool') return value ? 1 : 0;
  if (field.type === 'number') return Number(value);
  if (field.type === 'json') return JSON.stringify(value);
  return String(value);
}

/** Kebalikan `toStorageValue` — dipakai saat membaca row menjadi respons API. */
export function fromStorageValue(field: AuthFieldDefinition, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (field.type === 'bool') return value === 1 || value === true;
  if (field.type === 'number') return Number(value);
  if (field.type === 'json') {
    try {
      return JSON.parse(String(value));
    } catch {
      return null;
    }
  }
  return value;
}

/**
 * Mengambil objek `profile` dari row `_auth_users` mentah.
 *
 * KEAMANAN: hanya kolom yang TERDAFTAR di `_auth_fields` yang dikembalikan.
 * `SELECT * FROM _auth_users` membawa SEMUA kolom — termasuk `password_hash`
 * dan kolom apa pun yang pernah ditambahkan lalu definisinya dihapus. Memfilter
 * lewat daftar definisi (bukan menyebar row) adalah yang mencegah kebocoran;
 * ini alasan yang sama dengan `password_hash` yang selalu di-strip.
 *
 * @returns objek profil, atau `undefined` bila tidak ada field terdefinisi sama
 *          sekali — sehingga respons API tetap BYTE-IDENTICAL dengan sebelum
 *          Ops-16 untuk project yang tidak memakai fitur ini.
 */
export function extractProfile(
  fields: AuthFieldDefinition[],
  row: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (fields.length === 0) return undefined;
  const profile: Record<string, unknown> = {};
  for (const f of fields) {
    profile[f.name] = fromStorageValue(f, row[f.name]);
  }
  return profile;
}
