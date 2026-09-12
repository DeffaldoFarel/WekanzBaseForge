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
  | 'relation'
  | 'select'    // B1: dropdown pilihan
  | 'autodate'  // B1: timestamp otomatis
  | 'url'       // B1: URL tervalidasi
  | 'file'      // M14: file upload (nama file tersimpan; bytes di disk)
  | 'editor'    // M16b: rich text HTML (read-only di table view dashboard)
  | 'geoPoint'  // M16b: { lat, lng } — validasi range
  | 'password'; // M16b: hash-only field (never returned)

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
    /** D3: strategi saat record tujuan dihapus. Default 'setNull'. */
    cascadeDelete?: 'cascade' | 'setNull' | 'restrict';
    /** B1 (select): daftar nilai yang diizinkan */
    values?: string[];
    /** B1 (autodate) */
    onCreate?: boolean;
    onUpdate?: boolean;
    /** M14 (file): ukuran maksimum file dalam bytes. Default 5 MB. */
    maxSize?: number;
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
    case 'file':
      // M14: menyimpan NAMA file tersimpan (bukan bytes!) — single TEXT,
      // multi TEXT berisi JSON array. File fisik ada di disk.
      return `${col} TEXT${notNull}`;
    case 'editor':
      // M16b: rich text (HTML) — TEXT besar, tidak divalidasi isi (sanitasi
      // dilakukan client saat render — server menyimpan apa adanya)
      return `${col} TEXT${notNull}`;
    case 'geoPoint': {
      // M16b: { lat, lng } disimpan sebagai TEXT JSON — validasi range di
      // validateValue. Bukan kolom terpisah: satu kolom, satu dokumen.
      return `${col} TEXT${notNull}`;
    }
    case 'password':
      // M16b: password END-USER field level (bukan auth users!) —
      // disimpan SEBAGAI HASH scrypt (M08 reuse). Nilai asli tidak pernah
      // tersimpan & tidak pernah dikembalikan (deserialize → undefined).
      return `${col} TEXT${notNull}`;
    case 'select':
    case 'url':
      // B1: disimpan sebagai TEXT, validasi di aplikasi
      return `${col} TEXT${notNull}`;
    case 'autodate':
      // B1: timestamp ISO otomatis (diisi oleh records.ts, bukan user)
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
    case 'url': {
      // B1: validasi format URL http/https
      if (typeof value !== 'string') return `Field '${field.name}' must be a string`;
      try {
        const u = new URL(value);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          return `Field '${field.name}' must be an http/https URL`;
        }
        return null;
      } catch {
        return `Field '${field.name}' must be a valid URL`;
      }
    }
    case 'select': {
      // B1: nilai harus salah satu dari options.values
      if (typeof value !== 'string') return `Field '${field.name}' must be a string`;
      const allowed = field.options?.values ?? [];
      if (allowed.length > 0 && !allowed.includes(value)) {
        return `Field '${field.name}' must be one of: ${allowed.join(', ')}`;
      }
      return null;
    }
    case 'autodate':
      // B1: autodate diisi otomatis oleh sistem — nilai dari user diabaikan/ditolak
      // (di-handle records.ts). Di sini kita hanya terima string atau null.
      if (typeof value !== 'string') return `Field '${field.name}' must be a date string`;
      return null;
    case 'json':
      // Apapun boleh, asal bisa di-serialize
      try {
        JSON.stringify(value);
        return null;
      } catch {
        return `Field '${field.name}' must be JSON-serializable`;
      }
    case 'relation': {
      // D2: bedakan single (string) vs multi (array of strings)
      const maxSelect = field.options?.maxSelect ?? 1;
      const isMulti = maxSelect > 1;

      if (isMulti) {
        // Multi-relation: nilai HARUS array of strings
        if (!Array.isArray(value)) {
          return `Field '${field.name}' must be an array of record ids (multi-relation)`;
        }
        if (value.length > maxSelect) {
          return `Field '${field.name}' exceeds maxSelect ${maxSelect} (dapat ${value.length})`;
        }
        for (const item of value) {
          if (typeof item !== 'string') {
            return `Field '${field.name}' must be an array of record id strings`;
          }
        }
        return null;
      }

      // Single relation: nilai harus string (satu id)
      if (typeof value !== 'string') return `Field '${field.name}' must be a record id (string)`;
      return null;
    }
    case 'file': {
      // M14: nilai field file = nama file TERSIMPAN (string atau array utk multi).
      // File bytes datang terpisah via multipart — tidak pernah lewat JSON.
      const maxSelect = field.options?.maxSelect ?? 1;
      const isMulti = maxSelect > 1;

      const checkOne = (v: unknown): string | null => {
        if (typeof v !== 'string') return `Field '${field.name}' must be a stored filename string`;
        return null;
      };

      if (isMulti) {
        if (!Array.isArray(value)) {
          return `Field '${field.name}' must be an array of filenames (multi-file)`;
        }
        if (value.length > maxSelect) {
          return `Field '${field.name}' exceeds maxSelect ${maxSelect} (dapat ${value.length})`;
        }
        for (const item of value) {
          const err = checkOne(item);
          if (err) return err;
        }
        return null;
      }

      return checkOne(value);
    }
    case 'editor': {
      // M16b: string bebas (HTML/rich text) — boleh kosong jika tidak required
      if (typeof value !== 'string') return `Field '${field.name}' must be a string (rich text)`;
      return null;
    }
    case 'geoPoint': {
      // M16b: { lat, lng } — lat -90..90, lng -180..180
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return `Field '${field.name}' must be an object { lat, lng }`;
      }
      const geo = value as { lat?: unknown; lng?: unknown };
      if (typeof geo.lat !== 'number' || typeof geo.lng !== 'number') {
        return `Field '${field.name}' must have numeric lat and lng`;
      }
      if (geo.lat < -90 || geo.lat > 90) {
        return `Field '${field.name}'.lat harus antara -90 dan 90 (dapat ${geo.lat})`;
      }
      if (geo.lng < -180 || geo.lng > 180) {
        return `Field '${field.name}'.lng harus antara -180 dan 180 (dapat ${geo.lng})`;
      }
      return null;
    }
    case 'password': {
      // M16b: input = password plain dari user (akan di-hash saat serialize).
      // Validasi kekuatan minimum di sini (hash dilakukan di records.ts).
      if (typeof value !== 'string') return `Field '${field.name}' must be a string`;
      if (value.length < 8) return `Field '${field.name}' minimal 8 karakter`;
      if (value.length > 128) return `Field '${field.name}' maksimal 128 karakter`;
      return null;
    }
    default:
      return `Unknown type for field '${field.name}'`;
  }
}
