// ============================================================================
// M35: BUCKET STORAGE — decoupled file upload (ala Appwrite/S3 bucket)
//
// Komplementer storage.ts (record-attached):
//   Record storage (M14): file = field value di record (multipart → POST records)
//   Bucket storage (M35): file = entitas independen dengan fileId sendiri
//
// Pattern yang WekanzDashboard butuh:
//   upload(userId, file, filename, fileId?) → fileId
//   getFileUrl(fileId) → URL
//   deleteFile(fileId)
//
// Layout: <STORAGE_DIR>/<projectId>/_bucket/<fileId>_<filename>
//   _bucket prefix → terpisah dari record files (tidak bertabrakan)
//   Metadata: tabel _bucket_files di project DB (fileId → filename, size, mime, owner)
//
// Support determinate fileId (untuk migration dari Appwrite/Firebase):
//   fileId = md5(storagePath) ala WekanzDashboard attachments.ts
// ============================================================================

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generateId } from './router.js';
import { getStorageAdapter } from './storageAdapter.js';

// ─── Tipe ─────────────────────────────────────────────────────────────────────

export interface BucketFileInfo {
  fileId: string;
  filename: string;
  contentType: string;
  size: number;
  uploadedAt: string;
  /** Exact stored object pointer; changes on every overwrite. */
  storedName: string;
  /** end-user ID yang upload (null kalau admin) */
  uploadedBy: string | null;
}

export interface BucketUploadResult {
  fileId: string;
  filename: string;
  contentType: string;
  size: number;
}

/** Identity mismatch between a user upload and an existing bucket file. */
export class BucketOwnershipError extends Error {
  constructor() { super('File belongs to another user'); }
}

/** Concurrent writer won the same fileId; caller may re-read and retry. */
export class BucketConflictError extends Error {
  constructor() { super('Bucket file changed during this operation'); }
}

// ─── Tabel _bucket_files (per project DB) ──────────────────────────────────

export function initBucketTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _bucket_files (
      file_id      TEXT PRIMARY KEY,
      filename     TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size         INTEGER NOT NULL DEFAULT 0,
      uploaded_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      uploaded_by  TEXT,
      stored_name  TEXT NOT NULL  -- nama fisik di disk: <fileId>_<filename>
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bucket_files_owner ON _bucket_files (uploaded_by)`);
}

interface BucketRow {
  file_id: string; filename: string; content_type: string;
  size: number; uploaded_at: string; uploaded_by: string | null; stored_name: string;
}

function rowToInfo(row: BucketRow): BucketFileInfo {
  return {
    fileId: row.file_id,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    uploadedAt: row.uploaded_at,
    storedName: row.stored_name,
    uploadedBy: row.uploaded_by,
  };
}

function getBucketRow(db: DatabaseSync, fileId: string): BucketRow | null {
  return (db.prepare('SELECT * FROM _bucket_files WHERE file_id = ?').get(fileId) as unknown as BucketRow | undefined) ?? null;
}

/** Physical name is versioned; existing rows still use fileId_filename. */
function storageFilename(row: BucketRow): string {
  const prefix = `${row.file_id}_`;
  if (!row.stored_name.startsWith(prefix)) throw new Error('Invalid stored bucket filename');
  return row.stored_name.slice(prefix.length);
}

// ─── MIME detection ──────────────────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.zip': 'application/zip',
};

function mimeFor(filename: string, provided?: string): string {
  if (provided && provided !== 'application/octet-stream') return provided;
  const ext = path.extname(filename).toLowerCase();
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

// ─── Sanitize filename (anti path traversal) ───────────────────────────────

function sanitizeFilename(filename: string): string {
  // Ambil basename, ganti karakter berbahaya
  const base = path.basename(filename).replace(/[/\\?%*:|"<>\x00-\x1f]/g, '_');
  if (!base || base === '.' || base === '..') return 'file';
  return base.slice(0, 200); // cap panjang
}

// ─── Upload ──────────────────────────────────────────────────────────────────

/**
 * Upload file ke bucket → return fileId.
 *
 * @param fileId optional — determinate ID (untuk migration). Format: [a-zA-Z0-9_-]{1,64}
 *               Kalau tidak diisi → auto-generate.
 *               Kalau SUDAH ADA → file di-OVERWRITE (ala Appwrite behavior).
 */
export async function bucketUpload(
  db: DatabaseSync,
  projectId: string,
  opts: {
    filename: string;
    data: Buffer;
    contentType?: string;
    fileId?: string;
    uploadedBy?: string | null;
  }
): Promise<BucketUploadResult> {
  initBucketTable(db);

  const filename = sanitizeFilename(opts.filename);
  const contentType = mimeFor(filename, opts.contentType);
  const fileId = opts.fileId ?? generateId();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(fileId)) {
    throw new Error(`Invalid file ID '${fileId}': must be 1-64 characters of [a-zA-Z0-9_-]`);
  }

  const existing = getBucketRow(db, fileId);
  if (existing && opts.uploadedBy != null && existing.uploaded_by !== opts.uploadedBy) {
    throw new BucketOwnershipError();
  }

  // Every upload gets an opaque physical version name: two writers (or a
  // deletion) may share a logical fileId but never the same physical object.
  // The metadata pointer alone determines which version the URL resolves to.
  const physicalName = crypto.randomBytes(16).toString('hex') + path.extname(filename).slice(0, 16);
  const adapter = getStorageAdapter();
  const savedName = await adapter.save(projectId, fileId, physicalName, opts.data, contentType);
  const storedName = `${fileId}_${savedName}`;

  try {
    if (existing) {
      // Compare-and-swap guards against an intervening delete, owner change,
      // or second overwrite on a different process / DB connection.
      const changed = db.prepare(`UPDATE _bucket_files
        SET filename = ?, content_type = ?, size = ?, stored_name = ?, uploaded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE file_id = ? AND stored_name = ? AND uploaded_by IS ?`)
        .run(filename, contentType, opts.data.length, storedName,
          fileId, existing.stored_name, existing.uploaded_by).changes;
      if (changed !== 1) {
        const latest = getBucketRow(db, fileId);
        if (latest && opts.uploadedBy != null && latest.uploaded_by !== opts.uploadedBy) {
          throw new BucketOwnershipError();
        }
        throw new BucketConflictError();
      }
    } else {
      // An INSERT claims the ID atomically. If another writer inserted it
      // while our physical upload was in flight, discard only OUR version.
      db.prepare(`INSERT INTO _bucket_files (file_id, filename, content_type, size, uploaded_by, stored_name)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(fileId, filename, contentType, opts.data.length, opts.uploadedBy ?? null, storedName);
    }
  } catch (err) {
    await adapter.delete(projectId, fileId, savedName).catch(() => undefined);
    if (err instanceof Error && /UNIQUE constraint failed: _bucket_files\.file_id/.test(err.message)) {
      throw new BucketConflictError();
    }
    throw err;
  }

  if (existing) {
    // The new pointer is committed; failure to remove the old physical
    // version must not make the API report that the new write failed.
    try { await adapter.delete(projectId, fileId, storageFilename(existing)); }
    catch { console.warn('[bucket] old physical version cleanup failed'); }
  }
  return { fileId, filename, contentType, size: opts.data.length };
}

// ─── Read ────────────────────────────────────────────────────────────────────

export async function bucketRead(
  db: DatabaseSync,
  projectId: string,
  fileId: string
): Promise<{ data: Buffer; info: BucketFileInfo } | null> {
  initBucketTable(db);

  const row = getBucketRow(db, fileId);
  if (!row) return null;

  const adapter = getStorageAdapter();
  let data = await adapter.read(projectId, fileId, storageFilename(row));
  if (!data) {
    // An overwrite may have committed and removed the old physical version
    // between the metadata lookup and file read. Retry only with the latest
    // committed metadata; a concurrent deletion still returns null.
    const latest = getBucketRow(db, fileId);
    if (!latest || latest.stored_name === row.stored_name) return null;
    data = await adapter.read(projectId, fileId, storageFilename(latest));
    if (!data) return null;
    return { data, info: rowToInfo(latest) };
  }

  return { data, info: rowToInfo(row) };
}

// ─── Delete ──────────────────────────────────────────────────────────────────

export async function bucketDelete(
  db: DatabaseSync,
  projectId: string,
  fileId: string,
  expectedOwner?: string,
  expectedStoredName?: string
): Promise<boolean> {
  initBucketTable(db);
  const row = getBucketRow(db, fileId);
  if (!row) return false;
  if (expectedOwner !== undefined && row.uploaded_by !== expectedOwner) {
    throw new BucketOwnershipError();
  }
  if (expectedStoredName !== undefined && row.stored_name !== expectedStoredName) {
    throw new BucketConflictError();
  }

  // Revoke the ID synchronously, using a compare-and-swap of both owner and
  // physical version. A new upload may reuse the ID with a distinct object
  // that this delete cannot touch.
  const removed = db.prepare(`DELETE FROM _bucket_files
    WHERE file_id = ? AND stored_name = ? AND uploaded_by IS ?`)
    .run(fileId, row.stored_name, row.uploaded_by).changes;
  if (removed !== 1) {
    const latest = getBucketRow(db, fileId);
    if (latest && expectedOwner !== undefined && latest.uploaded_by !== expectedOwner) {
      throw new BucketOwnershipError();
    }
    throw new BucketConflictError();
  }

  const adapter = getStorageAdapter();
  try { await adapter.delete(projectId, fileId, storageFilename(row)); }
  catch { console.warn('[bucket] revoked object cleanup failed'); }
  return true;
}

// ─── Info ────────────────────────────────────────────────────────────────────

export function getBucketInfo(db: DatabaseSync, fileId: string): BucketFileInfo | null {
  initBucketTable(db);
  const row = getBucketRow(db, fileId);
  return row ? rowToInfo(row) : null;
}

// ─── List ────────────────────────────────────────────────────────────────────

export function listBucketFiles(
  db: DatabaseSync,
  opts: { uploadedBy?: string; limit?: number } = {}
): BucketFileInfo[] {
  initBucketTable(db);
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const sql = opts.uploadedBy
    ? 'SELECT * FROM _bucket_files WHERE uploaded_by = ? ORDER BY uploaded_at DESC LIMIT ?'
    : 'SELECT * FROM _bucket_files ORDER BY uploaded_at DESC LIMIT ?';
  const params = opts.uploadedBy ? [opts.uploadedBy, limit] : [limit];
  const rows = db.prepare(sql).all(...(params as never[])) as unknown as BucketRow[];
  return rows.map(rowToInfo);
}

// ─── URL builder ─────────────────────────────────────────────────────────────

/**
 * URL untuk mengakses bucket file — format ala Appwrite.
 * GET /api/files/:pid/bucket/:fileId
 */
export function bucketFileUrl(baseUrl: string, projectId: string, fileId: string): string {
  return `${baseUrl.replace(/\/$/, '')}/api/files/${projectId}/bucket/${encodeURIComponent(fileId)}`;
}
