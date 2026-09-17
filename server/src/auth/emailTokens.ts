// ============================================================================
// M23: EMAIL ACTION TOKENS — token sekali pakai untuk link verifikasi & reset
//
// Pola: sama seperti state OAuth M10 & refresh token M09 —
//   - random 64-hex dibuat server, yang tersimpan di DB hanya SHA-256 hash
//   - SATU KALI PAKAI: consume = DELETE dulu (entah valid atau tidak)
//   - TTL per tujuan: verify = 24 jam, reset = 1 jam
//   - token NEVER EXPIRE tidak di-rotate: setiap request baru = token baru
//     (token lama tetap berlaku sampai termakan/TTL — UX standar PocketBase)
// ============================================================================

import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type EmailTokenPurpose = 'verify' | 'reset' | 'mfa';

export const TOKEN_TTL_MS: Record<EmailTokenPurpose, number> = {
  verify: 24 * 60 * 60 * 1000, // 24 jam
  reset: 60 * 60 * 1000,       // 1 jam
  mfa: 5 * 60 * 1000,          // M27: 5 menit (login challenge)
};

// ─── Tabel _auth_email_tokens (per project) ──────────────────────────────────

export function initEmailTokensTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _auth_email_tokens (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      purpose    TEXT NOT NULL,          -- 'verify' | 'reset'
      expires_at TEXT NOT NULL,
      created    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);

  // 1 user = maksimal 1 token aktif per purpose (request baru MENIMPA lama —
  // anti penumpukan link aktif di inbox)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_email_tokens_user_purpose
    ON _auth_email_tokens (user_id, purpose);
  `);

  // Bersihkan token kedaluwarsa (opportunistic, murah)
  db.prepare('DELETE FROM _auth_email_tokens WHERE expires_at < ?').run(
    new Date().toISOString()
  );
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ─── CREATE ───────────────────────────────────────────────────────────────────

/**
 * Membuat token baru untuk user + purpose. Token lama dengan purpose sama
 * otomatis dihapus (1 link aktif per tujuan per user).
 *
 * @returns token MENTAH (sekali dibaca — hanya keluar via email, tidak di DB)
 */
export function createEmailToken(
  db: DatabaseSync,
  userId: string,
  purpose: EmailTokenPurpose
): string {
  initEmailTokensTable(db);

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS[purpose]).toISOString();

  db.prepare('DELETE FROM _auth_email_tokens WHERE user_id = ? AND purpose = ?').run(userId, purpose);
  db.prepare(
    'INSERT INTO _auth_email_tokens (id, user_id, token_hash, purpose, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(crypto.randomUUID(), userId, hashToken(token), purpose, expiresAt);

  return token;
}

// ─── CONSUME (validasi + penghapusan atomik) ─────────────────────────────────

export interface ConsumedEmailToken {
  userId: string;
  purpose: EmailTokenPurpose;
}

/**
 * Konsumsi token: cocokkan hash, cek purpose + TTL, lalu HAPUS.
 * "Selalu delete" (valid atau tidak) — anti replay, pola M10.
 */
export function consumeEmailToken(
  db: DatabaseSync,
  token: string,
  purpose: EmailTokenPurpose
): ConsumedEmailToken | null {
  initEmailTokensTable(db);

  const tokenHash = hashToken(token);
  const row = db
    .prepare('SELECT * FROM _auth_email_tokens WHERE token_hash = ?')
    .get(tokenHash) as
    | { id: string; user_id: string; purpose: string; expires_at: string }
    | undefined;

  // Selalu hapus (anti replay — pemakaian kedua kalau otomatis gagal)
  if (row) {
    db.prepare('DELETE FROM _auth_email_tokens WHERE id = ?').run(row.id);
  }

  if (!row) return null;                      // token tidak dikenal
  if (row.purpose !== purpose) return null;   // purpose beda (verify≠reset)
  if (new Date(row.expires_at).getTime() < Date.now()) return null; // expired

  return { userId: row.user_id, purpose: row.purpose as EmailTokenPurpose };
}

/**
 * M27: PEEK — validasi TANPA konsumsi. Dipakai challenge MFA:
 * mfaToken harus tetap hidup sepanjang beberapa percobaan kode salah,
 * baru dikonsumsi saat kode BENAR (berbeda dari email link yang
 * sekali-klik-konsumsi).
 */
export function peekEmailToken(
  db: DatabaseSync,
  token: string,
  purpose: EmailTokenPurpose
): { userId: string } | null {
  initEmailTokensTable(db);
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const row = db
    .prepare('SELECT user_id, purpose, expires_at FROM _auth_email_tokens WHERE token_hash = ?')
    .get(tokenHash) as
    | { user_id: string; purpose: string; expires_at: string }
    | undefined;
  if (!row) return null;
  if (row.purpose !== purpose) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return { userId: row.user_id };
}
