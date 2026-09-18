// ============================================================================
// M42: SECRETS STORE — rahasia per function, terenkripsi at-rest, `$env`
//
// Mengapa modul ini ada: function yang bicara ke layanan luar butuh credential
// (API key, token, webhook secret). Tanpa store khusus, credential itu disimpan
// di `_functions.code` — plaintext, terekspos via Admin API, dan tidak bisa
// di-rotate tanpa mengubah kode. Di sini rahasia dipisahkan siklus hidupnya
// dari kode.
//
// ENKRIPSI: skema IDENTIK dengan `encryptSecret`/`decryptSecret` di mfa.ts &
// mailer.ts (AES-256-GCM, key derivasi scrypt dari OAUTH_SECRET ?? JWT_SECRET
// ?? ADMIN_PASSWORD, payload `v1:iv:authTag:data` base64). Bukan skema baru —
// satu skema = satu tempat untuk diaudit. Yang dilindungi adalah artefak yang
// KELUAR dari server (backup data/, dump SQLite), bukan serangan ke proses
// yang sedang berjalan (ia memegang key).
//
// PRIVILESE: read-only dari sandbox. Function TIDAK bisa menulis secrets-nya
// sendiri — satu function terkompromi tidak boleh mengubah rahasia function
// lain (atau dirinya). Rotasi hanya lewat Admin API.
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

// ─── Batas (kecil & ketat: secrets = credential, bukan blob) ─────────────────

export const MAX_SECRETS_PER_FUNCTION = 50;
export const MAX_SECRET_KEY_LENGTH = 64;
export const MAX_SECRET_VALUE_BYTES = 8 * 1024; // 8 KB
export const SECRET_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

export interface SecretMeta {
  key: string;
  hasValue: true; // nilai TIDAK pernah dikembalikan API
  updated: string;
}

export class SecretsStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretsStoreError';
  }
}

// ─── Tabel (per project DB, idempotent) ──────────────────────────────────────

export function initSecretsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _function_secrets (
      id TEXT PRIMARY KEY,
      function_name TEXT NOT NULL,
      key TEXT NOT NULL,
      value_enc TEXT NOT NULL,
      created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(function_name, key)
    );
  `);
}

// ─── Enkripsi (skema mfa.ts/mailer.ts — scrypt-derivasi + AES-256-GCM) ───────

let cachedKey: Buffer | null = null;

function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const secret =
    process.env.OAUTH_SECRET ??
    process.env.JWT_SECRET ??
    process.env.ADMIN_PASSWORD ??
    'dev-only-insecure-secret-change-me';
  cachedKey = crypto.scryptSync(secret, 'baseforge-secrets-v1', 32);
  return cachedKey;
}

/** Enkripsi plaintext → 'v1:ivB64:authTagB64:dataB64'. */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const out = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), out.toString('base64')].join(':');
}

/** Dekripsi payload 'v1:...' → plaintext. Lempar SecretsStoreError jika rusak. */
export function decryptSecret(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new SecretsStoreError('corrupted secret payload');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'));
    d.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([d.update(Buffer.from(dataB64, 'base64')), d.final()]).toString('utf8');
  } catch {
    throw new SecretsStoreError('failed to decrypt secret (wrong key or corrupted data)');
  }
}

// ─── Validasi ────────────────────────────────────────────────────────────────

function validateKey(key: string): void {
  if (typeof key !== 'string' || !SECRET_KEY_PATTERN.test(key)) {
    throw new SecretsStoreError(
      `Invalid secret key '${String(key)}' (must match ${SECRET_KEY_PATTERN}, e.g. STRIPE_KEY)`
    );
  }
}

function validateValue(value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SecretsStoreError('Secret value must be a non-empty string');
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_VALUE_BYTES) {
    throw new SecretsStoreError(`Secret value exceeds ${MAX_SECRET_VALUE_BYTES / 1024} KB`);
  }
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

/** Set (upsert) satu secret. Nilai dienkripsi SEBELUM disimpan. */
export function setSecret(
  db: DatabaseSync,
  functionName: string,
  key: string,
  value: string
): void {
  validateKey(key);
  validateValue(value);
  initSecretsTable(db);

  const count = db
    .prepare('SELECT COUNT(*) AS n FROM _function_secrets WHERE function_name = ?')
    .get(functionName) as { n: number };
  const existing = db
    .prepare('SELECT id FROM _function_secrets WHERE function_name = ? AND key = ?')
    .get(functionName, key);
  if (!existing && count.n >= MAX_SECRETS_PER_FUNCTION) {
    throw new SecretsStoreError(
      `A function may hold at most ${MAX_SECRETS_PER_FUNCTION} secrets`
    );
  }

  const enc = encryptSecret(value);
  db.prepare(
    `INSERT INTO _function_secrets (id, function_name, key, value_enc)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(function_name, key) DO UPDATE SET
       value_enc = excluded.value_enc,
       updated = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(crypto.randomUUID(), functionName, key, enc);
}

/** Metadata semua secrets milik satu function — TANPA nilai. */
export function listSecrets(db: DatabaseSync, functionName: string): SecretMeta[] {
  initSecretsTable(db);
  const rows = db
    .prepare(
      `SELECT key, updated FROM _function_secrets WHERE function_name = ? ORDER BY key ASC`
    )
    .all(functionName) as unknown as { key: string; updated: string }[];
  return rows.map((r) => ({ key: r.key, hasValue: true as const, updated: r.updated }));
}

/** Hapus satu secret. Return true jika ada yang terhapus. */
export function deleteSecret(db: DatabaseSync, functionName: string, key: string): boolean {
  initSecretsTable(db);
  const res = db
    .prepare('DELETE FROM _function_secrets WHERE function_name = ? AND key = ?')
    .run(functionName, key);
  return res.changes > 0;
}

/**
 * Ambil SEMUA secrets satu function sebagai objek KEY → plaintext.
 * Dipanggil HOST (functionRunner / trigger / scheduler) untuk disuntikkan
 * sebagai `$env` — satu dekripsi sebelum isolate dibuat, bukan per akses.
 * Rahasia yang gagal didekripsi di-skip (key salah) agar satu entry rusak
 * tidak mematikan seluruh function.
 */
export function getSecretsForFunction(
  db: DatabaseSync,
  functionName: string
): Record<string, string> {
  initSecretsTable(db);
  const rows = db
    .prepare('SELECT key, value_enc FROM _function_secrets WHERE function_name = ?')
    .all(functionName) as unknown as { key: string; value_enc: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) {
    try {
      out[r.key] = decryptSecret(r.value_enc);
    } catch {
      /* key enkripsi berubah → lewati entry ini, jangan matikan function */
    }
  }
  return out;
}
