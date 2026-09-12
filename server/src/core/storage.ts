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
import { generateId } from './router.js';

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
