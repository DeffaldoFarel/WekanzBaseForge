// ============================================================================
// M14/M30: STORAGE MANAGER — delegasi ke StorageAdapter (local disk atau S3)
//
// M14 (original): fs sync, path traversal guarded
// M30: di-refactor menjadi async wrapper → StorageAdapter
//      Semua call site (routes, records, multipart) kini async.
//
// Fungsi yang diekspor di sini adalah KONTRAK yang dipakai seluruh aplikasi:
//   saveFile, readFile, deleteFile, deleteRecordFiles, storedFilenames,
//   listProjectStorageFiles, cleanOrphanedFiles
// ============================================================================

import type { DatabaseSync } from 'node:sqlite';
import { getStorageAdapter, getStorageAdapter as adapter } from './storageAdapter.js';
import { listCollections } from './schema.js';
import type { StoredFileInfo } from './storageTypes.js';

export type { StoredFileInfo };

// ─── Simpan file ─────────────────────────────────────────────────────────────

export async function saveFile(
  projectId: string,
  recordId: string,
  filename: string,
  data: Buffer,
  contentType?: string
): Promise<string> {
  return getStorageAdapter().save(projectId, recordId, filename, data, contentType);
}

// ─── Baca file ───────────────────────────────────────────────────────────────

export async function readFile(
  projectId: string,
  recordId: string,
  filename: string
): Promise<Buffer | null> {
  return getStorageAdapter().read(projectId, recordId, filename);
}

// ─── Hapus satu file ─────────────────────────────────────────────────────────

export async function deleteFile(
  projectId: string,
  recordId: string,
  filename: string
): Promise<void> {
  return getStorageAdapter().delete(projectId, recordId, filename);
}

// ─── Hapus SEMUA file milik record ──────────────────────────────────────────

export async function deleteRecordFiles(projectId: string, recordId: string): Promise<number> {
  return getStorageAdapter().deleteAll(projectId, recordId);
}

// ─── Ekstrak nama file tersimpan dari nilai field file ──────────────────────

export function storedFilenames(value: unknown): string[] {
  if (typeof value === 'string') {
    if (value.startsWith('[')) {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
      } catch {
        return [];
      }
    }
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((x): x is string => typeof x === 'string');
  }
  return [];
}

// ─── STORAGE EXPLORER (perlu db untuk enrichment) ────────────────────────────

export async function listProjectStorageFiles(
  projectId: string,
  db?: DatabaseSync
): Promise<StoredFileInfo[]> {
  const files = await getStorageAdapter().list(projectId);

  if (!db) return files;

  // Enrich: peta recordId → collectionName
  const recordMap = new Map<string, string>();
  try {
    const cols = listCollections(db);
    for (const col of cols) {
      const fileFields = col.fields.filter((f) => f.type === 'file');
      if (fileFields.length > 0) {
        try {
          const rows = db.prepare(`SELECT id FROM "${col.name}"`).all() as { id: string }[];
          for (const r of rows) {
            recordMap.set(r.id, col.name);
          }
        } catch {
          // skip
        }
      }
    }
  } catch {
    // skip
  }

  return files.map((f) => ({
    ...f,
    collectionName: recordMap.get(f.recordId) ?? null,
    isOrphaned: !recordMap.has(f.recordId),
  }));
}

export async function cleanOrphanedFiles(projectId: string, db: DatabaseSync): Promise<number> {
  const files = await listProjectStorageFiles(projectId, db);
  let cleaned = 0;
  for (const f of files) {
    if (f.isOrphaned) {
      await deleteFile(projectId, f.recordId, f.name);
      cleaned++;
    }
  }
  return cleaned;
}
