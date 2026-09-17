// ============================================================================
// M10: OAUTH2 — provider registry, konfigurasi, & state anti-CSRF
//
// Authorization Code Flow (server-side / "confidential client"):
//   browser → /authorize → provider consent → /callback?code&state
//   → server tukar code jadi access_token provider → fetch profil
//   → find-or-create user → issueTokens (JWT BaseForge M09)
//
// Desain keamanan:
//   - client_secret TIDAK disimpan plaintext — AES-256-GCM (node:crypto)
//   - state: random 64-hex, SATU KALI PAKAI, TTL 10 menit (anti CSRF)
//   - find-or-create & account-linking aman ada di identities.ts
//
// Testability: OAUTH_PROVIDER_DEFS adalah objek MUTABLE — test mengarahkan
// authorizeUrl/tokenUrl/profileUrl ke mock server lokal (tanpa internet).
// ============================================================================

import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// ─── Definisi provider (mutable — lihat header) ──────────────────────────────

export type OAuthProviderId =
  | 'google'
  | 'github'
  | 'apple'
  | 'microsoft'
  | 'discord'
  | 'gitlab'
  | 'facebook';

export interface OAuthProviderDef {
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Google/OpenID: userinfo endpoint */
  profileUrl: string;
  /** GitHub: /user endpoint */
  userUrl: string;
  /** GitHub: /user/emails endpoint */
  userEmailsUrl: string;
  scope: string;
  /** Apple: token endpoint butuh POST form (bukan GET) */
  tokenPostOnly?: boolean;
  /** ekstrak profil dari access_token provider (URL dibaca dari def — testable) */
  fetchProfile: (accessToken: string) => Promise<OAuthProfile>;
}

export const OAUTH_PROVIDER_DEFS: Record<OAuthProviderId, OAuthProviderDef> = {
  google: {
    label: 'Google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    profileUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    userUrl: '',
    userEmailsUrl: '',
    scope: 'openid email profile',
    fetchProfile: async (accessToken) => {
      const res = await fetch(OAUTH_PROVIDER_DEFS.google.profileUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new OAuthError('PROFILE_FAILED', `Google userinfo request failed: ${res.status}`);
      const j = (await res.json()) as {
        sub: string; email?: string; email_verified?: boolean;
        name?: string; picture?: string;
      };
      if (!j.email) throw new OAuthError('PROFILE_FAILED', 'Google profile does not include an email address');
      return {
        provider: 'google',
        providerAccountId: String(j.sub),
        email: j.email.toLowerCase(),
        emailVerified: j.email_verified === true,
        name: j.name ?? null,
        avatarUrl: j.picture ?? null,
      };
    },
  },
  github: {
    label: 'GitHub',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    profileUrl: '',
    userUrl: 'https://api.github.com/user',
    userEmailsUrl: 'https://api.github.com/user/emails',
    scope: 'read:user user:email',
    fetchProfile: async (accessToken) => {
      const def = OAUTH_PROVIDER_DEFS.github;
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'WekanzBaseForge',
      };
      const userRes = await fetch(def.userUrl, { headers });
      if (!userRes.ok) throw new OAuthError('PROFILE_FAILED', `GitHub /user request failed: ${userRes.status}`);
      const u = (await userRes.json()) as {
        id: number; name?: string | null; login: string;
        avatar_url?: string; email?: string | null;
      };

      let email = u.email ?? null;
      let emailVerified = false;

      if (def.userEmailsUrl) {
        try {
          const emailsRes = await fetch(def.userEmailsUrl, { headers });
          if (emailsRes.ok) {
            const emails = (await emailsRes.json()) as {
              email: string; primary: boolean; verified: boolean;
            }[];
            const primary = emails.find((e) => e.primary) ?? emails.find((e) => e.verified);
            if (primary) {
              email = primary.email;
              emailVerified = primary.verified;
            }
          }
        } catch { /* /user/emails gagal → pakai /user.email */ }
      }

      if (!email) {
        throw new OAuthError('PROFILE_FAILED', 'GitHub did not provide an email address (privacy). Request user:email scope.');
      }

      return {
        provider: 'github',
        providerAccountId: String(u.id),
        email: email.toLowerCase(),
        emailVerified,
        name: u.name ?? u.login,
        avatarUrl: u.avatar_url ?? null,
      };
    },
  },
  apple: {
    label: 'Apple',
    authorizeUrl: 'https://appleid.apple.com/auth/authorize',
    tokenUrl: 'https://appleid.apple.com/auth/token',
    profileUrl: '',
    userUrl: '',
    userEmailsUrl: '',
    scope: 'name email',
    tokenPostOnly: true,
    // Apple: id_token (JWT) berisi sub + email. Tidak ada userinfo endpoint
    // publik — profil hanya dikirim SEKALI di response token pertama.
    fetchProfile: async (_accessToken) => {
      // Apple memerlukan client_secret berupa JWT ES256 — kompleks untuk v1.
      // throw error informatif; user diarahkan ke provider lain.
      throw new OAuthError(
        'PROFILE_FAILED',
        'Apple Sign-In requires an ES256-signed client_secret JWT (not yet supported — use Google or GitHub)'
      );
    },
  },
  microsoft: {
    label: 'Microsoft',
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    profileUrl: 'https://graph.microsoft.com/v1.0/me',
    userUrl: '',
    userEmailsUrl: '',
    scope: 'openid email profile User.Read',
    fetchProfile: async (accessToken) => {
      const res = await fetch(OAUTH_PROVIDER_DEFS.microsoft.profileUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new OAuthError('PROFILE_FAILED', `Microsoft Graph /me failed: ${res.status}`);
      const j = (await res.json()) as {
        id: string; mail?: string; userPrincipalName?: string;
        displayName?: string;
      };
      const email = j.mail ?? j.userPrincipalName;
      if (!email) throw new OAuthError('PROFILE_FAILED', 'Microsoft profile does not include an email');
      return {
        provider: 'microsoft',
        providerAccountId: j.id,
        email: email.toLowerCase(),
        emailVerified: true, // Microsoft AD email selalu terverifikasi
        name: j.displayName ?? null,
        avatarUrl: null,
      };
    },
  },
  discord: {
    label: 'Discord',
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    profileUrl: 'https://discord.com/api/users/@me',
    userUrl: '',
    userEmailsUrl: '',
    scope: 'identify email',
    fetchProfile: async (accessToken) => {
      const res = await fetch(OAUTH_PROVIDER_DEFS.discord.profileUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new OAuthError('PROFILE_FAILED', `Discord /users/@me failed: ${res.status}`);
      const j = (await res.json()) as {
        id: string; email?: string; verified?: boolean;
        username: string; global_name?: string;
        avatar?: string;
      };
      if (!j.email) throw new OAuthError('PROFILE_FAILED', 'Discord profile does not include an email (need email scope)');
      const avatarUrl = j.avatar
        ? `https://cdn.discordapp.com/avatars/${j.id}/${j.avatar}.png`
        : null;
      return {
        provider: 'discord',
        providerAccountId: j.id,
        email: j.email.toLowerCase(),
        emailVerified: j.verified === true,
        name: j.global_name ?? j.username,
        avatarUrl,
      };
    },
  },
  gitlab: {
    label: 'GitLab',
    authorizeUrl: 'https://gitlab.com/oauth/authorize',
    tokenUrl: 'https://gitlab.com/oauth/token',
    profileUrl: 'https://gitlab.com/api/v4/user',
    userUrl: '',
    userEmailsUrl: '',
    scope: 'read_user',
    fetchProfile: async (accessToken) => {
      const res = await fetch(OAUTH_PROVIDER_DEFS.gitlab.profileUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new OAuthError('PROFILE_FAILED', `GitLab /user failed: ${res.status}`);
      const j = (await res.json()) as {
        id: number; email: string; name?: string;
        username: string; avatar_url?: string; confirmed_at?: string;
      };
      return {
        provider: 'gitlab',
        providerAccountId: String(j.id),
        email: j.email.toLowerCase(),
        emailVerified: Boolean(j.confirmed_at),
        name: j.name ?? j.username,
        avatarUrl: j.avatar_url ?? null,
      };
    },
  },
  facebook: {
    label: 'Facebook',
    authorizeUrl: 'https://www.facebook.com/v19.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v19.0/oauth/access_token',
    profileUrl: 'https://graph.facebook.com/me',
    userUrl: '',
    userEmailsUrl: '',
    scope: 'email public_profile',
    fetchProfile: async (accessToken) => {
      const res = await fetch(
        `${OAUTH_PROVIDER_DEFS.facebook.profileUrl}?fields=id,name,email,picture.type(large)&access_token=${accessToken}`
      );
      if (!res.ok) throw new OAuthError('PROFILE_FAILED', `Facebook /me failed: ${res.status}`);
      const j = (await res.json()) as {
        id: string; email?: string; name?: string;
        picture?: { data?: { url?: string } };
      };
      if (!j.email) throw new OAuthError('PROFILE_FAILED', 'Facebook profile does not include an email (need email permission)');
      return {
        provider: 'facebook',
        providerAccountId: j.id,
        email: j.email.toLowerCase(),
        emailVerified: true, // Facebook verified email by default
        name: j.name ?? null,
        avatarUrl: j.picture?.data?.url ?? null,
      };
    },
  },
};

export function isOAuthProvider(v: string): v is OAuthProviderId {
  return v in OAUTH_PROVIDER_DEFS;
}

// ─── Profil hasil fetch dari provider ────────────────────────────────────────

export interface OAuthProfile {
  provider: OAuthProviderId;
  providerAccountId: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  avatarUrl: string | null;
}

// ─── Error khusus OAuth (route memetakan ke status HTTP) ─────────────────────

export class OAuthError extends Error {
  code:
    | 'PROVIDER_NOT_CONFIGURED'
    | 'PROVIDER_DISABLED'
    | 'BAD_STATE'
    | 'EXCHANGE_FAILED'
    | 'PROFILE_FAILED'
    | 'EMAIL_UNVERIFIED_CONFLICT';
  constructor(code: OAuthError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

// ─── Enkripsi client_secret (AES-256-GCM) ────────────────────────────────────
// DB bocor pun, secret tetap terlindungi (prinsip sama seperti hashing M08,
// tapi reversible — server perlu secret ASLI untuk token exchange).

let cachedKey: Buffer | null = null;

function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const secret =
    process.env.OAUTH_SECRET ??
    process.env.JWT_SECRET ??
    process.env.ADMIN_PASSWORD ??
    'dev-only-insecure-secret-change-me';
  cachedKey = crypto.scryptSync(secret, 'baseforge-oauth-encryption-salt', 32);
  return cachedKey;
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

export function decryptSecret(payload: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Unrecognized OAuth secret format');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivB64, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}

// ─── Tabel _auth_providers (konfigurasi per project) ─────────────────────────

export interface OAuthProviderConfig {
  provider: OAuthProviderId;
  clientId: string;
  clientSecret: string; // DECRYPTED — hanya di dalam server, tidak pernah keluar
  enabled: boolean;
  /** callback URL override (mis. proxy publik beda host) — kosong = auto dari request */
  callbackUrlOverride: string | null;
  /** koma-separated origins yang boleh jadi `redirect_to` — kosong = semua http(s) */
  allowedOrigins: string[];
}

export function initOAuthTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _auth_providers (
      provider        TEXT PRIMARY KEY,
      client_id       TEXT NOT NULL,
      client_secret   TEXT NOT NULL,
      enabled         INTEGER NOT NULL DEFAULT 1,
      callback_url    TEXT,
      allowed_origins TEXT,
      created         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS _auth_oauth_states (
      state       TEXT PRIMARY KEY,
      provider    TEXT NOT NULL,
      redirect_to TEXT,
      created     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
}

interface ProviderRow {
  provider: string; client_id: string; client_secret: string;
  enabled: number; callback_url: string | null;
  allowed_origins: string | null;
}

export function upsertOAuthProvider(
  db: DatabaseSync,
  cfg: {
    provider: OAuthProviderId;
    clientId: string;
    clientSecret?: string; // kosong = keep existing (untuk update tanpa re-type secret)
    enabled?: boolean;
    callbackUrlOverride?: string | null;
    allowedOrigins?: string[];
  }
): void {
  if (!cfg.clientId?.trim()) {
    throw new Error('clientId is required');
  }
  const existing = db
    .prepare('SELECT client_secret FROM _auth_providers WHERE provider = ?')
    .get(cfg.provider) as { client_secret: string } | undefined;

  // PUT tanpa secret baru → pertahankan secret lama (dashboard update clientId saja)
  let secretEnc: string;
  if (cfg.clientSecret && cfg.clientSecret.trim() !== '') {
    secretEnc = encryptSecret(cfg.clientSecret);
  } else if (existing?.client_secret) {
    secretEnc = existing.client_secret;
  } else {
    throw new Error('clientSecret is required for initial configuration');
  }

  db.prepare(
    `INSERT INTO _auth_providers (provider, client_id, client_secret, enabled, callback_url, allowed_origins, updated)
     VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(provider) DO UPDATE SET
       client_id = excluded.client_id,
       client_secret = excluded.client_secret,
       enabled = excluded.enabled,
       callback_url = excluded.callback_url,
       allowed_origins = excluded.allowed_origins,
       updated = excluded.updated`
  ).run(
    cfg.provider,
    cfg.clientId.trim(),
    secretEnc,
    (cfg.enabled ?? true) ? 1 : 0,
    cfg.callbackUrlOverride?.trim() || null,
    (cfg.allowedOrigins ?? []).join(',').trim() || null
  );
}

export function deleteOAuthProvider(db: DatabaseSync, provider: string): boolean {
  const result = db.prepare('DELETE FROM _auth_providers WHERE provider = ?').run(provider);
  return result.changes > 0;
}

export function getOAuthProvider(
  db: DatabaseSync,
  provider: string,
  opts: { mustBeEnabled?: boolean } = {}
): OAuthProviderConfig | null {
  const row = db
    .prepare('SELECT * FROM _auth_providers WHERE provider = ?')
    .get(provider) as unknown as ProviderRow | undefined;
  if (!row) return null;

  if (opts.mustBeEnabled && row.enabled !== 1) return null;

  return {
    provider: row.provider as OAuthProviderId,
    clientId: row.client_id,
    clientSecret: decryptSecret(row.client_secret),
    enabled: row.enabled === 1,
    callbackUrlOverride: row.callback_url,
    allowedOrigins: row.allowed_origins
      ? row.allowed_origins.split(',').map((s) => s.trim()).filter(Boolean)
      : [],
  };
}

/** Untuk dashboard: list config tanpa membocorkan secret. */
export function listOAuthProviders(db: DatabaseSync): Array<{
  provider: string; clientId: string; enabled: boolean;
  callbackUrl: string | null; allowedOrigins: string[];
}> {
  const rows = db
    .prepare('SELECT * FROM _auth_providers ORDER BY provider')
    .all() as unknown as ProviderRow[];
  return rows.map((r) => ({
    provider: r.provider,
    clientId: r.client_id,
    enabled: r.enabled === 1,
    callbackUrl: r.callback_url,
    allowedOrigins: r.allowed_origins
      ? r.allowed_origins.split(',').map((s) => s.trim()).filter(Boolean)
      : [],
  }));
}

// ─── State anti-CSRF (satu kali pakai, TTL 10 menit) ─────────────────────────

const STATE_TTL_MS = 10 * 60 * 1000;

export function createOAuthState(
  db: DatabaseSync,
  provider: string,
  redirectTo: string | null
): string {
  // Bersihkan state kedaluwarsa (opportunistic — murah, index PK)
  db.prepare(
    `DELETE FROM _auth_oauth_states WHERE created < ?`
  ).run(new Date(Date.now() - STATE_TTL_MS).toISOString());

  const state = crypto.randomBytes(32).toString('hex');
  db.prepare(
    'INSERT INTO _auth_oauth_states (state, provider, redirect_to) VALUES (?, ?, ?)'
  ).run(state, provider, redirectTo);
  return state;
}

/**
 * Konsumsi state: satu kali pakai. Kalau state tidak ada / kedaluwarsa /
 * provider-nya beda → null (route menolak dengan 400).
 */
export function consumeOAuthState(
  db: DatabaseSync,
  state: string,
  provider: string
): { redirectTo: string | null } | null {
  const row = db
    .prepare('SELECT * FROM _auth_oauth_states WHERE state = ?')
    .get(state) as { state: string; provider: string; redirect_to: string | null; created: string } | undefined;

  // Selalu hapus — entah valid atau tidak (anti replay)
  if (row) {
    db.prepare('DELETE FROM _auth_oauth_states WHERE state = ?').run(state);
  }

  if (!row) return null;
  if (row.provider !== provider) return null;
  if (new Date(row.created).getTime() < Date.now() - STATE_TTL_MS) return null;

  return { redirectTo: row.redirect_to };
}

// ─── Token exchange (code → access_token provider) ───────────────────────────

export async function exchangeCodeForTokens(
  provider: OAuthProviderId,
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<string> {
  const def = OAUTH_PROVIDER_DEFS[provider];
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });

  const res = await fetch(def.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new OAuthError('EXCHANGE_FAILED', `Token endpoint for ${provider} returned ${res.status}`);
  }

  const j = (await res.json()) as { access_token?: string; error?: string };
  if (!j.access_token) {
    throw new OAuthError('EXCHANGE_FAILED', j.error ?? 'access_token was not received');
  }
  return j.access_token;
}

// ─── URL authorize (dipakai route /authorize) ─────────────────────────────────

export function buildAuthorizeUrl(
  provider: OAuthProviderId,
  clientId: string,
  redirectUri: string,
  state: string
): string {
  const def = OAUTH_PROVIDER_DEFS[provider];
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: def.scope,
    state,
  });
  // Google: prompt=select_account supaya user bisa pilih akun (nice-to-have)
  const extra = provider === 'google' ? '&prompt=select_account' : '';
  return `${def.authorizeUrl}?${params.toString()}${extra}`;
}

// ─── util: callback URL dari request (behind proxy aware) ────────────────────

export function callbackUrlFromRequest(
  provider: OAuthProviderId,
  projectId: string,
  headers: Record<string, unknown>,
  override: string | null
): string {
  if (override) return override;
  const host = String(headers['x-forwarded-host'] ?? headers['host'] ?? 'localhost');
  const proto = String(headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim();
  return `${proto}://${host}/api/p/${projectId}/auth/oauth/${provider}/callback`;
}
