// ============================================================================
// M14b: THUMBNAILS — generate lazily ala PocketBase (pakai Sharp)
//
// PocketBase-style:
//   GET /api/files/.../photo.jpg?thumb=100x300  → crop dari center
//   ?thumb=100x300t → crop dari top
//   ?thumb=100x300b → crop dari bottom
//   ?thumb=100x300f → fit (tanpa crop, preserve aspect)
//   ?thumb=0x300    → resize by height (preserve ratio)
//   ?thumb=100x0    → resize by width  (preserve ratio)
//
// Lazily: thumbnail TIDAK dibuat saat upload — dibuat saat PERTAMA
// diminta, lalu cache di disk: thumbs_<filename>/<size>_<filename>
// Request berikutnya → baca cache (cepat, tanpa proses gambar).
//
// Sharp = native dependency (prebuilt binaries, tanpa compile).
// ============================================================================

import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

// ─── Format thumb yang didukung PocketBase ──────────────────────────────────

export interface ThumbSize {
  width: number; // 0 = auto (dari height)
  height: number; // 0 = auto (dari width)
  mode: '' | 't' | 'b' | 'f'; // center crop | top | bottom | fit
}

const THUMB_RE = /^(\d{1,5})x(\d{1,5})(t|b|f)?$/;

export function parseThumbSize(raw: string): ThumbSize | null {
  const m = raw.match(THUMB_RE);
  if (!m) return null;
  const width = parseInt(m[1], 10);
  const height = parseInt(m[2], 10);
  if (width === 0 && height === 0) return null; // 0x0 tidak bermakna
  return { width, height, mode: (m[3] as ThumbSize['mode']) ?? '' };
}

// ─── Ekstensi gambar yang didukung thumbnail ────────────────────────────────

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

export function isThumbable(filename: string): boolean {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return false;
  return IMAGE_EXTS.has(filename.slice(dot).toLowerCase());
}

// ─── Generate atau ambil dari cache ─────────────────────────────────────────
// Returns: Buffer thumbnail. Lempar Error dengan pesan ramah jika gagal.

export async function getThumb(
  projectId: string,
  recordId: string,
  filename: string,
  sizeSpec: string,
  originalBytes: Buffer
): Promise<Buffer> {
  const size = parseThumbSize(sizeSpec);
  if (!size) {
    throw new Error(`Format thumb tidak valid: '${sizeSpec}' (contoh: 100x300, 100x300t, 0x300f)`);
  }

  if (!isThumbable(filename)) {
    throw new Error(`File bukan gambar yang didukung (hanya jpg, png, gif, webp): '${filename}'`);
  }

  // ── Cache path: <projectDir>/thumbs_<filename>/<sizeSpec>_<filename> ──
  const dir = path.join(process.env.STORAGE_DIR ?? path.join(process.cwd(), 'data', 'storage'), projectId);
  const thumbDir = path.join(dir, `thumbs_${filename}`);
  const thumbPath = path.join(thumbDir, `${sizeSpec}_${filename}`);

  // Cache hit? → langsung balikin (tanpa proses gambar!)
  try {
    return await fs.promises.readFile(thumbPath);
  } catch {
    // cache miss — lanjut generate
  }

  // ── Generate dengan Sharp ──
  let pipeline = sharp(originalBytes, { failOn: 'none' });
  const { width, height, mode } = size;

  if (mode === 'f') {
    // fit: muat di dalam WxH tanpa crop, preserve aspect ratio
    pipeline = pipeline.resize(width || null, height || null, {
      fit: 'inside',
      withoutEnlargement: true,
    });
  } else if (width === 0 || height === 0) {
    // 0xH / Wx0: resize satu dimensi — sharp otomatis preserve aspect ratio
    pipeline = pipeline.resize({
      width: width || undefined,
      height: height || undefined,
      withoutEnlargement: true,
    });
  } else {
    // crop: center (default) / top / bottom
    // posisi crop: pocketbase-style t (top) / b (bottom) / center
    const position =
      mode === 't' ? 'top' : mode === 'b' ? 'bottom' : 'centre';
    pipeline = pipeline.resize(width, height, {
      fit: 'cover',
      position: position as 'top' | 'bottom' | 'centre',
    });
  }

  // PocketBase menyimpan webp thumbs sebagai PNG — ikuti saja (kompatibilitas)
  const outputExt = path.extname(filename).toLowerCase();
  const outType = outputExt === '.jpg' || outputExt === '.jpeg' ? 'jpeg' : 'png';
  const outBuffer =
    outType === 'jpeg' ? await pipeline.jpeg({ quality: 80 }).toBuffer() : await pipeline.png().toBuffer();

  // ── Simpan cache (async, fire-and-forget tidak aman utk race — pakai await) ──
  await fs.promises.mkdir(thumbDir, { recursive: true });
  await fs.promises.writeFile(thumbPath, outBuffer);

  return outBuffer;
}

// ─── Hapus semua thumb saat file asli dihapus ───────────────────────────────

export function deleteThumbs(projectId: string, filename: string): void {
  const dir = path.join(process.env.STORAGE_DIR ?? path.join(process.cwd(), 'data', 'storage'), projectId);
  const thumbDir = path.join(dir, `thumbs_${filename}`);
  try {
    fs.rmSync(thumbDir, { recursive: true, force: true });
  } catch {
    // sudah tidak ada — idempotent
  }
}
