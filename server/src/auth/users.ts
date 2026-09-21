// ============================================================================
// M08: AUTH USERS — tabel _auth_users per project
//
// Ini adalah "users" untuk AUTH (bukan collection biasa!) — mirip koleksi
// "users" khusus di PocketBase. Karena auth adalah layanan khusus dengan
// kebutuhan khusus (email unique, password hash), tabelnya dikelola sistem
// (underscore = tabel sistem, konvensi dari M03).
//
// Me.LEMAKnikai komponen yang sudah ada:
//   - D1 unique constraint → email tidak bisa duplikat (ditolak database!)
//   - M03 meta-tables → pola tabel sistem
//   - M00 adminAuth → pola verifikasi + timingSafeEqual
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import { generateId } from '../core/router.js';
import { hashPassword, verifyPassword, validatePasswordStrength } from './password.js';
import {
  listAuthFields,
  extractProfile,
  toStorageValue,
  type ProfileValues,
} from './authFields.js';

// ─── Tabel _auth_users (dibuat otomatis per project) ────────────────────────

export function initAuthUsersTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _auth_users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      name          TEXT,
      avatar_url    TEXT,
      verified      INTEGER NOT NULL DEFAULT 0,
      created       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);

  // Index untuk lookup by email (dipakai setiap login — M06!)
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_email
    ON _auth_users (email);
  `);

  // M10: migrasi tabel lama (password_hash NOT NULL → nullable + avatar_url).
  // SQLite tidak punya ALTER COLUMN → rebuild tabel ala D4 (dalam 1 transaksi).
  migrateAuthUsersTable(db);

  // M47: tambah kolom disabled (default 0 = active) bila belum ada.
  migrateAddDisabledColumn(db);
}

/** M47: ALTER TABLE ADD COLUMN disabled — idempotent via PRAGMA check. */
function migrateAddDisabledColumn(db: DatabaseSync): void {
  const cols = db.prepare('PRAGMA table_info(_auth_users)').all() as unknown as { name: string }[];
  if (cols.some((c) => c.name === 'disabled')) return; // sudah ada
  db.exec('ALTER TABLE _auth_users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
}

/**
 * M10 migration: tabel _auth_users versi lama (sebelum OAuth) punya
 * password_hash NOT NULL dan tanpa avatar_url. User OAuth tidak punya
 * password — kolom wajib jadi nullable.
 */
function migrateAuthUsersTable(db: DatabaseSync): void {
  const cols = db
    .prepare('PRAGMA table_info(_auth_users)')
    .all() as unknown as { name: string; notnull: number }[];
  if (cols.length === 0) return; // tabel baru saja dibuat dengan skema terbaru

  const passwordCol = cols.find((c) => c.name === 'password_hash');
  const hasAvatar = cols.some((c) => c.name === 'avatar_url');
  if (passwordCol && passwordCol.notnull === 0 && hasAvatar) return; // sudah mutakhir

  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE _auth_users_m10 (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        name          TEXT,
        avatar_url    TEXT,
        verified      INTEGER NOT NULL DEFAULT 0,
        created       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);
    db.exec(`
      INSERT INTO _auth_users_m10 (id, email, password_hash, name, verified, created, updated)
      SELECT id, email, password_hash, name, verified, created, updated FROM _auth_users
    `);
    db.exec('DROP TABLE _auth_users');
    db.exec('ALTER TABLE _auth_users_m10 RENAME TO _auth_users');
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_email
      ON _auth_users (email);
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ─── Tipe ────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  verified: boolean;
  disabled: boolean;
  created: string;
  updated: string;
  /**
   * Ops-16: custom profile field. HILANG (undefined) bila project belum
   * mendefinisikan satu pun field — menjaga bentuk respons API tetap
   * byte-identical dengan sebelum Ops-16.
   */
  profile?: Record<string, unknown>;
}

interface AuthUserRow {
  id: string;
  email: string;
  password_hash: string | null;
  name: string | null;
  avatar_url: string | null;
  verified: number;
  disabled: number;
  created: string;
  updated: string;
  /**
   * Ops-16: `SELECT *` membawa kolom custom juga. Index signature ini membuat
   * fakta itu eksplisit di tipe — TANPA memberi izin menyebar row ke respons.
   * Hanya kolom yang terdaftar di `_auth_fields` yang boleh keluar (extractProfile).
   */
  [key: string]: unknown;
}

/**
 * Ops-16: `db` diperlukan untuk membaca definisi `_auth_fields`. Field sistem
 * tetap dipetakan SATU PER SATU (bukan spread) — inilah yang mencegah
 * `password_hash` dan kolom tak terdaftar ikut keluar lewat `SELECT *`.
 */
function rowToUser(db: DatabaseSync, row: AuthUserRow): AuthUser {
  const user: AuthUser = {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    verified: row.verified === 1,
    disabled: row.disabled === 1,
    created: row.created,
    updated: row.updated,
  };
  const profile = extractProfile(listAuthFields(db), row as Record<string, unknown>);
  if (profile !== undefined) user.profile = profile;
  return user;
}

// ─── CREATE ──────────────────────────────────────────────────────────────────

export function createAuthUser(
  db: DatabaseSync,
  data: { email: string; password: string; name?: string; profile?: ProfileValues }
): AuthUser {
  // Validasi email format
  if (typeof data.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    throw new Error('Invalid email address');
  }

  // Validasi kekuatan password (M08)
  const policyError = validatePasswordStrength(data.password);
  if (policyError) {
    throw new Error(policyError);
  }

  const id = generateId();
  const passwordHash = hashPassword(data.password);

  // Ops-16: custom profile field ikut di-INSERT pada statement yang SAMA.
  // Dua statement terpisah berarti user bisa tercipta tanpa profilnya bila
  // statement kedua gagal — register harus atomik.
  const fields = listAuthFields(db);
  const profileCols: string[] = [];
  const profileVals: (string | number | null)[] = [];
  if (data.profile) {
    for (const f of fields) {
      if (f.name in data.profile) {
        profileCols.push(`"${f.name}"`);
        profileVals.push(toStorageValue(f, data.profile[f.name]));
      }
    }
  }

  const cols = ['id', 'email', 'password_hash', 'name', ...profileCols];
  const placeholders = cols.map(() => '?').join(', ');

  try {
    db.prepare(
      `INSERT INTO _auth_users (${cols.join(', ')}) VALUES (${placeholders})`
    ).run(id, data.email.toLowerCase(), passwordHash, data.name ?? null, ...profileVals);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // D1-style: UNIQUE constraint → pesan ramah
    if (/UNIQUE constraint failed/i.test(msg)) {
      throw new Error(`Email '${data.email}' is already registered`);
    }
    throw err;
  }

  return findAuthUserById(db, id)!;
}

/**
 * M10: user OAuth — TANPA password (login via provider identity).
 * `verified` mengikuti konfirmasi email provider (Google = email_verified,
 * GitHub = flag verified di /user/emails).
 */
export function createOAuthUser(
  db: DatabaseSync,
  data: { email: string; name: string | null; avatarUrl: string | null; verified: boolean }
): AuthUser {
  if (typeof data.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    throw new Error('Invalid email address from provider');
  }

  const id = generateId();
  try {
    db.prepare(
      `INSERT INTO _auth_users (id, email, password_hash, name, avatar_url, verified)
       VALUES (?, ?, NULL, ?, ?, ?)`
    ).run(id, data.email.toLowerCase(), data.name, data.avatarUrl, data.verified ? 1 : 0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE constraint failed/i.test(msg)) {
      throw new Error(`Email '${data.email}' is already registered`);
    }
    throw err;
  }

  return findAuthUserById(db, id)!;
}

// ─── READ ────────────────────────────────────────────────────────────────────

export function findAuthUserById(db: DatabaseSync, id: string): AuthUser | undefined {
  const row = db
    .prepare('SELECT * FROM _auth_users WHERE id = ?')
    .get(id) as unknown as AuthUserRow | undefined;
  return row ? rowToUser(db, row) : undefined;
}

export function findAuthUserByEmail(db: DatabaseSync, email: string): AuthUser | undefined {
  const row = db
    .prepare('SELECT * FROM _auth_users WHERE email = ?')
    .get(email.toLowerCase()) as unknown as AuthUserRow | undefined;
  return row ? rowToUser(db, row) : undefined;
}

// Diperlukan oleh verify (M09): ambil row TERMASUK password_hash
export function getAuthUserRowByEmail(db: DatabaseSync, email: string): AuthUserRow | undefined {
  return db
    .prepare('SELECT * FROM _auth_users WHERE email = ?')
    .get(email.toLowerCase()) as unknown as AuthUserRow | undefined;
}

// ─── VERIFY PASSWORD (inti login — dipakai penuh di M09) ─────────────────────

/**
 * Memverifikasi kredensial login.
 * Keamanan: pesan error SAMA untuk "email tidak ada" dan "password salah"
 * — supaya attacker tidak bisa mendaftar email mana yang terdaftar
 * (user enumeration).
 *
 * M10: user OAuth punya password_hash NULL → selalu gagal login password
 * (harus login via provider identity-nya).
 */
export function verifyAuthCredentials(
  db: DatabaseSync,
  email: string,
  password: string
): AuthUser | null {
  const row = getAuthUserRowByEmail(db, email);
  if (!row) {
    return null;
  }
  if (!row.password_hash) {
    return null; // user OAuth-only — tidak punya password
  }
  if (!verifyPassword(password, row.password_hash)) {
    return null;
  }
  // Ops-15: kredensial BENAR tapi akun dinonaktifkan admin. Dikembalikan sebagai
  // user dengan disabled=true (bukan null) supaya route bisa menjawab 403
  // USER_DISABLED alih-alih 401 "kredensial salah" yang menyesatkan.
  // Gerbang sesungguhnya ada di issueTokens(); ini lapis kedua + pesan yang jujur.
  return rowToUser(db, row);
}

// ─── LIST (untuk dashboard — tanpa hash!) ────────────────────────────────────

export function listAuthUsers(
  db: DatabaseSync,
  rawPage = 1,
  rawPerPage = 20,
  search?: string
): {
  items: AuthUser[];
  totalItems: number;
  totalPages: number;
  page: number;
  perPage: number;
} {
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const perPage = Number.isFinite(rawPerPage) && rawPerPage >= 1 ? Math.min(500, Math.floor(rawPerPage)) : 20;

  let where = '';
  const params: (string | number)[] = [];
  if (search && search.trim().length > 0) {
    const escaped = search.trim().replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    where = "WHERE (id LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')";
    params.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`);
  }

  const countRow = db.prepare(`SELECT COUNT(*) AS n FROM _auth_users ${where}`).get(...params) as { n: number };
  const totalItems = countRow?.n ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / perPage));
  const offset = (page - 1) * perPage;

  const rows = db
    .prepare(`SELECT * FROM _auth_users ${where} ORDER BY created DESC LIMIT ? OFFSET ?`)
    .all(...params, perPage, offset) as unknown as AuthUserRow[];

  return {
    items: rows.map((r) => rowToUser(db, r)),
    totalItems,
    totalPages,
    page,
    perPage,
  };
}

// ─── M47: VERIFY / DISABLE ────────────────────────────────────────────────────

export function setAuthUserVerified(db: DatabaseSync, id: string, verified: boolean): boolean {
  const result = db
    .prepare("UPDATE _auth_users SET verified = ?, updated = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .run(verified ? 1 : 0, id);
  return result.changes > 0;
}

export function setAuthUserDisabled(db: DatabaseSync, id: string, disabled: boolean): boolean {
  // Kolom disabled ditambahkan via migrasi M47 (ALTER TABLE ADD COLUMN).
  const result = db
    .prepare("UPDATE _auth_users SET disabled = ?, updated = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
    .run(disabled ? 1 : 0, id);

  // Ops-15: pemutusan sesi (revoke refresh token) dilakukan oleh PEMANGGIL di
  // lapisan route (userAdminRoutes) via revokeAllUserTokens dari tokens.ts —
  // bukan di sini, karena tokens.ts sudah mengimpor modul ini (siklus) dan
  // fungsi ini tidak boleh mengulang DDL _auth_tokens. Fungsi ini murni flag.
  return result.changes > 0;
}

// ─── UPDATE PASSWORD ─────────────────────────────────────────────────────────

export function changeAuthUserPassword(
  db: DatabaseSync,
  id: string,
  newPassword: string
): boolean {
  const policyError = validatePasswordStrength(newPassword);
  if (policyError) {
    throw new Error(policyError);
  }

  const hash = hashPassword(newPassword);
  const result = db
    .prepare(
      `UPDATE _auth_users SET password_hash = ?,
       updated = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    )
    .run(hash, id);
  return result.changes > 0;
}

// ─── UPDATE PROFIL SENDIRI (Ops-9: paritas auth collection) ──────────────────

/**
 * Update field profil milik user sendiri (name, avatarUrl).
 *
 * Dipakai `PATCH /api/p/:pid/auth/me` agar surface A punya paritas dengan
 * auth collection (surface B), yang bisa di-update lewat endpoint record biasa.
 * Hanya field yang HADIR di objek update yang ditulis (partial update);
 * `null` bermakna "kosongkan", `undefined`/absen bermakna "jangan sentuh".
 *
 * Email dan password TIDAK bisa diubah lewat sini — keduanya punya jalur
 * sendiri yang menuntut verifikasi (emailRoutes / changeAuthUserPassword).
 */
export function updateAuthUserProfile(
  db: DatabaseSync,
  id: string,
  updates: { name?: string | null; avatarUrl?: string | null; profile?: ProfileValues }
): AuthUser | undefined {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];

  if ('name' in updates) {
    sets.push('name = ?');
    values.push(updates.name ?? null);
  }
  if ('avatarUrl' in updates) {
    sets.push('avatar_url = ?');
    values.push(updates.avatarUrl ?? null);
  }

  // Ops-16: hanya field yang BENAR-BENAR dikirim yang disentuh (partial update,
  // semantik `'x' in obj` dari Ops-9 — field absen ≠ set null).
  if (updates.profile) {
    const fields = listAuthFields(db);
    for (const f of fields) {
      if (f.name in updates.profile) {
        sets.push(`"${f.name}" = ?`);
        values.push(toStorageValue(f, updates.profile[f.name]));
      }
    }
  }

  // Tidak ada field yang diubah → kembalikan state sekarang (idempotent, bukan error).
  if (sets.length === 0) {
    return findAuthUserById(db, id);
  }

  sets.push("updated = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  const result = db
    .prepare(`UPDATE _auth_users SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values, id);

  if (result.changes === 0) return undefined;
  return findAuthUserById(db, id);
}

// ─── DELETE ──────────────────────────────────────────────────────────────────

export function deleteAuthUser(db: DatabaseSync, id: string): boolean {
  const result = db.prepare('DELETE FROM _auth_users WHERE id = ?').run(id);
  return result.changes > 0;
}
