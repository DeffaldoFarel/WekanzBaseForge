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
const PENDING_BUCKET_PHYSICAL_RE = /(?:^|_)[a-f0-9]{32}(?:\.[a-zA-Z0-9]{1,16})?$/;

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

  // M35: file bucket (decoupled) — recordId-nya = fileId di tabel _bucket_files,
  // BUKAN id record koleksi. Tanpa pengecekan ini SEMUA file bucket salah
  // ditandai orphaned, dan "Clean Orphaned Files" akan menghapus file sah
  // (data loss — termasuk lampiran hasil migrasi).
  const bucketById = new Map<string, { filename: string; contentType: string; storedName: string }>();
  try {
    const rows = db.prepare('SELECT file_id, filename, content_type, stored_name FROM _bucket_files').all() as {
      file_id: string; filename: string; content_type: string; stored_name: string;
    }[];
    for (const row of rows) {
      bucketById.set(row.file_id, {
        filename: row.filename, contentType: row.content_type, storedName: row.stored_name,
      });
    }
  } catch {
    // tabel _bucket_files belum ada → project tanpa file bucket
  }

  const bucketRows = [...bucketById.entries()].sort((a, b) => b[0].length - a[0].length);

  return files.flatMap((f): StoredFileInfo[] => {
    // Storage adapters historically split physical names at the FIRST
    // underscore. Bucket IDs themselves may contain underscores, so recover
    // identity from the authoritative metadata row and the full stored name.
    // Longest-prefix matching avoids a short ID shadowing a longer one.
    const bucketMatch = bucketRows.find(([fileId, row]) =>
      f.storedName === row.storedName ||
      (f.storedName.startsWith(`${fileId}_`) && PENDING_BUCKET_PHYSICAL_RE.test(f.storedName))
    );
    if (bucketMatch) {
      const [fileId, bucket] = bucketMatch;
      if (bucket.storedName !== f.storedName) {
        // Old/pending physical version: it is not a second logical file, and
        // must not be offered to generic orphan cleanup.
        return [];
      }
      const mime = bucket.contentType || f.mime;
      return [{
        ...f,
        recordId: fileId,
        name: bucket.filename,
        mime,
        isImage: mime.startsWith('image/'),
        collectionName: recordMap.get(fileId) ?? null,
        isBucket: true,
        isOrphaned: false,
      }];
    }

    return [{
      ...f,
      collectionName: recordMap.get(f.recordId) ?? null,
      isBucket: false,
      // A first upload can already have a physical object while its metadata
      // INSERT is still pending. Do not classify version-named objects as
      // cleanable orphans without a separate, coordinated retention process.
      isOrphaned: !PENDING_BUCKET_PHYSICAL_RE.test(f.storedName) && !recordMap.has(f.recordId),
    }];
  });
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
