// ============================================================================
// M10: IDENTITIES — tabel _auth_identities + find-or-create user OAuth
//
// Tabel ini memetakan 1 akun provider (Google sub / GitHub id) → 1 user
// BaseForge. Satu user BOLEH punya banyak identities (login via Google
// DAN GitHub sekaligus — "account linking").
//
// Keputusan keamanan linking (anti account-takeover):
//   email cocok + provider KONFIRMASI verified → auto-link ✅
//   email cocok + provider TIDAK verified       → TOLAK ❌
//     (serangan: daftar email korban di GitHub tanpa verifikasi →
//      login OAuth → dapat akun korban. GitHub email bisa unverified!)
//   identity sudah ada                           → langsung login (tanpa buat baru)
//   tidak ada sama sekali                        → buat user baru (tanpa password)
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import { generateId } from '../core/router.js';
import { createOAuthUser, findAuthUserByEmail, findAuthUserById, type AuthUser } from './users.js';
import { OAuthError, type OAuthProfile } from './oauth.js';

// ─── Tabel ────────────────────────────────────────────────────────────────────

export function initAuthIdentitiesTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _auth_identities (
      id                  TEXT PRIMARY KEY,
      user_id             TEXT NOT NULL,
      provider            TEXT NOT NULL,
      provider_account_id TEXT NOT NULL,
      created             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE (provider, provider_account_id)
    );
  `);

  // Lookup by user (dashboard: tampilkan provider mana yang terhubung)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_auth_identities_user
    ON _auth_identities (user_id);
  `);
}

interface IdentityRow {
  id: string; user_id: string; provider: string; provider_account_id: string;
}

export function findIdentity(
  db: DatabaseSync,
  provider: string,
  providerAccountId: string
): IdentityRow | undefined {
  return db
    .prepare('SELECT * FROM _auth_identities WHERE provider = ? AND provider_account_id = ?')
    .get(provider, providerAccountId) as unknown as IdentityRow | undefined;
}

export function listIdentitiesByUser(db: DatabaseSync, userId: string): IdentityRow[] {
  return db
    .prepare('SELECT * FROM _auth_identities WHERE user_id = ?')
    .all(userId) as unknown as IdentityRow[];
}

// ─── Find-or-create (inti M10) ────────────────────────────────────────────────

export interface OAuthLoginResult {
  user: AuthUser;
  /** true = user baru dibuat; false = login existing / linked */
  created: boolean;
  /** true = identity baru di-link ke user email+password existing */
  linked: boolean;
}

export function findOrCreateOAuthUser(db: DatabaseSync, profile: OAuthProfile): OAuthLoginResult {
  initAuthIdentitiesTable(db);

  // 1. Identity sudah terdaftar? → login langsung
  const identity = findIdentity(db, profile.provider, profile.providerAccountId);
  if (identity) {
    const user = findAuthUserById(db, identity.user_id);
    if (user) return { user, created: false, linked: false };
    // identity yatim (user terhapus) — bersihkan lalu jatuh ke langkah berikutnya
    db.prepare('DELETE FROM _auth_identities WHERE id = ?').run(identity.id);
  }

  // 2. Email cocok dengan user existing?
  const existing = findAuthUserByEmail(db, profile.email);
  if (existing) {
    if (!profile.emailVerified) {
      // ⚠️ Anti account-takeover: hanya email TERVERIFIKASI provider boleh link
      throw new OAuthError(
        'EMAIL_UNVERIFIED_CONFLICT',
        `Email '${profile.email}' is already registered, but the provider has not verified this email address. ` +
          'Verify your email at the provider or sign in with your password.'
      );
    }
    linkIdentity(db, existing.id, profile);
    return { user: existing, created: false, linked: true };
  }

  // 3. Buat user baru — tanpa password, verified mengikuti konfirmasi provider
  const user = createOAuthUser(db, {
    email: profile.email,
    name: profile.name,
    avatarUrl: profile.avatarUrl,
    verified: profile.emailVerified,
  });
  linkIdentity(db, user.id, profile);
  return { user, created: true, linked: false };
}

function linkIdentity(db: DatabaseSync, userId: string, profile: OAuthProfile): void {
  db.prepare(
    'INSERT INTO _auth_identities (id, user_id, provider, provider_account_id) VALUES (?, ?, ?, ?)'
  ).run(generateId(), userId, profile.provider, profile.providerAccountId);
}

// ─── Unlink (bisa dipanggil admin nanti) ─────────────────────────────────────

export function unlinkIdentity(db: DatabaseSync, provider: string, providerAccountId: string): boolean {
  const result = db
    .prepare('DELETE FROM _auth_identities WHERE provider = ? AND provider_account_id = ?')
    .run(provider, providerAccountId);
  return result.changes > 0;
}
