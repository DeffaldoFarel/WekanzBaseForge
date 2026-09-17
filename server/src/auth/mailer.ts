// ============================================================================
// M23: MAILER — single-gate pengiriman email untuk seluruh platform
//
// Tiga moda, dipilih otomatis dengan urutan prioritas:
//   1. SMTP   — konfigurasi runtime (Admin API, tersimpan platform.db) →
//               atau env (SMTP_HOST). Kirim via nodemailer (battle-tested:
//               prinsip M18 — jalur security-critical pakai library teruji).
//   2. OUTBOX — mode dev/test: email TIDAK dikirim, tapi disimpan ke tabel
//               _outbox di platform.db + console.log. Link verifikasi/reset
//               tetap bisa diambil (dashboard Settings > Outbox / test suite).
//
// Konfigurasi runtime disimpan sebagai JSON di tabel _platform_settings
// (key = 'mail'). Password SMTP di-encrypt at-rest (AES-256-GCM — reuse
// pattern OAUTH_SECRET M10).
// ============================================================================

import crypto from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import { getPlatformDb } from '../core/platformDb.js';

// ─── Konfigurasi ─────────────────────────────────────────────────────────────

export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  passEnc: string; // terenkripsi — tidak pernah keluar mentah
  from: string;
}

export interface MailConfigPublic {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  from: string;
  /** ada password tersimpan? (tanpa membocorkan nilainya) */
  hasPassword: boolean;
}

export const DEFAULT_MAIL_FROM = 'BaseForge <no-reply@baseforge.local>';

// ─── Tabel platform: _platform_settings + _outbox ────────────────────────────

export function initMailTables(): void {
  const db = getPlatformDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS _platform_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS _outbox (
      id      TEXT PRIMARY KEY,
      to_addr TEXT NOT NULL,
      subject TEXT NOT NULL,
      text    TEXT NOT NULL,
      html    TEXT,
      created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
}

// ─── Enkripsi password SMTP (pola sama dengan M10) ───────────────────────────

let cachedKey: Buffer | null = null;
function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const secret =
    process.env.OAUTH_SECRET ??
    process.env.JWT_SECRET ??
    process.env.ADMIN_PASSWORD ??
    'dev-only-insecure-secret-change-me';
  cachedKey = crypto.scryptSync(secret, 'baseforge-mail-encryption-salt', 32);
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
    throw new Error('Unrecognized SMTP password format');
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

// ─── Resolusi konfigurasi: DB → env → (tidak ada = outbox) ───────────────────

interface StoredMailSettings {
  host?: string; port?: number; secure?: boolean;
  user?: string; pass?: string; from?: string;
}

function readStoredSettings(): StoredMailSettings | null {
  const db = getPlatformDb();
  const row = db
    .prepare("SELECT value FROM _platform_settings WHERE key = 'mail'")
    .get() as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as StoredMailSettings;
  } catch {
    return null;
  }
}

export function saveMailSettings(settings: {
  host: string; port: number; secure: boolean;
  user: string; pass?: string; // kosong = keep existing
  from: string;
}): void {
  initMailTables();
  const db = getPlatformDb();

  const existing = readStoredSettings();
  let passEnc: string;
  if (settings.pass && settings.pass.trim() !== '') {
    passEnc = encryptSecret(settings.pass);
  } else if (existing?.pass) {
    passEnc = existing.pass;
  } else {
    throw new Error('SMTP password is required for initial configuration');
  }

  const payload: StoredMailSettings = {
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    user: settings.user,
    pass: passEnc,
    from: settings.from,
  };
  db.prepare(
    `INSERT INTO _platform_settings (key, value) VALUES ('mail', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(JSON.stringify(payload));
}

export function clearMailSettings(): boolean {
  initMailTables();
  const result = getPlatformDb()
    .prepare("DELETE FROM _platform_settings WHERE key = 'mail'")
    .run();
  return result.changes > 0;
}

/** Konfigurasi efektif (DB menang env). null = mode outbox. */
export function resolveMailConfig(): MailConfig | null {
  initMailTables();
  const stored = readStoredSettings();
  if (stored?.host) {
    return {
      host: stored.host,
      port: stored.port ?? 587,
      secure: stored.secure ?? false,
      user: stored.user ?? '',
      passEnc: stored.pass ?? '',
      from: stored.from ?? DEFAULT_MAIL_FROM,
    };
  }
  const envHost = process.env.SMTP_HOST;
  if (envHost) {
    return {
      host: envHost,
      port: parseInt(process.env.SMTP_PORT ?? '587', 10),
      secure: (process.env.SMTP_SECURE ?? 'false') === 'true' ||
              parseInt(process.env.SMTP_PORT ?? '587', 10) === 465,
      user: process.env.SMTP_USER ?? '',
      passEnc: process.env.SMTP_PASS ? encryptSecret(process.env.SMTP_PASS) : '',
      from: process.env.MAIL_FROM ?? DEFAULT_MAIL_FROM,
    };
  }
  return null; // → outbox mode
}

export function mailConfigPublic(): MailConfigPublic | null {
  const cfg = resolveMailConfig();
  if (!cfg) return null;
  return {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    user: cfg.user,
    from: cfg.from,
    hasPassword: cfg.passEnc !== '',
  };
}

export function mailTransportMode(): 'smtp' | 'outbox' {
  return resolveMailConfig() ? 'smtp' : 'outbox';
}

// ─── Transport cache (nodemailer) ─────────────────────────────────────────────

let transporter: Transporter | null = null;
let transporterKey = '';

function getTransporter(cfg: MailConfig): Transporter {
  const key = `${cfg.host}:${cfg.port}:${cfg.user}:${cfg.passEnc}`;
  if (transporter && transporterKey === key) return transporter; // reuse koneksi

  transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user || cfg.passEnc
      ? { user: cfg.user, pass: decryptSecret(cfg.passEnc) }
      : undefined,
  });
  transporterKey = key;
  return transporter;
}

/** Reset transport cache (dipanggil setelah settings berubah / test). */
export function resetTransporter(): void {
  transporter = null;
  transporterKey = '';
}

// ─── Outbox (mode dev/test) ───────────────────────────────────────────────────

export interface OutboxMessage {
  id: string;
  to: string;
  subject: string;
  text: string;
  html: string | null;
  created: string;
}

function storeOutbox(msg: { to: string; subject: string; text: string; html?: string }): void {
  const db = getPlatformDb();
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO _outbox (id, to_addr, subject, text, html) VALUES (?, ?, ?, ?, ?)'
  ).run(id, msg.to, msg.subject, msg.text, msg.html ?? null);

  // Retensi: simpan 50 terakhir saja (outbox = alat bantu dev, bukan arsip)
  db.prepare(
    `DELETE FROM _outbox WHERE id NOT IN (
       SELECT id FROM _outbox ORDER BY created DESC, rowid DESC LIMIT 50
     )`
  ).run();
}

export function listOutbox(limit = 20): OutboxMessage[] {
  initMailTables();
  const db = getPlatformDb();
  return db
    .prepare(
      'SELECT id, to_addr AS "to", subject, text, html, created FROM _outbox ORDER BY created DESC, rowid DESC LIMIT ?'
    )
    .all(limit) as unknown as OutboxMessage[];
}

export function clearOutbox(): void {
  initMailTables();
  getPlatformDb().exec('DELETE FROM _outbox');
}

// ─── Kirim email (single-gate) ───────────────────────────────────────────────

export interface SendMailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SendMailResult {
  mode: 'smtp' | 'outbox';
  /** mode smtp: message id nodemailer; outbox: id row outbox */
  messageId: string;
}

/**
 * Satu-satunya gerbang pengiriman email di seluruh BaseForge.
 * Route/route test TIDAK tahu transport apa yang aktif.
 */
export async function sendMail(msg: SendMailInput): Promise<SendMailResult> {
  const cfg = resolveMailConfig();

  if (!cfg) {
    // ── Mode OUTBOX (dev/test) ──
    storeOutbox(msg);
    console.log(
      `[mailer:outbox] to=${msg.to} subject="${msg.subject}" (SMTP not configured — see dashboard Settings)`
    );
    return { mode: 'outbox', messageId: 'outbox' };
  }

  // ── Mode SMTP ──
  const transporter = getTransporter(cfg);
  const info = await transporter.sendMail({
    from: cfg.from,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
  });
  return { mode: 'smtp', messageId: info.messageId };
}
