// ============================================================================
// M03: FIELD TYPES — definisi tipe field dan penerjemahannya ke SQL
//
// Inilah "kamus" antara dunia user (tipe yang ramah: text, number, bool)
// dan dunia SQLite (TEXT, REAL, INTEGER). Mapping ini adalah jantung dari
// SQL generation: user berkata 'number', kita menulis 'REAL'.
// ============================================================================

// ─── Definisi field (yang disimpan user di _collections) ────────────────────

export type FieldType =
  | 'text'
  | 'number'
  | 'bool'
  | 'email'
  | 'date'
  | 'json'
  | 'relation';

export interface FieldDefinition {
  name: string;
  type: FieldType;
  required?: boolean;
  /** D1: field harus unik (tidak boleh duplikat) — ditegakkan oleh UNIQUE INDEX */
  unique?: boolean;
  // Untuk type 'relation': collection tujuan (detail di M12)
  options?: {
    collectionId?: string;
    maxSelect?: number;
  };
}

// ─── Validasi nama — PERTAHANAN KEAMANAN PERTAMA ────────────────────────────
//
// KENAPA PENTING: nama collection dan nama field akan disisipkan LANGSUNG
// ke dalam string SQL (CREATE TABLE <nama> ...). Parameter binding (?)
// TIDAK BISA dipakai untuk nama tabel/kolom — hanya untuk nilai!
//
// Jadi satu-satunya pertahanan terhadap SQL injection di nama adalah:
// validasi ketat. Hanya huruf kecil, angka, underscore. Titik.
// PocketBase melakukan hal yang persis sama.

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

export function isValidName(name: string): boolean {
  return NAME_PATTERN.test(name) && name.length <= 64;
}

// Nama yang diawali underscore = tabel SISTEM (seperti _collections).
// User tidak boleh membuatnya — konvensi yang sama dengan PocketBase.
export function isSystemName(name: string): boolean {
  return name.startsWith('_');
}

// ─── Mapping tipe → SQL ─────────────────────────────────────────────────────

/**
 * Menerjemahkan satu field definition menjadi potongan SQL kolom.
 * Contoh:
 *   { name: 'title', type: 'text', required: true }
 *   → `"title" TEXT NOT NULL`
 *
 *   { name: 'streak', type: 'number' }
 *   → `"streak" REAL`
 */
export function fieldToSql(field: FieldDefinition): string {
  if (!isValidName(field.name)) {
    throw new Error(`Invalid field name: '${field.name}' (hanya a-z, 0-9, _, diawali huruf)`);
  }

  const notNull = field.required ? ' NOT NULL' : '';
  // Nama kolom selalu dibungkus double-quote: pengaman tambahan walau
  // sudah divalidasi (defense in depth).
  const col = `"${field.name}"`;

  switch (field.type) {
    case 'text':
      return `${col} TEXT${notNull}`;
    case 'number':
      // SQLite tidak punya INT vs FLOAT yang ketat — REAL menampung keduanya
      return `${col} REAL${notNull}`;
    case 'bool':
      // SQLite tidak punya BOOLEAN — disimpan sebagai 0/1
      return `${col} INTEGER NOT NULL DEFAULT 0`;
    case 'email':
      return `${col} TEXT${notNull}`;
    case 'date':
      // Disimpan sebagai TEXT ISO 8601 ('2026-09-11T10:30:00.000Z')
      // SQLite membandingkannya dengan benar secara leksikografis!
      return `${col} TEXT${notNull}`;
    case 'json':
      // Disimpan sebagai TEXT berisi JSON string
      return `${col} TEXT${notNull}`;
    case 'relation':
      // Menyimpan id record dari collection lain (detail di M12)
      return `${col} TEXT${notNull}`;
    default:
      throw new Error(`Unknown field type: ${field.type}`);
  }
}

// ─── Validasi nilai terhadap tipe (untuk INSERT/UPDATE nanti di M05) ────────
// Schema menegakkan bentuk data — sama seperti yang kita lihat di M02
// saat SQLite menolak NULL. Di sini kita menambah lapisan validasi
// aplikasi SEBELUM data sampai ke SQL.

export function validateValue(field: FieldDefinition, value: unknown): string | null {
  // Mengembalikan pesan error (string) kalau tidak valid, null kalau valid.

  if (value === null || value === undefined) {
    return field.required ? `Field '${field.name}' is required` : null;
  }

  switch (field.type) {
    case 'text':
    case 'date':
      if (typeof value !== 'string') return `Field '${field.name}' must be a string`;
      return null;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value))
        return `Field '${field.name}' must be a finite number`;
      return null;
    case 'bool':
      if (typeof value !== 'boolean') return `Field '${field.name}' must be a boolean`;
      return null;
    case 'email': {
      if (typeof value !== 'string') return `Field '${field.name}' must be a string`;
      // Regex email sederhana (validasi penuh itu notoriously sulit!)
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
        return `Field '${field.name}' must be a valid email`;
      return null;
    }
    case 'json':
      // Apapun boleh, asal bisa di-serialize
      try {
        JSON.stringify(value);
        return null;
      } catch {
        return `Field '${field.name}' must be JSON-serializable`;
      }
    case 'relation':
      if (typeof value !== 'string') return `Field '${field.name}' must be a record id (string)`;
      return null;
    default:
      return `Unknown type for field '${field.name}'`;
  }
}
