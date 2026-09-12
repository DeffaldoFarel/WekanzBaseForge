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

// ─── Tabel _auth_users (dibuat otomatis per project) ────────────────────────

export function initAuthUsersTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _auth_users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name          TEXT,
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
}

// ─── Tipe ────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  verified: boolean;
  created: string;
  updated: string;
}

interface AuthUserRow {
  id: string;
  email: string;
  password_hash: string;
  name: string | null;
  verified: number;
  created: string;
  updated: string;
}

function rowToUser(row: AuthUserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    verified: row.verified === 1,
    created: row.created,
    updated: row.updated,
  };
}

// ─── CREATE ──────────────────────────────────────────────────────────────────

export function createAuthUser(
  db: DatabaseSync,
  data: { email: string; password: string; name?: string }
): AuthUser {
  // Validasi email format
  if (typeof data.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    throw new Error('Email tidak valid');
  }

  // Validasi kekuatan password (M08)
  const policyError = validatePasswordStrength(data.password);
  if (policyError) {
    throw new Error(policyError);
  }

  const id = generateId();
  const passwordHash = hashPassword(data.password);

  try {
    db.prepare(
      `INSERT INTO _auth_users (id, email, password_hash, name) VALUES (?, ?, ?, ?)`
    ).run(id, data.email.toLowerCase(), passwordHash, data.name ?? null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // D1-style: UNIQUE constraint → pesan ramah
    if (/UNIQUE constraint failed/i.test(msg)) {
      throw new Error(`Email '${data.email}' sudah terdaftar`);
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
  return row ? rowToUser(row) : undefined;
}

export function findAuthUserByEmail(db: DatabaseSync, email: string): AuthUser | undefined {
  const row = db
    .prepare('SELECT * FROM _auth_users WHERE email = ?')
    .get(email.toLowerCase()) as unknown as AuthUserRow | undefined;
  return row ? rowToUser(row) : undefined;
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
  if (!verifyPassword(password, row.password_hash)) {
    return null;
  }
  return rowToUser(row);
}

// ─── LIST (untuk dashboard — tanpa hash!) ────────────────────────────────────

export function listAuthUsers(db: DatabaseSync, page = 1, perPage = 20): {
  items: AuthUser[];
  totalItems: number;
  totalPages: number;
  page: number;
  perPage: number;
} {
  const totalItems = (db.prepare('SELECT COUNT(*) AS n FROM _auth_users').get() as { n: number }).n;
  const totalPages = Math.max(1, Math.ceil(totalItems / perPage));
  const offset = (page - 1) * perPage;

  const rows = db
    .prepare('SELECT * FROM _auth_users ORDER BY created DESC LIMIT ? OFFSET ?')
    .all(perPage, offset) as unknown as AuthUserRow[];

  return {
    items: rows.map(rowToUser),
    totalItems,
    totalPages,
    page,
    perPage,
  };
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

// ─── DELETE ──────────────────────────────────────────────────────────────────

export function deleteAuthUser(db: DatabaseSync, id: string): boolean {
  const result = db.prepare('DELETE FROM _auth_users WHERE id = ?').run(id);
  return result.changes > 0;
}
