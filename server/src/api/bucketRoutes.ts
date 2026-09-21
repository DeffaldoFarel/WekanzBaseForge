// ============================================================================
// M35: BUCKET ROUTES — decoupled file upload/serve/delete (ala Appwrite)
//
// POST   /api/p/:pid/storage/upload          → upload file (multipart) → fileId
// GET    /api/files/:pid/bucket/:fileId      → serve file (public URL)
// GET    /api/p/:pid/storage/bucket          → list files (auth user)
// DELETE /api/p/:pid/storage/bucket/:fileId  → delete file (auth user)
// POST   /api/admin/projects/:pid/storage/bucket/:fileId → admin delete
// ============================================================================

import fs from 'node:fs';
import { Router, type ForgeResponse } from '../core/router.js';
import { getProjectDb } from '../core/projectDbManager.js';
import { verifyToken } from '../auth/jwt.js';
import { requireAdmin } from '../platform/adminAuth.js';
import { extractApiKey, resolveApiKey, ApiKeyError } from '../auth/apiKeys.js';
import {
  bucketUpload,
  bucketRead,
  bucketDelete,
  getBucketInfo,
  listBucketFiles,
  bucketFileUrl,
} from '../core/bucketStorage.js';
import { parseMultipart } from '../core/multipart.js';
import { getThumb, isThumbable } from '../core/thumbs.js';

const MIME_WHITELIST_OVERRIDES: Record<string, string> = {
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
  return MIME_WHITELIST_OVERRIDES[ext] ?? 'application/octet-stream';
}

/** Resolve end-user dari Bearer JWT / API key / anonymous. */
async function resolveUser(req: { headers: Record<string, unknown> }): Promise<string | null> {
  const apiKey = extractApiKey(req.headers);
  if (apiKey) {
    // API key → service access, uploadedBy = null (service)
    return null;
  }
  const auth = req.headers.authorization;
  const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!bearer) return null;
  const result = await verifyToken(bearer);
  return result.valid && result.payload?.sub ? String(result.payload.sub) : null;
}

function clientIp(req: { headers: Record<string, unknown>; raw: { socket: { remoteAddress?: string } } }): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.raw.socket.remoteAddress ?? 'unknown';
}

export function createBucketRouter(): Router {
  const router = new Router();

  // ─── UPLOAD (multipart) ───────────────────────────────────────────────────

  router.post('/api/p/:pid/storage/upload', async (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const uploadedBy = await resolveUser(req);

      // Parse multipart
      const reqExt = req as { isMultipart?: boolean; rawBody?: Buffer; headers: { 'content-type'?: string } };
      if (!reqExt.isMultipart || !reqExt.rawBody) {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'Content-Type must be multipart/form-data' },
        });
        return;
      }

      const contentType = reqExt.headers['content-type'] ?? '';
      const boundary = contentType.match(/boundary="?([^";]+)"?/i)?.[1];
      if (!boundary) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing multipart boundary' } });
        return;
      }

      const parsed = await parseMultipart(reqExt.rawBody, boundary);
      const file = parsed.files[0]; // Ambil file pertama
      if (!file) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'No file provided in multipart body' } });
        return;
      }

      // Optional fileId dari form field
      const requestedFileId = parsed.fields.fileId || parsed.fields.id || undefined;

      const result = await bucketUpload(db, req.params.pid, {
        filename: file.filename,
        data: file.data,
        contentType: file.contentType,
        fileId: requestedFileId,
        uploadedBy,
      });

      const url = bucketFileUrl(
        `${req.headers['x-forwarded-proto'] ?? 'http'}://${req.headers.host}`,
        req.params.pid,
        result.fileId
      );

      res.status(201).json({
        fileId: result.fileId,
        filename: result.filename,
        contentType: result.contentType,
        size: result.size,
        url,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      res.status(400).json({ error: { code: 'UPLOAD_FAILED', message } });
    }
  });

  // ─── SERVE FILE (public URL) ──────────────────────────────────────────────

  router.get('/api/files/:pid/bucket/:fileId', async (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const result = await bucketRead(db, req.params.pid, req.params.fileId);
      if (!result) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File not found' } });
        return;
      }

      const mime = result.info.contentType || mimeFor(result.info.filename);

      // M35+M14b: ?thumb=WxH — grid storage meminta thumbnail untuk SETIAP
      // file gambar. Endpoint ini dulu MENGABAIKAN thumb dan mengirim file
      // asli: grid 24 foto ponsel (~600 KB) menyedot 14.2 MB untuk 24
      // "thumbnail" yang seharusnya ~80 KB — 7x boros, dan lambat di jaringan
      // lambat. Bucket pakai fileId sebagai recordId di getThumb (cache path
      // tetap unik per file), sama seperti endpoint record di storageRoutes.
      const thumbSpec = req.query.get('thumb');
      let serveData = result.data;
      if (thumbSpec) {
        if (!isThumbable(result.info.filename)) {
          res.status(400).json({
            error: { code: 'BAD_REQUEST', message: 'Thumbnails are only supported for jpg/png/gif/webp' },
          });
          return;
        }
        try {
          serveData = await getThumb(req.params.pid, result.info.fileId, result.info.filename, thumbSpec, result.data);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to generate thumbnail';
          res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
          return;
        }
      }

      res.raw.setHeader('Content-Type', mime);
      res.raw.setHeader('Content-Length', String(serveData.length));
      res.raw.setHeader('Cache-Control', 'public, max-age=3600');
      res.raw.setHeader('Content-Disposition', `inline; filename="${result.info.filename}"`);
      if (mime === 'application/octet-stream') {
        res.raw.setHeader('Content-Disposition', `attachment; filename="${result.info.filename}"`);
      }
      res.raw.end(serveData);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(500).json({ error: { code: 'INTERNAL', message } });
    }
  });

  // ─── LIST (auth user — hanya file miliknya) ───────────────────────────────

  router.get('/api/p/:pid/storage/bucket', async (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const userId = await resolveUser(req);
      const files = listBucketFiles(db, userId ? { uploadedBy: userId } : { limit: 100 });
      res.json({ files });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  // ─── DELETE (auth user — hanya file miliknya; admin — semua) ─────────────

  router.delete('/api/p/:pid/storage/bucket/:fileId', async (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const info = getBucketInfo(db, req.params.fileId);
      if (!info) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File not found' } });
        return;
      }

      // Cek ownership: anonymous tidak boleh hapus, user hanya file miliknya
      const userId = await resolveUser(req);
      if (!userId) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
        return;
      }
      if (info.uploadedBy && info.uploadedBy !== userId) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'File belongs to another user' } });
        return;
      }

      const deleted = await bucketDelete(db, req.params.pid, req.params.fileId);
      res.json({ ok: deleted });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  // ─── ADMIN DELETE (bypass ownership) ─────────────────────────────────────

  router.delete('/api/admin/projects/:pid/storage/bucket/:fileId', requireAdmin, async (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const deleted = await bucketDelete(db, req.params.pid, req.params.fileId);
      if (!deleted) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File not found' } });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  return router;
}
