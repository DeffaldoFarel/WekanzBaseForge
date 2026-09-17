// ============================================================================
// M27: MFA STATE — tabel _auth_mfa + operasi enroll / confirm / disable
//
// Lifecycle:
//   enroll(userId)   → row (enabled=0, pending=1, secret encrypted)
//   confirm(userId, kode) → enabled=1 + recovery codes DIBUAT & dikembalikan SEKALI
//   disable(userId, kode | recoveryCode) → row dihapus
//   adminReset(userId) → row dihapus (mengabaikan kode — gerbang admin)
//
// Secret at-rest: AES-256-GCM (pola M10/M23 — kunci turunan OAUTH_SECRET).
// Kode recovery: hanya hash SHA-256 yang tersimpan; plaintext keluar sekali.
// ============================================================================

import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { verifyTotp, generateTotpSecret, generateRecoveryCodes, hashRecoveryCode, base32Decode } from './totp.js';

// ─── Tabel ────────────────────────────────────────────────────────────────────

export function initMfaTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _auth_mfa (
      user_id        TEXT PRIMARY KEY,
      secret_enc     TEXT NOT NULL,           -- TOTP secret terenkripsi AES-256-GCM
      recovery_codes TEXT NOT NULL DEFAULT '[]', -- JSON array SHA-256 hash
      enabled        INTEGER NOT NULL DEFAULT 0,
      pending        INTEGER NOT NULL DEFAULT 0,
      created        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
}

interface MfaRow {
  user_id: string;
  secret_enc: string;
  recovery_codes: string;
  enabled: number;
  pending: number;
}

// ─── Enkripsi secret (pola M10/M23, salt unik MFA) ────────────────────────────

let cachedKey: Buffer | null = null;
function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const secret =
    process.env.OAUTH_SECRET ??
    process.env.JWT_SECRET ??
    process.env.ADMIN_PASSWORD ??
    'dev-only-insecure-secret-change-me';
  cachedKey = crypto.scryptSync(secret, 'baseforge-mfa-encryption-salt', 32);
  return cachedKey;
}

function enc(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const out = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), out.toString('base64')].join(':');
}

function dec(payload: string): string {
  const [v, ivB64, tagB64, dataB64] = payload.split(':');
  if (v !== 'v1') throw new Error('Unrecognized MFA secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'));
  d.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([d.update(Buffer.from(dataB64, 'base64')), d.final()]).toString('utf8');
}

// ─── Status & lifecycle ───────────────────────────────────────────────────────

export function getMfaRow(db: DatabaseSync, userId: string): MfaRow | undefined {
  initMfaTable(db);
  return db.prepare('SELECT * FROM _auth_mfa WHERE user_id = ?').get(userId) as unknown as MfaRow | undefined;
}

export function isMfaEnabled(db: DatabaseSync, userId: string): boolean {
  return getMfaRow(db, userId)?.enabled === 1;
}

export interface EnrollResult {
  secretB32: string;
  /** secret terenkripsi untuk disimpan (server-side) */
  secretEnc: string;
}

/**
 * Mulai enrollment: generate secret baru (menimpa enroll pending lama).
 * TIDAK mengubah status enabled — user masih login normal sampai confirm.
 */
export function startEnrollment(db: DatabaseSync, userId: string): EnrollResult {
  initMfaTable(db);
  const { secretB32 } = generateTotpSecret();
  const secretEnc = enc(secretB32);
  db.prepare(
    `INSERT INTO _auth_mfa (user_id, secret_enc, pending, enabled)
     VALUES (?, ?, 1, 0)
     ON CONFLICT(user_id) DO UPDATE SET
       secret_enc = excluded.secret_enc,
       pending = 1,
       enabled = 0, -- re-enroll menurunkan aktif lama sampai confirm ulang
       updated = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).run(userId, secretEnc);
  return { secretB32, secretEnc };
}

/** Verifikasi kode terhadap secret user (pending atau enabled). */
export function verifyUserTotp(db: DatabaseSync, userId: string, token: string): boolean {
  const row = getMfaRow(db, userId);
  if (!row) return false;
  return verifyTotp(base32Decode(dec(row.secret_enc)), token);
}

/**
 * Konfirmasi enrollment dengan kode pertama. Berhasil → enabled=1 dan
 * 10 recovery codes DIKEMBALIKAN dalam plaintext (satu-satunya kali).
 */
export function confirmEnrollment(db: DatabaseSync, userId: string, token: string): string[] | null {
  const row = getMfaRow(db, userId);
  if (!row || row.pending !== 1) return null;
  if (!verifyUserTotp(db, userId, token)) return null;

  const codes = generateRecoveryCodes(10);
  const hashes = codes.map(hashRecoveryCode);
  db.prepare(
    `UPDATE _auth_mfa SET enabled = 1, pending = 0, recovery_codes = ?,
     updated = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = ?`
  ).run(JSON.stringify(hashes), userId);
  return codes;
}

/**
 * Konsumsi SATU recovery code (match hash). Berhasil → hash dihapus dari
 * daftar (sekali pakai). Return false bila tidak cocok / sudah terpakai.
 */
export function consumeRecoveryCode(db: DatabaseSync, userId: string, code: string): boolean {
  const row = getMfaRow(db, userId);
  if (!row || row.enabled !== 1) return false;
  let hashes: string[];
  try {
    hashes = JSON.parse(row.recovery_codes);
    if (!Array.isArray(hashes)) return false;
  } catch {
    return false;
  }
  const target = hashRecoveryCode(code.trim());
  const idx = hashes.indexOf(target);
  if (idx === -1) return false;
  hashes.splice(idx, 1); // sekali pakai — langsung dihapus
  db.prepare(
    `UPDATE _auth_mfa SET recovery_codes = ?, updated = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE user_id = ?`
  ).run(JSON.stringify(hashes), userId);
  return true;
}

/**
 * Matikan MFA — WAJIB bukti kepemilikan: kode TOTP valid ATAU satu
 * recovery code (dikonsumsi).
 */
export function disableMfa(db: DatabaseSync, userId: string, token: string | null, recoveryCode: string | null): boolean {
  const row = getMfaRow(db, userId);
  if (!row) return false;

  const totpOk = token ? verifyUserTotp(db, userId, token) : false;
  const recoveryOk = recoveryCode ? consumeRecoveryCode(db, userId, recoveryCode) : false;
  if (!totpOk && !recoveryOk) return false;

  db.prepare('DELETE FROM _auth_mfa WHERE user_id = ?').run(userId);
  return true;
}

/** Admin reset: matikan MFA tanpa kode (kebijakan: admin dipercaya + tercatat). */
export function adminResetMfa(db: DatabaseSync, userId: string): boolean {
  const result = db.prepare('DELETE FROM _auth_mfa WHERE user_id = ?').run(userId);
  return result.changes > 0;
}
