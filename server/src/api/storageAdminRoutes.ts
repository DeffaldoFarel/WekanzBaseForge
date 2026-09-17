// ============================================================================
// M30: STORAGE ADMIN ROUTES — backend config (local/S3) + health check
//
//   GET    /api/admin/settings/storage           → info backend aktif
//   PUT    /api/admin/settings/storage           → set config (local atau S3)
//   POST   /api/admin/settings/storage/test      → test koneksi S3
//   DELETE /api/admin/settings/storage           → reset ke local disk
// ============================================================================

import { Router } from '../core/router.js';
import { requireAdmin } from '../platform/adminAuth.js';
import {
  getStorageInfo,
  getStorageAdapter,
  saveStorageConfig,
  resetStorageAdapter,
} from '../core/storageAdapter.js';
import type { S3Config } from '../core/s3.js';

export function createStorageAdminRouter(): Router {
  const router = new Router();

  // GET — info backend aktif (secret TIDAK ditampilkan)
  router.get('/api/admin/settings/storage', requireAdmin, (req, res) => {
    const info = getStorageInfo();
    res.json(info);
  });

  // PUT — set konfigurasi backend
  router.put('/api/admin/settings/storage', requireAdmin, (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        backend?: string;
        s3?: {
          endpoint?: string; region?: string; bucket?: string;
          accessKeyId?: string; secretAccessKey?: string; prefix?: string;
        };
      };

      if (body.backend === 's3') {
        // Validasi kelengkapan S3 config
        const s3 = body.s3;
        if (!s3?.endpoint?.trim() || !s3?.bucket?.trim() || !s3?.accessKeyId?.trim() || !s3?.secretAccessKey?.trim()) {
          res.status(400).json({
            error: {
              code: 'BAD_REQUEST',
              message: 'S3 config requires: endpoint, bucket, accessKeyId, secretAccessKey',
            },
          });
          return;
        }
        const config: S3Config = {
          endpoint: s3.endpoint.trim(),
          region: s3.region?.trim() || 'us-east-1',
          bucket: s3.bucket.trim(),
          accessKeyId: s3.accessKeyId.trim(),
          secretAccessKey: s3.secretAccessKey.trim(),
          prefix: s3.prefix?.trim() || undefined,
        };
        saveStorageConfig({ backend: 's3', s3: config });
        res.json({ backend: 's3', message: 'Storage backend set to S3-compatible' });
      } else if (body.backend === 'local') {
        saveStorageConfig({ backend: 'local' });
        res.json({ backend: 'local', message: 'Storage backend set to local disk' });
      } else {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: "backend must be 'local' or 's3'" },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  // POST /test — health check koneksi (untuk S3: HEAD bucket)
  router.post('/api/admin/settings/storage/test', requireAdmin, async (req, res) => {
    try {
      const adapter = getStorageAdapter();
      const healthy = await adapter.healthCheck();
      res.json({
        ok: healthy,
        backend: adapter.backend,
        message: healthy
          ? `Storage backend '${adapter.backend}' is healthy`
          : `Storage backend '${adapter.backend}' health check FAILED`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Health check failed';
      res.status(502).json({ ok: false, error: { code: 'HEALTH_FAILED', message } });
    }
  });

  // DELETE — reset ke local disk default
  router.delete('/api/admin/settings/storage', requireAdmin, (req, res) => {
    saveStorageConfig({ backend: 'local' });
    resetStorageAdapter();
    res.json({ backend: 'local', message: 'Storage backend reset to local disk' });
  });

  return router;
}
