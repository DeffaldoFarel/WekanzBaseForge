// ============================================================================
// M09: REFRESH TOKENS — persisten, hashed, per project
//
// Access token (JWT): pendek, stateless, dikirim di setiap request.
// Refresh token     : panjang, PERSISTEN di DB (selamat restart!), hashed.
//
// Kenapa refresh token di-HASH di database? Alasan sama dengan password (M08):
// kalau database bocor, attacker tidak bisa memakai refresh token yang
// tersimpan untuk minta access token baru.
//
// Kenapa persisten (tidak seperti Map M00)? Agar user tetap login walau
// server restart. Dan karena persisten, kita bisa REVOKE (logout, ban).
// ============================================================================

import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { generateId } from '../core/router.js';
import type { AuthUser } from './users.js';
import { signToken, verifyToken } from './jwt.js';

// ─── Konstanta ───────────────────────────────────────────────────────────────

export const ACCESS_TOKEN_TTL = 15 * 60;        // 15 menit (detik)
export const REFRESH_TOKEN_TTL = 30 * 24 * 3600; // 30 hari (detik)

// ─── Tabel _auth_tokens (dibuat otomatis per project) ────────────────────────

export function initAuthTokensTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _auth_tokens (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      token_hash  TEXT NOT NULL UNIQUE,
      expires_at  TEXT NOT NULL,
      created     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      revoked     INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Lookup by user (untuk logout semua device, misalnya)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_auth_tokens_user
    ON _auth_tokens (user_id);
  `);
}

// ─── Helper: hash refresh token (seperti password — M08!) ───────────────────

// M40: diexport — dipakai auth-refresh/auth-logout collection di publicRoutes
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ─── ISSUE: login → access + refresh ────────────────────────────────────────

export interface TokenPair {
  accessToken: string;      // JWT, umur 15 menit
  refreshToken: string;     // acak 64-hex, umur 30 hari, tersimpan hashed
  expiresIn: number;        // detik sampai access token expired
}

export async function issueTokens(db: DatabaseSync, user: AuthUser): Promise<TokenPair> {
  // Access token: JWT stateless (payload berisi identitas user)
  // M18b: signToken ASYNC (jose)
  const accessToken = await signToken(
    { sub: user.id, email: user.email, name: user.name ?? undefined },
    ACCESS_TOKEN_TTL
  );

  // Refresh token: acak 64 hex, disimpan HASHED di DB
  const refreshToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL * 1000).toISOString();

  db.prepare(
    `INSERT INTO _auth_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`
  ).run(generateId(), user.id, hashToken(refreshToken), expiresAt);

  return {
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL,
  };
}

// ─── REFRESH: refresh token → access token baru ─────────────────────────────

/**
 * Menukar refresh token dengan access token baru.
 * Mengembalikan null kalau token tidak valid/expired/revoked.
 *
 * Keamanan: token yang dicari adalah HASH-nya — database bocor pun,
// attacker tidak bisa memakai refresh token tersimpan.
 */
export async function refreshAccessToken(
  db: DatabaseSync,
  refreshToken: string
): Promise<TokenPair | null> {
  const tokenHash = hashToken(refreshToken);

  const row = db
    .prepare(
      `SELECT t.id, t.user_id, t.expires_at, t.revoked,
              u.email, u.name, u.avatar_url
       FROM _auth_tokens t
       JOIN _auth_users u ON u.id = t.user_id
       WHERE t.token_hash = ?`
    )
    .get(tokenHash) as
    | { id: string; user_id: string; expires_at: string; revoked: number; email: string; name: string | null; avatar_url: string | null }
    | undefined;

  if (!row) return null;                    // token tidak dikenal
  if (row.revoked === 1) return null;       // sudah di-revoke (logout)
  if (new Date(row.expires_at) < new Date()) return null; // expired

  // Ambil user untuk payload access token
  const user: AuthUser = {
    id: row.user_id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    verified: true,
    disabled: false,
    created: '',
    updated: '',
  };

  return issueTokens(db, user);
}

// ─── REVOKE: logout ──────────────────────────────────────────────────────────

export function revokeRefreshToken(db: DatabaseSync, refreshToken: string): boolean {
  const result = db
    .prepare('UPDATE _auth_tokens SET revoked = 1 WHERE token_hash = ?')
    .run(hashToken(refreshToken));
  return result.changes > 0;
}

// Revoke SEMUA token milik user (misal: "logout dari semua device")
export function revokeAllUserTokens(db: DatabaseSync, userId: string): number {
  const result = db
    .prepare('UPDATE _auth_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0')
    .run(userId);
  return Number(result.changes);
}

// ─── CLEANUP: hapus token expired (dipanggil berkala/cron) ───────────────────

export function cleanupExpiredTokens(db: DatabaseSync): number {
  const result = db
    .prepare(`DELETE FROM _auth_tokens WHERE expires_at < ? OR (revoked = 1 AND expires_at < ?)`)
    .run(new Date().toISOString(), new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString());
  return Number(result.changes);
}
