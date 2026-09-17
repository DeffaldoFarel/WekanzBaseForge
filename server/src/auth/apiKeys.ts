// ============================================================================
// M26: API KEYS — akses server-to-server per project
//
// Konsep: seperti Supabase service_role / PocketBase superuser token, tapi
// DIBUAT & DIREVOKE per project dari dashboard. Kunci menegakkan scope
// (read/write) di layer route, lalu request dianggap "service" →
// API Rules DILEWATI (bypass) — memang itu tujuannya: integrasi backend
// yang mengelola seluruh data project.
//
// Keamanan at-rest (pola M09 refresh token & M23/M10):
//   - yang tersimpan di DB hanya SHA-256 hash — DB bocor ≠ key bocor
//   - key penuh `bf_<40 hex>` HANYA muncul sekali saat dibuat (response 201)
//   - identifikasi di UI memakai `hint` (bf_abcdefgh…wxyz)
//
// Usage tracking (pola M24 buffer-then-flush):
//   request → bump Map in-memory (O(1)) → flush batch 30 detik ke DB.
//   Count real-time via merge buffer + DB saat list.
// ============================================================================

import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { generateId } from '../core/router.js';
import { checkRateLimit } from './rateLimiter.js';

// ─── Tipe & konstanta ─────────────────────────────────────────────────────────

export type ApiKeyScope = 'read' | 'write'; // write ⊇ read

export interface ApiKeyInfo {
  id: string;
  name: string;
  scope: ApiKeyScope;
  hint: string; // bf_ab12…wxyz — untuk identifikasi di UI
  created: string;
  lastUsed: string | null;
  requests: number;
}

export const API_KEY_RATE_LIMIT = 300; // request per menit per key
const API_KEY_PREFIX = 'bf_';

/** Error bawaan key auth — dipetakan route ke status HTTP. */
export class ApiKeyError extends Error {
  status: number;
  code: 'INVALID_API_KEY' | 'INSUFFICIENT_SCOPE' | 'RATE_LIMITED';
  constructor(status: number, code: ApiKeyError['code'], message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ─── Tabel _api_keys (per project DB) ─────────────────────────────────────────

export function initApiKeysTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _api_keys (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      key_hash  TEXT NOT NULL UNIQUE,
      key_hint  TEXT NOT NULL,
      scope     TEXT NOT NULL CHECK (scope IN ('read', 'write')),
      created   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_used TEXT,
      requests  INTEGER NOT NULL DEFAULT 0,
      revoked   INTEGER NOT NULL DEFAULT 0
    );
  `);
}

interface KeyRow {
  id: string; name: string; key_hash: string; key_hint: string;
  scope: string; created: string; last_used: string | null;
  requests: number; revoked: number;
}

function rowToInfo(row: KeyRow): ApiKeyInfo {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope as ApiKeyScope,
    hint: row.key_hint,
    created: row.created,
    lastUsed: row.last_used,
    requests: row.requests,
  };
}

function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function keyHint(key: string): string {
  return `${key.slice(0, 11)}…${key.slice(-4)}`;
}

// ─── CRUD (dipanggil admin routes) ────────────────────────────────────────────

export interface CreatedApiKey {
  info: ApiKeyInfo;
  /** key PENUH — hanya dikembalikan SEKALI di sini */
  key: string;
}

export function createApiKey(
  db: DatabaseSync,
  def: { name?: string; scope?: ApiKeyScope }
): CreatedApiKey {
  initApiKeysTable(db);
  const name = (def.name ?? '').trim() || 'unnamed key';
  if (name.length > 100) {
    throw new Error('API key name must be at most 100 characters');
  }
  const scope: ApiKeyScope = def.scope === 'read' ? 'read' : 'write';

  // 20 byte random = 160-bit entropi — brute force mustahil, format pendek
  const key = `${API_KEY_PREFIX}${crypto.randomBytes(20).toString('hex')}`;
  const id = generateId();

  db.prepare(
    `INSERT INTO _api_keys (id, name, key_hash, key_hint, scope) VALUES (?, ?, ?, ?, ?)`
  ).run(id, name, hashKey(key), keyHint(key), scope);

  const row = db.prepare('SELECT * FROM _api_keys WHERE id = ?').get(id) as unknown as KeyRow;
  return { info: rowToInfo(row), key };
}

export function listApiKeys(db: DatabaseSync): ApiKeyInfo[] {
  initApiKeysTable(db);
  const rows = db
    .prepare('SELECT * FROM _api_keys WHERE revoked = 0 ORDER BY created DESC')
    .all() as unknown as KeyRow[];

  // Merge buffer (real-time) — pola M24
  return rows.map((row) => {
    const info = rowToInfo(row);
    const buf = usageBuffer.get(row.id);
    if (buf) {
      info.requests += buf.requests;
      info.lastUsed = buf.lastUsed;
    }
    return info;
  });
}

export function revokeApiKey(db: DatabaseSync, keyId: string): boolean {
  initApiKeysTable(db);
  const result = db
    .prepare('UPDATE _api_keys SET revoked = 1 WHERE id = ? AND revoked = 0')
    .run(keyId);
  if (result.changes > 0) usageBuffer.delete(keyId);
  return result.changes > 0;
}

// ─── Usage buffer (pola M24: O(1) memory, flush batch) ────────────────────────

const usageBuffer = new Map<string, { pid: string; requests: number; lastUsed: string }>();

function trackKeyUsage(pid: string, keyId: string): void {
  const buf = usageBuffer.get(keyId) ?? { pid, requests: 0, lastUsed: '' };
  buf.requests += 1;
  buf.lastUsed = new Date().toISOString();
  usageBuffer.set(keyId, buf);
}

/** Flush semua counter ke DB masing-masing project. Dipanggil interval 30s. */
export function flushApiKeyUsage(projectDbOf: (pid: string) => DatabaseSync | null): number {
  if (usageBuffer.size === 0) return 0;
  const entries = [...usageBuffer.entries()];
  usageBuffer.clear();

  let flushed = 0;
  for (const [keyId, buf] of entries) {
    const db = projectDbOf(buf.pid);
    if (!db) continue;
    try {
      db.prepare(
        `UPDATE _api_keys SET requests = requests + ?, last_used = ? WHERE id = ?`
      ).run(buf.requests, buf.lastUsed, keyId);
      flushed++;
    } catch (err) {
      console.error('[api-keys] usage flush failed for', keyId, err);
    }
  }
  return flushed;
}

// ─── Resolusi key dari request (dipanggil resolveEndUserCtx) ─────────────────

/** Ambil kandidat key dari header: X-API-Key, atau Bearer bf_... (bukan JWT). */
export function extractApiKey(headers: Record<string, unknown>): string | null {
  const xKey = headers['x-api-key'];
  if (typeof xKey === 'string' && xKey.startsWith(API_KEY_PREFIX)) {
    return xKey.trim();
  }
  const auth = headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token.startsWith(API_KEY_PREFIX)) return token;
  }
  return null;
}

export interface ApiKeyAccess {
  keyId: string;
  scope: ApiKeyScope;
}

/**
 * Validasi sebuah API key terhadap project DB + scope yang dibutuhkan route.
 * Melempar ApiKeyError (401 invalid / 403 scope / 429 rate limit).
 * Sukses → ApiKeyAccess (route memperlakukan request sebagai service/bypass).
 *
 * ASYNC: rate limiter M18d berbasis Redis/memory adalah async.
 */
export async function resolveApiKey(
  db: DatabaseSync,
  key: string,
  opts: { write?: boolean; pid: string }
): Promise<ApiKeyAccess> {
  initApiKeysTable(db);
  const row = db
    .prepare('SELECT * FROM _api_keys WHERE key_hash = ? AND revoked = 0')
    .get(hashKey(key)) as unknown as KeyRow | undefined;

  if (!row) {
    throw new ApiKeyError(401, 'INVALID_API_KEY', 'Invalid or revoked API key');
  }

  if (opts.write && row.scope !== 'write') {
    throw new ApiKeyError(
      403,
      'INSUFFICIENT_SCOPE',
      "This API key is read-only — a 'write' scope key is required for this operation"
    );
  }

  // Rate limit per key (terpisah dari per-IP) — M18d: ASYNC
  if (!(await checkRateLimit(`apikey:${row.id}`, API_KEY_RATE_LIMIT, 60_000))) {
    throw new ApiKeyError(
      429,
      'RATE_LIMITED',
      `API key rate limit exceeded (${API_KEY_RATE_LIMIT} requests/minute)`
    );
  }

  // Usage in-memory (pola M24 — pid disimpan dalam entry utk flush)
  trackKeyUsage(opts.pid, row.id);

  return { keyId: row.id, scope: row.scope as ApiKeyScope };
}
