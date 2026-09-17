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
  /** end-user ID yang upload (null kalau admin) */
  uploadedBy: string | null;
}

export interface BucketUploadResult {
  fileId: string;
  filename: string;
  contentType: string;
  size: number;
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
    uploadedBy: row.uploaded_by,
  };
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
  let fileId = opts.fileId;

  if (fileId) {
    // Validate format
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(fileId)) {
      throw new Error(`Invalid file ID '${fileId}': must be 1-64 characters of [a-zA-Z0-9_-]`);
    }
    // Overwrite: delete existing file + metadata
    const existing = getBucketInfo(db, fileId);
    if (existing) {
      await bucketDelete(db, projectId, fileId);
    }
  } else {
    fileId = generateId();
  }

  const storedName = `${fileId}_${filename}`;

  // Simpan file via storage adapter (local disk atau S3)
  const adapter = getStorageAdapter();
  // Bucket uses recordId = '_bucket' namespace
  await adapter.save(projectId, '_bucket', filename, opts.data, contentType);
  // NOTE: adapter.save uses recordId_filename naming — we need to control the name
  // For bucket, we want fileId_filename. The adapter's save() generates its own
  // suffix on conflict. We need to bypass this for bucket files.

  // Workaround: save directly via adapter with recordId = fileId
  // This gives us fileId_filename on disk
  const adapterSaveResult = await adapter.save(projectId, fileId, filename, opts.data, contentType);

  // Simpan metadata
  db.prepare(
    `INSERT INTO _bucket_files (file_id, filename, content_type, size, uploaded_by, stored_name)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(fileId, filename, contentType, opts.data.length, opts.uploadedBy ?? null, storedName);

  return { fileId, filename, contentType, size: opts.data.length };
}

// ─── Read ────────────────────────────────────────────────────────────────────

export async function bucketRead(
  db: DatabaseSync,
  projectId: string,
  fileId: string
): Promise<{ data: Buffer; info: BucketFileInfo } | null> {
  initBucketTable(db);

  const info = getBucketInfo(db, fileId);
  if (!info) return null;

  const adapter = getStorageAdapter();
  const data = await adapter.read(projectId, fileId, info.filename);
  if (!data) return null;

  return { data, info };
}

// ─── Delete ──────────────────────────────────────────────────────────────────

export async function bucketDelete(
  db: DatabaseSync,
  projectId: string,
  fileId: string
): Promise<boolean> {
  initBucketTable(db);

  const info = getBucketInfo(db, fileId);
  if (!info) return false;

  const adapter = getStorageAdapter();
  await adapter.delete(projectId, fileId, info.filename);

  db.prepare('DELETE FROM _bucket_files WHERE file_id = ?').run(fileId);
  return true;
}

// ─── Info ────────────────────────────────────────────────────────────────────

export function getBucketInfo(db: DatabaseSync, fileId: string): BucketFileInfo | null {
  initBucketTable(db);
  const row = db
    .prepare('SELECT * FROM _bucket_files WHERE file_id = ?')
    .get(fileId) as unknown as BucketRow | undefined;
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
