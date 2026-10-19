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
import { Router, type ForgeRequest, type ForgeResponse } from '../core/router.js';
import { getProjectDb } from '../core/projectDbManager.js';
import { verifyToken } from '../auth/jwt.js';
import { findAuthUserById } from '../auth/users.js';
import { requireAdmin, validateToken } from '../platform/adminAuth.js';
import { extractApiKey, resolveApiKey, ApiKeyError } from '../auth/apiKeys.js';
import type { DatabaseSync } from 'node:sqlite';
import {
  bucketUpload,
  BucketOwnershipError,
  BucketConflictError,
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

type BucketActor = { kind: 'user'; userId: string } | { kind: 'service' };

class BucketAuthorizationError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'USER_DISABLED',
    message: string
  ) { super(message); }
}

/** Resolve and validate the actor against THIS project, before any bucket IO. */
async function resolveBucketActor(
  req: ForgeRequest,
  db: DatabaseSync,
  pid: string,
  write: boolean
): Promise<BucketActor> {
  const apiKey = extractApiKey(req.headers);
  if (req.headers['x-api-key'] && !apiKey) {
    throw new ApiKeyError(401, 'INVALID_API_KEY', 'Invalid API key');
  }
  if (apiKey) {
    await resolveApiKey(db, apiKey, { pid, write });
    return { kind: 'service' };
  }

  const auth = req.headers.authorization;
  const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!bearer) {
    throw new BucketAuthorizationError(401, 'UNAUTHORIZED', 'Authentication required');
  }
  if (validateToken(bearer)) return { kind: 'service' }; // platform admin
  const result = await verifyToken(bearer, pid);
  if (!result.valid || !result.payload?.sub) {
    throw new BucketAuthorizationError(401, 'UNAUTHORIZED', 'Invalid or expired token');
  }
  const user = findAuthUserById(db, String(result.payload.sub));
  if (!user) {
    throw new BucketAuthorizationError(401, 'UNAUTHORIZED', 'User not found in project');
  }
  if (user.disabled) {
    throw new BucketAuthorizationError(403, 'USER_DISABLED', 'This account has been disabled');
  }
  return { kind: 'user', userId: user.id };
}

function respondBucketAuthError(res: ForgeResponse, err: unknown): boolean {
  if (err instanceof BucketConflictError) {
    res.status(409).json({ error: { code: 'CONFLICT', message: err.message } });
    return true;
  }
  if (err instanceof BucketOwnershipError) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: err.message } });
    return true;
  }
  if (err instanceof ApiKeyError || err instanceof BucketAuthorizationError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return true;
  }
  return false;
}



export function createBucketRouter(): Router {
  const router = new Router();

  // ─── UPLOAD (multipart) ───────────────────────────────────────────────────

  router.post('/api/p/:pid/storage/upload', async (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const actor = await resolveBucketActor(req, db, req.params.pid, true);

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

      // A known ID is not permission to replace another user's (or a legacy
      // service-owned) file. Service/admin writes are explicitly privileged.
      if (requestedFileId && actor.kind === 'user') {
        const existing = getBucketInfo(db, requestedFileId);
        if (existing && existing.uploadedBy !== actor.userId) {
          throw new BucketAuthorizationError(403, 'FORBIDDEN', 'File belongs to another user');
        }
      }

      const result = await bucketUpload(db, req.params.pid, {
        filename: file.filename,
        data: file.data,
        contentType: file.contentType,
        fileId: requestedFileId,
        uploadedBy: actor.kind === 'user' ? actor.userId : null,
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
      if (respondBucketAuthError(res, err)) return;
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
          serveData = await getThumb(req.params.pid, result.info.fileId, result.info.filename,
            thumbSpec, result.data, result.info.storedName);
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
      const actor = await resolveBucketActor(req, db, req.params.pid, false);
      const files = listBucketFiles(db, actor.kind === 'user' ? { uploadedBy: actor.userId } : { limit: 100 });
      res.json({ files });
    } catch (err) {
      if (respondBucketAuthError(res, err)) return;
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  // ─── DELETE (auth user — hanya file miliknya; admin — semua) ─────────────

  router.delete('/api/p/:pid/storage/bucket/:fileId', async (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const actor = await resolveBucketActor(req, db, req.params.pid, true);
      const info = getBucketInfo(db, req.params.fileId);
      if (!info) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File not found' } });
        return;
      }

      // A legacy unowned file belongs to the service, not every user.
      if (actor.kind === 'user' && info.uploadedBy !== actor.userId) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'File belongs to another user' } });
        return;
      }

      const deleted = await bucketDelete(db, req.params.pid, req.params.fileId,
        actor.kind === 'user' ? actor.userId : undefined);
      res.json({ ok: deleted });
    } catch (err) {
      if (respondBucketAuthError(res, err)) return;
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  // ─── ADMIN DELETE (bypass ownership) ─────────────────────────────────────

  router.delete('/api/admin/projects/:pid/storage/bucket/:fileId', requireAdmin, async (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const expected = req.headers['x-expected-stored-name'];
      if (typeof expected !== 'string' || !expected.startsWith(`${req.params.fileId}_`) || expected.length > 300) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Expected stored version is required' } });
        return;
      }
      const deleted = await bucketDelete(db, req.params.pid, req.params.fileId, undefined, expected);
      if (!deleted) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File not found' } });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      if (respondBucketAuthError(res, err)) return;
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  return router;
}
