// ============================================================================
// M14: STORAGE MANAGER — simpan/baca/hapus file di disk
//
// Layout: <DATA_DIR>/storage/<projectId>/<recordId>_<filename>
//
// Kenapa recordId di prefix nama file? Supaya:
// 1. File mudah dilacak ke record pemiliknya
// 2. Dua record boleh punya nama file sama tanpa tabrakan
// 3. Hapus record → hapus semua file dengan prefix recordId (mudah!)
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { generateId } from './router.js';
import { listCollections } from './schema.js';

// Direktori root storage — bisa dioverride via env (berguna untuk test)
export function storageRoot(): string {
  return process.env.STORAGE_DIR ?? path.join(process.cwd(), 'data', 'storage');
}

function projectDir(projectId: string): string {
  return path.join(storageRoot(), projectId);
}

// ─── Simpan file ─────────────────────────────────────────────────────────────
// Returns: nama file TERSIMPAN (beda dari asli kalau ada duplikat di record sama)

export function saveFile(
  projectId: string,
  recordId: string,
  filename: string,
  data: Buffer
): string {
  const dir = projectDir(projectId);
  fs.mkdirSync(dir, { recursive: true });

  // Anti-tabrakan: kalau file dengan nama sama sudah ada di record ini,
  // tambahkan suffix random pendek.
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

// ─── Baca file (dengan pertahanan path traversal ganda) ─────────────────────

export function readFile(projectId: string, recordId: string, filename: string): Buffer | null {
  const dir = projectDir(projectId);
  const full = path.join(dir, `${recordId}_${filename}`);

  // Pertahanan #2: hasil resolve HARUS masih di dalam folder project
  const resolved = path.resolve(full);
  if (!resolved.startsWith(path.resolve(dir) + path.sep)) {
    return null; // percobaan path traversal
  }

  try {
    return fs.readFileSync(resolved);
  } catch {
    return null; // file tidak ada
  }
}

// ─── Hapus satu file ─────────────────────────────────────────────────────────

export function deleteFile(projectId: string, recordId: string, filename: string): void {
  try {
    fs.unlinkSync(path.join(projectDir(projectId), `${recordId}_${filename}`));
  } catch {
    // file sudah tidak ada — abaikan (idempotent)
  }
}

// ─── Hapus SEMUA file milik record (dipanggil saat record dihapus) ──────────

export function deleteRecordFiles(projectId: string, recordId: string): number {
  const dir = projectDir(projectId);
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
    // folder belum ada — tidak ada yang dihapus
  }
  return count;
}

// ─── Ekstrak nama file tersimpan dari nilai field file (string JSON/array) ──

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

// ─── STORAGE EXPLORER HELPERS ────────────────────────────────────────────────

export interface StoredFileInfo {
  name: string; // nama asli file
  recordId: string;
  storedName: string; // nama fisik di disk: <recordId>_<filename>
  size: number;
  mtime: string;
  mime: string;
  isImage: boolean;
  collectionName: string | null;
  isOrphaned: boolean;
}

const MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
};

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg']);

export function listProjectStorageFiles(projectId: string, db?: DatabaseSync): StoredFileInfo[] {
  const dir = projectDir(projectId);
  if (!fs.existsSync(dir)) return [];

  // Peta recordId -> collectionName untuk mencocokkan pemilik file
  const recordMap = new Map<string, string>();
  if (db) {
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
            // skip if error
          }
        }
      }
    } catch {
      // skip if error
    }
  }

  const result: StoredFileInfo[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    // Lewati subdirektori (misal thumbs_*)
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
      const mime = MIME_MAP[ext] ?? 'application/octet-stream';
      const isImage = IMAGE_EXTS.has(ext);
      const collectionName = recordMap.get(recordId) ?? null;
      const isOrphaned = db ? !recordMap.has(recordId) : false;

      result.push({
        name: filename,
        recordId,
        storedName,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        mime,
        isImage,
        collectionName,
        isOrphaned,
      });
    } catch {
      // skip unreadable
    }
  }

  // Urutkan paling baru di atas
  result.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return result;
}

export function cleanOrphanedFiles(projectId: string, db: DatabaseSync): number {
  const files = listProjectStorageFiles(projectId, db);
  let cleaned = 0;
  for (const f of files) {
    if (f.isOrphaned) {
      deleteFile(projectId, f.recordId, f.name);
      cleaned++;
    }
  }
  return cleaned;
}
