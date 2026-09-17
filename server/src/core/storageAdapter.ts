// ============================================================================
// M30: STORAGE ADAPTER — abstraction layer untuk LocalDisk vs S3-compatible
//
// Interface tunggal untuk SEMUA operasi file storage. Route handler dan
// records.ts TIDAK TAHU backend apa yang aktif — mereka memanggil fungsi
// yang sama, adapter yang menentukan ke mana file pergi.
//
// Adapters:
//   LocalDiskAdapter (default) — fs sync, path traversal guarded
//   S3Adapter — AWS Signature V4, fetch-based, kompatibel R2/MinIO/Spaces/B2
//
// Konfigurasi runtime: platform.db `_platform_settings` key='storage' →
// atau env vars (S3_ENDPOINT, S3_BUCKET, dst.) → fallback local disk.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getPlatformDb } from './platformDb.js';
import { generateId } from './router.js';
import { S3Config, s3Put, s3Get, s3Delete, s3List, s3HeadBucket, S3Object } from './s3.js';
import type { StoredFileInfo } from './storageTypes.js';

// ─── Interface ────────────────────────────────────────────────────────────────

export interface StorageAdapter {
  readonly backend: 'local' | 's3';

  /** Simpan file. Return nama file TERSIMPAN (mungkin beda dari asli). */
  save(projectId: string, recordId: string, filename: string, data: Buffer, contentType?: string): Promise<string>;

  /** Baca file. Return Buffer atau null jika tidak ada. */
  read(projectId: string, recordId: string, filename: string): Promise<Buffer | null>;

  /** Hapus satu file. Idempotent. */
  delete(projectId: string, recordId: string, filename: string): Promise<void>;

  /** Hapus SEMUA file milik record. Return jumlah yang dihapus. */
  deleteAll(projectId: string, recordId: string): Promise<number>;

  /** List file di project (untuk storage explorer). */
  list(projectId: string): Promise<StoredFileInfo[]>;

  /** Health check (untuk test koneksi dari dashboard). */
  healthCheck(): Promise<boolean>;
}

// ─── LocalDiskAdapter (default — behaviour identik storage.ts lama) ─────────

function storageRoot(): string {
  return process.env.STORAGE_DIR ?? path.join(process.cwd(), 'data', 'storage');
}

function localPath(projectId: string, storedName: string): string {
  return path.join(storageRoot(), projectId, storedName);
}

const MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.zip': 'application/zip',
};

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg']);

export class LocalDiskAdapter implements StorageAdapter {
  readonly backend = 'local' as const;

  async save(projectId: string, recordId: string, filename: string, data: Buffer): Promise<string> {
    const dir = path.join(storageRoot(), projectId);
    fs.mkdirSync(dir, { recursive: true });

    let stored = filename;
    let full = path.join(dir, `${recordId}_${stored}`);
    if (fs.existsSync(full)) {
      const ext = path.extname(filename);
      const base = path.basename(filename, ext);
      stored = `${base}_${generateId(6)}${ext}`;
      full = path.join(dir, `${recordId}_${stored}`);
    }

    fs.writeFileSync(full, data);
    return stored;
  }

  async read(projectId: string, recordId: string, filename: string): Promise<Buffer | null> {
    const dir = path.join(storageRoot(), projectId);
    const full = path.join(dir, `${recordId}_${filename}`);

    const resolved = path.resolve(full);
    if (!resolved.startsWith(path.resolve(dir) + path.sep)) {
      return null; // path traversal
    }
    try {
      return fs.readFileSync(resolved);
    } catch {
      return null;
    }
  }

  async delete(projectId: string, recordId: string, filename: string): Promise<void> {
    try {
      fs.unlinkSync(path.join(storageRoot(), projectId, `${recordId}_${filename}`));
    } catch {
      // idempotent
    }
  }

  async deleteAll(projectId: string, recordId: string): Promise<number> {
    const dir = path.join(storageRoot(), projectId);
    let count = 0;
    try {
      const prefix = `${recordId}_`;
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(prefix)) {
          fs.unlinkSync(path.join(dir, f));
          count++;
        }
      }
    } catch {
      // folder belum ada
    }
    return count;
  }

  async list(projectId: string): Promise<StoredFileInfo[]> {
    const dir = path.join(storageRoot(), projectId);
    if (!fs.existsSync(dir)) return [];

    const result: StoredFileInfo[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const storedName = entry.name;
      const underscoreIdx = storedName.indexOf('_');
      if (underscoreIdx === -1) continue;
      const recordId = storedName.slice(0, underscoreIdx);
      const filename = storedName.slice(underscoreIdx + 1);
      const fullPath = path.join(dir, storedName);
      try {
        const stat = fs.statSync(fullPath);
        const ext = path.extname(filename).toLowerCase();
        result.push({
          name: filename,
          recordId,
          storedName,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          mime: MIME_MAP[ext] ?? 'application/octet-stream',
          isImage: IMAGE_EXTS.has(ext),
          collectionName: null,
          isOrphaned: false,
        });
      } catch {
        // skip
      }
    }
    result.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    return result;
  }

  async healthCheck(): Promise<boolean> {
    try {
      fs.accessSync(storageRoot());
      return true;
    } catch {
      return false;
    }
  }
}

// ─── S3Adapter (AWS S3 / Cloudflare R2 / MinIO / DO Spaces) ─────────────────

export class S3Adapter implements StorageAdapter {
  readonly backend = 's3' as const;
  private config: S3Config;

  constructor(config: S3Config) {
    this.config = config;
  }

  private s3Key(projectId: string, storedName: string): string {
    const prefix = this.config.prefix ? `${this.config.prefix}/` : '';
    return `${prefix}${projectId}/${storedName}`;
  }

  async save(projectId: string, recordId: string, filename: string, data: Buffer, contentType?: string): Promise<string> {
    // Anti-tabrakan: cek apakah key sudah ada (S3 PUT overwrites silently)
    const existingKey = this.s3Key(projectId, `${recordId}_${filename}`);
    let stored = filename;
    if (await s3Get(this.config, existingKey)) {
      const ext = path.extname(filename);
      const base = path.basename(filename, ext);
      stored = `${base}_${generateId(6)}${ext}`;
    }

    const key = this.s3Key(projectId, `${recordId}_${stored}`);
    const ok = await s3Put(this.config, key, data, contentType ?? MIME_MAP[path.extname(filename).toLowerCase()] ?? 'application/octet-stream');
    if (!ok) throw new Error(`S3 PUT failed for ${key}`);
    return stored;
  }

  async read(projectId: string, recordId: string, filename: string): Promise<Buffer | null> {
    const key = this.s3Key(projectId, `${recordId}_${filename}`);
    return s3Get(this.config, key);
  }

  async delete(projectId: string, recordId: string, filename: string): Promise<void> {
    const key = this.s3Key(projectId, `${recordId}_${filename}`);
    await s3Delete(this.config, key);
  }

  async deleteAll(projectId: string, recordId: string): Promise<number> {
    const prefix = `${projectId}/${recordId}_`;
    const objects = await s3List(this.config, prefix);
    let count = 0;
    for (const obj of objects) {
      await s3Delete(this.config, obj.key);
      count++;
    }
    return count;
  }

  async list(projectId: string): Promise<StoredFileInfo[]> {
    const objects: S3Object[] = await s3List(this.config, `${projectId}/`);
    const result: StoredFileInfo[] = [];

    for (const obj of objects) {
      // key format: <prefix>/<projectId>/<recordId>_<filename>
      const relativeKey = obj.key.replace(
        new RegExp(`^${this.config.prefix ? this.config.prefix + '/' : ''}${projectId}/`),
        ''
      );
      const underscoreIdx = relativeKey.indexOf('_');
      if (underscoreIdx === -1) continue;
      const recordId = relativeKey.slice(0, underscoreIdx);
      const filename = relativeKey.slice(underscoreIdx + 1);
      const ext = path.extname(filename).toLowerCase();

      result.push({
        name: filename,
        recordId,
        storedName: relativeKey,
        size: obj.size,
        mtime: obj.lastModified,
        mime: MIME_MAP[ext] ?? 'application/octet-stream',
        isImage: IMAGE_EXTS.has(ext),
        collectionName: null,
        isOrphaned: false,
      });
    }
    result.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    return result;
  }

  async healthCheck(): Promise<boolean> {
    return s3HeadBucket(this.config);
  }
}

// ─── Factory + Config Resolution ──────────────────────────────────────────────

export interface StorageConfig {
  backend: 'local' | 's3';
  s3?: S3Config;
}

let cachedAdapter: StorageAdapter | null = null;

/** Resolve konfigurasi: DB runtime → env → default local. */
function resolveConfig(): StorageConfig {
  // 1. Runtime config dari platform.db
  try {
    const db = getPlatformDb();
    db.exec(`CREATE TABLE IF NOT EXISTS _platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const row = db.prepare("SELECT value FROM _platform_settings WHERE key = 'storage'").get() as { value: string } | undefined;
    if (row) {
      const parsed = JSON.parse(row.value);
      if (parsed.backend === 's3' && parsed.s3?.endpoint && parsed.s3?.bucket) {
        return parsed as StorageConfig;
      }
    }
  } catch { /* DB belum ada — lanjut ke env */ }

  // 2. Environment variables
  const endpoint = process.env.S3_ENDPOINT;
  if (endpoint && process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY) {
    return {
      backend: 's3',
      s3: {
        endpoint,
        region: process.env.S3_REGION ?? 'us-east-1',
        bucket: process.env.S3_BUCKET,
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        prefix: process.env.S3_PREFIX,
      },
    };
  }

  // 3. Default: local disk
  return { backend: 'local' };
}

/**
 * Get active storage adapter. Cached — call resetStorageAdapter() setelah
 * konfigurasi berubah.
 */
export function getStorageAdapter(): StorageAdapter {
  if (cachedAdapter) return cachedAdapter;
  const config = resolveConfig();
  cachedAdapter = config.backend === 's3' && config.s3
    ? new S3Adapter(config.s3)
    : new LocalDiskAdapter();
  return cachedAdapter;
}

/** Reset cache adapter (dipanggil setelah update konfigurasi). */
export function resetStorageAdapter(): void {
  cachedAdapter = null;
}

/** Info konfigurasi untuk dashboard (secret disamarkan). */
export function getStorageInfo(): { backend: string; s3?: Partial<S3Config> & { hasCredentials: boolean } } {
  const config = resolveConfig();
  if (config.backend === 's3' && config.s3) {
    return {
      backend: 's3',
      s3: {
        endpoint: config.s3.endpoint,
        region: config.s3.region,
        bucket: config.s3.bucket,
        prefix: config.s3.prefix,
        hasCredentials: true,
      },
    };
  }
  return { backend: 'local' };
}

/** Simpan konfigurasi storage ke platform.db (runtime config). */
export function saveStorageConfig(config: { backend: 'local' | 's3'; s3?: S3Config }): void {
  const db = getPlatformDb();
  db.exec(`CREATE TABLE IF NOT EXISTS _platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

  // Simpan s3 config TANPA secret (secret dari env atau disimpan encrypted)
  const toStore: Record<string, unknown> = { backend: config.backend };
  if (config.s3) {
    toStore.s3 = {
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      bucket: config.s3.bucket,
      prefix: config.s3.prefix,
      accessKeyId: config.s3.accessKeyId,
      secretAccessKey: config.s3.secretAccessKey, // TODO: encrypt at-rest
    };
  }

  db.prepare(
    `INSERT INTO _platform_settings (key, value) VALUES ('storage', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(JSON.stringify(toStore));

  resetStorageAdapter();
}
