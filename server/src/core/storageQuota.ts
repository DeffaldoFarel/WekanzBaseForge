// ============================================================================
// AUD-4-04: STORAGE QUOTA — batas pemakaian disk per project
//
// Sebelumnya tidak ada kuota apa pun: satu user end-user (registrasi gratis)
// bisa mengisi disk shared server hingga penuh — disk exhaustion DoS untuk
// SELURUH platform multi-tenant (DB WAL ikut gagal menulis).
//
// Desain:
//   - Kuota = jumlah byte (0 = unlimited), default 1 GB per project.
//   - Disimpan di tabel `_project_settings` project DB (key-value) —
//     diatur admin via PUT /api/admin/projects/:pid/storage/quota.
//   - Pemakaian dihitung LANGSUNG dari adapter.list(projectId) = total byte
//     objek fisik di disk (file record + bucket + semuanya). Tidak ada
//     counter yang bisa drift — penghitungan hidup dari satu sumber kebenaran.
//   - Diterapkan di DUA pintu masuk upload: bucket upload (bucketRoutes) dan
//     multipart record (multipartToRecordData via optional db param).
// ============================================================================

import type { DatabaseSync } from 'node:sqlite';
import { getStorageAdapter } from './storageAdapter.js';

/** Default: 1 GB per project. Admin dapat menaikkan/menurunkan per project. */
export const DEFAULT_STORAGE_QUOTA_BYTES = 1024 * 1024 * 1024;

export class StorageQuotaExceededError extends Error {
  constructor(
    readonly usedBytes: number,
    readonly quotaBytes: number,
    readonly incomingBytes: number
  ) {
    super(
      `Storage quota exceeded: this project already uses ${usedBytes} bytes and this upload adds ${incomingBytes} bytes, exceeding the ${quotaLabel(quotaBytes)} limit. Ask the project admin to raise the storage quota.`
    );
    this.name = 'StorageQuotaExceededError';
  }
}

function quotaLabel(bytes: number): string {
  return `${bytes} byte${bytes === 1 ? '' : 's'}`;
}

// ─── Tabel setting per project (idempotent) ──────────────────────────────────

export function initProjectSettingsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _project_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

/** Kuota storage project (byte). 0 = unlimited. Default 1 GB. */
export function getStorageQuotaBytes(db: DatabaseSync): number {
  try {
    initProjectSettingsTable(db);
    const row = db
      .prepare("SELECT value FROM _project_settings WHERE key = 'storage_quota_bytes'")
      .get() as { value: string } | undefined;
    if (!row) return DEFAULT_STORAGE_QUOTA_BYTES;
    const n = parseInt(row.value, 10);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_STORAGE_QUOTA_BYTES;
  } catch {
    return DEFAULT_STORAGE_QUOTA_BYTES;
  }
}

/** Set kuota storage project (byte). 0 = unlimited. */
export function setStorageQuotaBytes(db: DatabaseSync, bytes: number): void {
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) {
    throw new Error('storage quota must be a non-negative integer number of bytes (0 = unlimited)');
  }
  initProjectSettingsTable(db);
  db.prepare(
    `INSERT INTO _project_settings (key, value) VALUES ('storage_quota_bytes', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(bytes));
}

// ─── Pemakaian (dihitung hidup dari storage adapter) ─────────────────────────

/** Total byte seluruh objek fisik project (file record + bucket). */
export async function getStorageUsageBytes(projectId: string): Promise<number> {
  const files = await getStorageAdapter().list(projectId);
  return files.reduce((acc, f) => acc + f.size, 0);
}

/**
 * Lempar StorageQuotaExceededError bila upload sebesar `incomingBytes`
 * akan melewati kuota project. Dipanggil di pintu upload SETELAH ukuran
 * file diketahui dan SEBELUM data disimpan.
 */
export async function assertStorageQuota(
  projectId: string,
  db: DatabaseSync,
  incomingBytes: number
): Promise<void> {
  const quota = getStorageQuotaBytes(db);
  if (quota === 0) return; // unlimited
  const used = await getStorageUsageBytes(projectId);
  if (used + incomingBytes > quota) {
    throw new StorageQuotaExceededError(used, quota, incomingBytes);
  }
}
