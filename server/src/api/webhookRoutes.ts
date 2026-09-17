// ============================================================================
// M28: WEBHOOK ROUTES — CRUD + test send + delivery log (admin)
//
//   POST   /api/admin/projects/:pid/webhooks              → buat (secret di-generate)
//   GET    /api/admin/projects/:pid/webhooks              → list (secret DISAMARKAN)
//   GET    /api/admin/projects/:pid/webhooks/:id          → detail + secret penuh (sekali)
//   PATCH  /api/admin/projects/:pid/webhooks/:id          → update (name/url/events/enabled)
//   DELETE /api/admin/projects/:pid/webhooks/:id          → hapus
//   POST   /api/admin/projects/:pid/webhooks/:id/test     → kirim test payload
//   GET    /api/admin/projects/:pid/webhooks/:id/deliveries → log delivery (20 terakhir)
//
// Secret hanya tampil lengkap saat GET by ID dan POST create — konsisten
// dengan pola API key M26 (sekali lihat, admin menyimpan).
// ============================================================================

import { Router } from '../core/router.js';
import { requireAdmin } from '../platform/adminAuth.js';
import { getProjectDb } from '../core/projectDbManager.js';
import {
  initWebhooksTable,
  createWebhook,
  getWebhookById,
  listWebhooks,
  updateWebhook,
  deleteWebhook,
  listDeliveries,
  fireWebhooks,
} from '../core/webhooks.js';

function maskWebhook(w: ReturnType<typeof getWebhookById>) {
  if (!w) return null;
  const { secret, ...rest } = w;
  return { ...rest, secretHint: secret.slice(0, 12) + '…' };
}

export function createWebhookRouter(): Router {
  const router = new Router();

  router.post('/api/admin/projects/:pid/webhooks', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      initWebhooksTable(db);
      const body = (req.body ?? {}) as {
        name?: string; url?: string; secret?: string; events?: string[]; enabled?: boolean;
      };
      const hook = createWebhook(db, {
        name: body.name ?? '',
        url: body.url ?? '',
        secret: body.secret,
        events: body.events,
        enabled: body.enabled,
      });
      res.status(201).json({ webhook: hook }); // secret penuh — sekali tampil
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  router.get('/api/admin/projects/:pid/webhooks', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      initWebhooksTable(db);
      res.json({ webhooks: listWebhooks(db).map(maskWebhook) });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  router.get('/api/admin/projects/:pid/webhooks/:id', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      initWebhooksTable(db);
      const hook = getWebhookById(db, req.params.id);
      if (!hook) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Webhook not found' } });
        return;
      }
      res.json({ webhook: hook }); // secret penuh untuk konfigurasi verifikasi
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  router.patch('/api/admin/projects/:pid/webhooks/:id', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      initWebhooksTable(db);
      const body = (req.body ?? {}) as {
        name?: string; url?: string; events?: string[]; enabled?: boolean;
      };
      const hook = updateWebhook(db, req.params.id, body);
      if (!hook) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Webhook not found' } });
        return;
      }
      res.json({ webhook: maskWebhook(hook) });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  router.delete('/api/admin/projects/:pid/webhooks/:id', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      initWebhooksTable(db);
      const ok = deleteWebhook(db, req.params.id);
      if (!ok) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Webhook not found' } });
        return;
      }
      res.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  // Kirim test payload (record dummy) — verifikasi endpoint + signature
  router.post('/api/admin/projects/:pid/webhooks/:id/test', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      initWebhooksTable(db);
      const hook = getWebhookById(db, req.params.id);
      if (!hook) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Webhook not found' } });
        return;
      }
      fireWebhooks(db, {
        projectId: req.params.pid,
        action: 'create',
        collection: '_test',
        record: { id: 'webhook-test', message: 'Test delivery from BaseForge' },
      });
      res.json({ ok: true, message: 'Test delivery sent (fire-and-forget) — check deliveries log in a few seconds' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  router.get('/api/admin/projects/:pid/webhooks/:id/deliveries', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      initWebhooksTable(db);
      const limit = req.query.get('limit') ? parseInt(req.query.get('limit')!, 10) : 20;
      res.json({ deliveries: listDeliveries(db, req.params.id, Math.min(Math.max(limit, 1), 100)) });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  return router;
}
