// ============================================================================
// M14: STORAGE ROUTES — serving file dengan aman
//
// GET /api/files/:pid/:collection/:rid/:filename
//
// Rules: file mengikuti viewRule collection-nya (record harus "terlihat"
// oleh peminta — kalau tidak, 404).
//
// Content-Type dari WHITELIST ekstensi — tidak pernah menebak dari isi.
// Ekstensi tidak dikenal → application/octet-stream (browser download,
// TIDAK dieksekusi sebagai HTML — ini pertahanan XSS).
// ============================================================================

import { Router } from '../core/router.js';
import { getProjectDb } from '../core/projectDbManager.js';
import { getCollectionByName } from '../core/schema.js';
import { getRecord } from '../core/records.js';
import { readFile, storedFilenames, deleteFile, listProjectStorageFiles, cleanOrphanedFiles } from '../core/storage.js';
import { RequestContext } from '../core/query/sqlBuilder.js';
import { verifyToken } from '../auth/jwt.js';
import { requireAdmin, validateToken } from '../platform/adminAuth.js';
import { getThumb, isThumbable } from '../core/thumbs.js';

// ─── Whitelist ekstensi → MIME ───────────────────────────────────────────────
// Sengaja TIDAK ada .html/.svg/.js — ekstensi aktif selalu jadi download.
const MIME_WHITELIST: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
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

function mimeFor(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  return MIME_WHITELIST[ext] ?? 'application/octet-stream';
}

export function createStorageRouter(): Router {
  const router = new Router();

  router.get('/api/files/:pid/:collection/:rid/:filename', async (req, res) => {
    try {
      const { pid, collection, rid, filename } = req.params;

      // ── Identitas peminta (admin bypass, end user via JWT) ──
      let reqCtx: RequestContext | undefined;
      const auth = req.headers.authorization;
      const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
      if (bearer) {
        if (validateToken(bearer)) {
          reqCtx = undefined; // admin — bypass
        } else {
          const result = await verifyToken(bearer);
          reqCtx = result.valid && result.payload
            ? { auth: { id: String(result.payload.sub ?? ''), email: String(result.payload.email ?? '') } }
            : { auth: null };
        }
      } else {
        reqCtx = { auth: null }; // anonymous
      }

      // ── Record harus "terlihat" (viewRule diterapkan getRecord) ──
      const db = getProjectDb(pid);
      const meta = getCollectionByName(db, collection);
      if (!meta) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Collection tidak ditemukan' } });
        return;
      }
      const record = getRecord(db, collection, rid, reqCtx);
      if (!record) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record tidak ditemukan' } });
        return;
      }

      // ── File harus benar-benar milik record (anti enumeration) ──
      // Cek ke SEMUA field file di collection ini.
      const fileFields = meta.fields.filter((f) => f.type === 'file');
      let owned = false;
      for (const f of fileFields) {
        if (storedFilenames(record[f.name]).includes(filename)) {
          owned = true;
          break;
        }
      }
      if (!owned) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File tidak ditemukan' } });
        return;
      }

      // ── Baca dari disk (path traversal dicegah di storage.ts) ──
      const data = readFile(pid, rid, filename);
      if (!data) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File tidak ditemukan' } });
        return;
      }

      // ── M14b: ?thumb=WxH → generate/ambil thumbnail (lazy + cache) ──
      const thumbSpec = req.query.get('thumb');
      let serveData = data;
      if (thumbSpec) {
        if (!isThumbable(filename)) {
          res.status(400).json({
            error: { code: 'BAD_REQUEST', message: 'Thumbnail hanya untuk jpg/png/gif/webp' },
          });
          return;
        }
        try {
          serveData = await getThumb(pid, rid, filename, thumbSpec, data);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Gagal membuat thumbnail';
          res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
          return;
        }
      }

      const mime = mimeFor(filename);
      res.raw.setHeader('Content-Type', mime);
      res.raw.setHeader('Content-Length', String(serveData.length));
      res.raw.setHeader('Cache-Control', 'public, max-age=3600');
      // Ekstensi tidak dikenal → paksa download (jangan render!)
      if (mime === 'application/octet-stream') {
        res.raw.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      }
      res.raw.end(serveData);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(500).json({ error: { code: 'INTERNAL', message } });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ADMIN STORAGE EXPLORER ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/admin/projects/:pid/storage/files — list semua file fisik di disk project
  router.get('/api/admin/projects/:pid/storage/files', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const files = listProjectStorageFiles(req.params.pid, db);

      const totalFiles = files.length;
      const totalSize = files.reduce((acc, f) => acc + f.size, 0);
      const orphanedCount = files.filter((f) => f.isOrphaned).length;

      res.json({
        files,
        stats: {
          totalFiles,
          totalSize,
          orphanedCount,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(500).json({ error: { code: 'INTERNAL', message } });
    }
  });

  // DELETE /api/admin/projects/:pid/storage/files/:rid/:filename — hapus 1 file
  router.delete('/api/admin/projects/:pid/storage/files/:rid/:filename', requireAdmin, (req, res) => {
    try {
      const { pid, rid, filename } = req.params;
      deleteFile(pid, rid, filename);
      res.json({ success: true, message: `File ${filename} berhasil dihapus` });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(500).json({ error: { code: 'INTERNAL', message } });
    }
  });

  // POST /api/admin/projects/:pid/storage/clean-orphans — bersihkan file yatim
  router.post('/api/admin/projects/:pid/storage/clean-orphans', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const cleaned = cleanOrphanedFiles(req.params.pid, db);
      res.json({ success: true, cleaned });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(500).json({ error: { code: 'INTERNAL', message } });
    }
  });

  return router;
}
