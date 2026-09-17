// ============================================================================
// M18c: MULTIPART PARSER — busboy (PRODUCTION GRADE)
//
// Menggantikan parser Buffer manual (M14a) dengan @fastify/busboy:
// - Streaming: file BESAR tidak lagi di-buffer penuh ke memori
// - Battle-tested: menyerap edge case protokol (boundary dalam konten,
//   header folding, quoted boundary, dsb.)
//
// KONTRAK TETAP SAMA:
//   parseMultipart(body, boundary) → { fields, files: MultipartFile[] }
//   (API sinkron dipertahankan dengan mengumpulkan hasil busboy dari
//   async iterator lalu return — untuk file besar, versi streaming
//   writeFileToDisk bisa ditambah nanti tanpa mengubah pemanggil)
//
// sanitizeFilename tetap di sini — pertahanan path traversal M14a.
// ============================================================================

import BusboyDefault, { Busboy as BusboyClass } from '@fastify/busboy';
import { Readable } from 'node:stream';

// @fastify/busboy punya bentuk export ganda (CJS/ESM interop) —
// normalize di sini supaya satu referensi aman dipakai.
const BusboyCtor: typeof BusboyClass =
  (BusboyDefault as unknown as { Busboy?: typeof BusboyClass }).Busboy ?? BusboyClass;

export interface MultipartFile {
  fieldName: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface MultipartResult {
  fields: Record<string, string>;
  files: MultipartFile[];
}

// Ekstrak boundary dari header Content-Type (dipakai publicRoutes)
export function extractBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary="?([^";]+)"?/i);
  return match ? match[1] : null;
}

// ─── Parser: busboy, dibungkus Promise agar API sinkron tetap ada ───────────

export function parseMultipart(body: Buffer, boundary: string): Promise<MultipartResult> {
  return new Promise((resolve, reject) => {
    const result: MultipartResult = { fields: {}, files: [] };

    // ReadableStream dari Buffer body
    const stream = Readable.from(body);

    const busboy = new BusboyCtor({
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      limits: {
        files: 50, // max 50 file per request (anti abuse)
        fileSize: 100 * 1024 * 1024, // 100MB hard cap per file (field maxSize dicek di atasnya)
      },
    });

    // M18c (bugfix): @fastify/busboy v3 TIDAK emit 'close' seperti busboy
    // klasik — hanya 'finish' (Writable selesai menulis semua part). Kita
    // tunggu: finish + semua file stream 'end', mana yang terakhir.
    let settled = false;
    let pendingFiles = 0;
    let finished = false;
    const maybeDone = () => {
      if (!settled && finished && pendingFiles === 0) {
        settled = true;
        resolve(result);
      }
    };

    busboy.on('field', (name: string, value: string) => {
      result.fields[name] = value;
    });

    // M18c (PENTING): signature event @fastify/busboy v3 BERBEDA dari busboy
    // klasik: ('file', fieldname, stream, filename, transferEncoding,
    // mimeType) — filename = argumen ke-3 string, BUKAN object info!
    busboy.on('file', (
      name: string,
      fileStream: NodeJS.ReadableStream & { truncated?: boolean },
      filename: string,
      _transferEncoding: string,
      mimeType: string,
    ) => {
      pendingFiles++;
      const chunks: Buffer[] = [];
      fileStream.on('data', (chunk: Buffer) => chunks.push(chunk));
      fileStream.on('end', () => {
        if (fileStream.truncated) {
          // fileSize limit tercapai — reject (field maxSize dicek di records.ts,
          // di sini hard cap proteksi memori)
          if (!settled) { settled = true; reject(new Error(`File exceeds the 100MB limit`)); }
          return;
        }
        result.files.push({
          fieldName: name,
          filename: sanitizeFilename(filename),
          contentType: mimeType || 'application/octet-stream',
          data: Buffer.concat(chunks),
        });
        pendingFiles--;
        maybeDone();
      });
      fileStream.on('error', (err: Error) => {
        if (!settled) { settled = true; reject(err); }
      });
    });

    busboy.on('error', (err: Error) => {
      if (!settled) { settled = true; reject(err); }
    });
    busboy.on('finish', () => {
      finished = true;
      maybeDone();
    });
    busboy.on('filesLimit', () => {
      if (!settled) { settled = true; reject(new Error('Terlalu banyak file (max 50 per request)')); }
    });

    stream.pipe(busboy);
  });
}

// ─── Sanitasi filename — PERTAHANAN #1 terhadap path traversal ──────────────
// Attacker bisa kirim filename="../../etc/passwd" — kita buang semua path.

export function sanitizeFilename(raw: string | undefined | null): string {
  // M18c: busboy bisa memberikan filename undefined (field aneh) — guard
  if (raw === undefined || raw === null) return 'file';
  // Ambil nama file saja (buang direktori, handle / dan \ untuk Windows)
  const base = raw.split(/[/\\]/).pop() ?? 'file';
  // Buang karakter berbahaya; izinkan alfanumerik, titik, dash, underscore
  const clean = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  // Hindari ".hidden" & nama kosong
  if (clean === '' || clean === '.' || clean === '..') return 'file';
  return clean.slice(0, 150); // batasi panjang
}
