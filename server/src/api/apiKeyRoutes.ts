// ============================================================================
// M26: API KEY ROUTES — manajemen key per project (admin/dashboard)
//
//   POST   /api/admin/projects/:pid/api-keys      { name?, scope } → key PENUH sekali
//   GET    /api/admin/projects/:pid/api-keys      → list (masked + usage real-time)
//   DELETE /api/admin/projects/:pid/api-keys/:id  → revoke
//
// Pemakaian key (end-user API — lihat apiKeys.ts):
//   Authorization: Bearer bf_...   atau   X-API-Key: bf_...
//   Scope: 'read' (GET) | 'write' (semua method) — key BYPASS API Rules.
// ============================================================================

import { Router } from '../core/router.js';
import { requireAdmin } from '../platform/adminAuth.js';
import { getProjectDb } from '../core/projectDbManager.js';
import { createApiKey, listApiKeys, revokeApiKey, API_KEY_RATE_LIMIT } from '../auth/apiKeys.js';

export function createApiKeyRouter(): Router {
  const router = new Router();

  // Buat key — full key HANYA muncul di response ini (tidak pernah disimpan)
  router.post('/api/admin/projects/:pid/api-keys', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const body = (req.body ?? {}) as { name?: string; scope?: string };
      if (body.scope !== undefined && body.scope !== 'read' && body.scope !== 'write') {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: "scope must be 'read' or 'write'" },
        });
        return;
      }
      const created = createApiKey(db, {
        name: body.name,
        scope: (body.scope as 'read' | 'write') ?? 'write',
      });
      res.status(201).json({
        apiKey: created.info,
        key: created.key, // tampilkan SEKALI — client wajib menyimpannya
        notice: 'Store this key securely — it will not be shown again.',
        rateLimitPerMinute: API_KEY_RATE_LIMIT,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  router.get('/api/admin/projects/:pid/api-keys', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      res.json({ keys: listApiKeys(db) });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  router.delete('/api/admin/projects/:pid/api-keys/:keyId', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const ok = revokeApiKey(db, req.params.keyId);
      if (!ok) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'API key not found' } });
        return;
      }
      res.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  return router;
}
