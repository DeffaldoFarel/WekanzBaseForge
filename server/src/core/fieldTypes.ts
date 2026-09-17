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
  | 'password'  // M16b: hash-only field (never returned)
  | 'vector';   // M29: embedding array (JSON storage, similarity search)

export interface FieldDefinition {
  name: string;
  type: FieldType;
  required?: boolean;
  /** D1: field harus unik (tidak boleh duplikat) — ditegakkan oleh UNIQUE INDEX */
  unique?: boolean;
  options?: {
    // text
    min?: number;
    max?: number;
    pattern?: string;
    fulltext?: boolean;
    // number
    noDecimal?: boolean;
    // select
    values?: string[];
    maxSelect?: number;
    // relation
    collectionId?: string;
    cascadeDelete?: 'cascade' | 'setNull' | 'restrict';
    // file
    mimeTypes?: string[];
    maxSize?: number;
    thumbs?: string[];
    protected?: boolean;
    // autodate
    onCreate?: boolean;
    onUpdate?: boolean;
    // email & url
    onlyDomains?: string[];
    exceptDomains?: string[];
    // password
    cost?: number;
    // vector (M29)
    dimensions?: number;
  };
}

// ─── Validasi nama — PERTAHANAN KEAMANAN PERTAMA ────────────────────────────
//
// KENAPA PENTING: nama collection dan nama field akan disisipkan LANGSUNG
// ke dalam string SQL (CREATE TABLE <nama> ...). Parameter binding (?)
// TIDAK BISA dipakai untuk nama tabel/kolom — hanya untuk nilai!
//
// Jadi satu-satunya pertahanan terhadap SQL injection di nama adalah:
// validasi ketat. Huruf, angka, underscore. Titik.
//
// M21: huruf KAPITAL diizinkan (sebelumnya hanya a-z). Alasannya: skema dunia
// nyata memakai camelCase (userId, namaTagihan, dueDate) — menolaknya memaksa
// rename massal di sisi klien. Ketatnya validasi TIDAK berkurang: tetap wajib
// diawali huruf, tetap hanya alfanumerik + underscore, tetap tanpa spasi,
// tanda kutip, titik koma, atau tanda hubung. Huruf kapital tidak punya makna
// khusus di SQL sehingga permukaan serangan tidak bertambah.
//
// PENTING: SQLite membandingkan nama kolom secara CASE-INSENSITIVE
// (CREATE TABLE t ("userId" TEXT, "userid" TEXT) → "duplicate column name").
// Karena itu pengecekan duplikat dan pengecekan nama sistem WAJIB memakai
// perbandingan case-insensitive — lihat isReservedFieldName() di bawah.

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

export function isValidName(name: string): boolean {
  return NAME_PATTERN.test(name) && name.length <= 64;
}

/**
 * M21: field sistem tidak boleh ditimpa user.
 * Case-insensitive karena SQLite menganggap "ID" dan "id" kolom yang sama —
 * menolak hanya huruf kecil akan meloloskan 'ID' lalu gagal sebagai 500.
 */
export const SYSTEM_FIELD_NAMES = ['id', 'created', 'updated'] as const;

export function isReservedFieldName(name: string): boolean {
  return SYSTEM_FIELD_NAMES.includes(name.toLowerCase() as (typeof SYSTEM_FIELD_NAMES)[number]);
}

/**
 * M21: mencari nama yang bentrok secara case-insensitive.
 * Mengembalikan pasangan pertama yang bertabrakan, atau null bila aman.
 */
export function findDuplicateName(names: string[]): { first: string; second: string } | null {
  const seen = new Map<string, string>();
  for (const n of names) {
    const key = n.toLowerCase();
    const prev = seen.get(key);
    if (prev !== undefined) return { first: prev, second: n };
    seen.set(key, n);
  }
  return null;
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
    throw new Error(`Invalid field name: '${field.name}' (only a-z, 0-9, _, must start with a letter)`);
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
    case 'vector':
      // M29: embedding array — disimpan sebagai TEXT JSON `[0.1, 0.2, ...]`.
      // Brute-force search di JS; swap ke sqlite-vec = kolom tetap JSON
      // (vec0 virtual table dibuat terpisah oleh migration).
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
    case 'text': {
      if (typeof value !== 'string') return `Field '${field.name}' must be a string`;
      const min = field.options?.min;
      if (typeof min === 'number' && value.length < min) {
        return `Field '${field.name}' must be at least ${min} characters (got ${value.length})`;
      }
      const max = field.options?.max;
      if (typeof max === 'number' && value.length > max) {
        return `Field '${field.name}' must be at most ${max} characters (got ${value.length})`;
      }
      const pattern = field.options?.pattern;
      if (pattern) {
        try {
          const re = new RegExp(pattern);
          if (!re.test(value)) {
            return `Field '${field.name}' does not match the regex pattern /${pattern}/`;
          }
        } catch {
          // ignore pattern regex error
        }
      }
      return null;
    }
    case 'date': {
      if (typeof value !== 'string') return `Field '${field.name}' must be a date string`;
      return null;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value))
        return `Field '${field.name}' must be a finite number`;
      const min = field.options?.min;
      if (typeof min === 'number' && value < min) {
        return `Field '${field.name}' must be >= ${min} (got ${value})`;
      }
      const max = field.options?.max;
      if (typeof max === 'number' && value > max) {
        return `Field '${field.name}' must be <= ${max} (got ${value})`;
      }
      if (field.options?.noDecimal && !Number.isInteger(value)) {
        return `Field '${field.name}' must be an integer (noDecimal)`;
      }
      return null;
    }
    case 'bool':
      if (typeof value !== 'boolean') return `Field '${field.name}' must be a boolean`;
      return null;
    case 'email': {
      if (typeof value !== 'string') return `Field '${field.name}' must be a string`;
      // Regex email sederhana (validasi penuh itu notoriously sulit!)
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
        return `Field '${field.name}' must be a valid email`;
      const domain = value.split('@')[1]?.toLowerCase();
      if (domain) {
        const only = field.options?.onlyDomains;
        if (Array.isArray(only) && only.length > 0 && !only.includes(domain)) {
          return `Email domain '${domain}' is not allowed (allowed: ${only.join(', ')})`;
        }
        const except = field.options?.exceptDomains;
        if (Array.isArray(except) && except.length > 0 && except.includes(domain)) {
          return `Domain email '${domain}' dilarang`;
        }
      }
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
        const host = u.hostname.toLowerCase();
        const only = field.options?.onlyDomains;
        if (Array.isArray(only) && only.length > 0 && !only.includes(host)) {
          return `URL host '${host}' is not allowed (allowed: ${only.join(', ')})`;
        }
        const except = field.options?.exceptDomains;
        if (Array.isArray(except) && except.length > 0 && except.includes(host)) {
          return `Host URL '${host}' dilarang`;
        }
        return null;
      } catch {
        return `Field '${field.name}' must be a valid URL`;
      }
    }
    case 'select': {
      const allowed = field.options?.values ?? [];
      const maxSelect = field.options?.maxSelect ?? 1;
      const isMulti = maxSelect > 1;

      if (isMulti) {
        if (!Array.isArray(value)) {
          return `Field '${field.name}' must be an array (multi-select)`;
        }
        if (value.length > maxSelect) {
          return `Field '${field.name}' exceeds maxSelect ${maxSelect} (got ${value.length})`;
        }
        for (const item of value) {
          if (typeof item !== 'string' || (allowed.length > 0 && !allowed.includes(item))) {
            return `Value '${item}' is not valid (allowed: ${allowed.join(', ')})`;
          }
        }
        return null;
      }

      if (typeof value !== 'string') return `Field '${field.name}' must be a string`;
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
        return `Field '${field.name}'.lat must be between -90 and 90 (got ${geo.lat})`;
      }
      if (geo.lng < -180 || geo.lng > 180) {
        return `Field '${field.name}'.lng must be between -180 and 180 (got ${geo.lng})`;
      }
      return null;
    }
    case 'password': {
      // M16b: input = password plain dari user (akan di-hash saat serialize).
      // Validasi kekuatan minimum di sini (hash dilakukan di records.ts).
      if (typeof value !== 'string') return `Field '${field.name}' must be a string`;
      if (value.length < 8) return `Field '${field.name}' must be at least 8 characters`;
      if (value.length > 128) return `Field '${field.name}' must be at most 128 characters`;
      return null;
    }
    case 'vector': {
      // M29: array of finite numbers — panjang harus sama dengan dimensions.
      // Disimpan sebagai JSON string di kolom TEXT (SQLite-native approach);
      // swap ke sqlite-vec binary saat tersedia = zero API change.
      if (!Array.isArray(value)) {
        return `Field '${field.name}' must be an array of numbers (embedding vector)`;
      }
      const dims = field.options?.dimensions;
      if (dims && value.length !== dims) {
        return `Field '${field.name}' must have exactly ${dims} dimensions (got ${value.length})`;
      }
      if (value.length === 0 || value.length > 4096) {
        return `Field '${field.name}' vector length must be between 1 and 4096`;
      }
      for (const v of value) {
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          return `Field '${field.name}' must contain only finite numbers`;
        }
      }
      return null;
    }
    default:
      return `Unknown type for field '${field.name}'`;
  }
}
