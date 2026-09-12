// ============================================================================
// M13: REALTIME ROUTES — SSE endpoint + subscribe/unsubscribe
//
// GET  /api/p/:pid/realtime?clientId=&subs=...   → SSE stream (EventSource)
// POST /api/p/:pid/realtime/subscribe            → { clientId, collection, filter? }
// POST /api/p/:pid/realtime/unsubscribe          → { clientId, subId }
//
// Pola PocketBase: koneksi SSE membawa auth via header (Bearer admin/
// user JWT). Subscribe terjadi via HTTP POST terpisah (EventSource API
// tidak bisa set header — tapi juga tidak perlu: koneksi sudah auth'd).
//
// CATATAN ARSITEKTUR: hub publish butuh db+meta per project. Karena
// projectId ada di URL subscribe/publish, kita panggil realtimeHub dari
// route handler (yang tahu pid) — bukan dari core records.
// ============================================================================

import { Router } from '../core/router.js';
import { getProjectDb } from '../core/projectDbManager.js';
import { getCollectionByName } from '../core/schema.js';
import { realtimeHub } from '../core/realtime.js';
import { verifyToken } from '../auth/jwt.js';
import { validateToken } from '../platform/adminAuth.js';
import type { RequestContext } from '../core/query/sqlBuilder.js';

export function createRealtimeRouter(): Router {
  const router = new Router();

  // ── SSE stream ────────────────────────────────────────────────────────────
  // Koneksi terbuka sampai client putus. Auth dibaca SEKALI di sini.
  router.get('/api/p/:pid/realtime', (req, res) => {
    const auth = req.headers.authorization;
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null;

    let reqCtx: RequestContext | undefined;
    if (bearer) {
      if (validateToken(bearer)) {
        reqCtx = undefined; // admin — bypass rules
      } else {
        const result = verifyToken(bearer);
        reqCtx = result.valid && result.payload
          ? { auth: { id: String(result.payload.sub ?? ''), email: String(result.payload.email ?? '') } }
          : { auth: null };
      }
    } else {
      reqCtx = { auth: null }; // anonymous
    }

    // Koneksi terbuka — jangan res.json()! hub mengambil alih response.
    realtimeHub.connect(res.raw, reqCtx);
  });

  // ── Subscribe (satu atau banyak collection) ───────────────────────────────
  router.post('/api/p/:pid/realtime/subscribe', (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        clientId?: string;
        collections?: string[];
        collection?: string;
        filter?: string;
      };

      const clientId = body.clientId;
      if (!clientId) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'clientId wajib' } });
        return;
      }

      const client = realtimeHub.getClient(clientId);
      if (!client) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'clientId tidak dikenal — connect dulu' } });
        return;
      }

      // Validasi collection ada (biar typo tidak diam-diam tanpa event)
      const db = getProjectDb(req.params.pid);
      const collections = body.collections ?? (body.collection ? [body.collection] : []);
      if (collections.length === 0) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'collection(s) wajib' } });
        return;
      }
      for (const name of collections) {
        const meta = getCollectionByName(db, name);
        if (!meta) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: `Collection '${name}' tidak ditemukan` } });
          return;
        }
      }

      const subIds: string[] = [];
      for (const name of collections) {
        const subId = realtimeHub.subscribe(clientId, name, body.filter);
        if (subId) subIds.push(subId);
      }

      res.json({ subscriptions: subIds });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(500).json({ error: { code: 'INTERNAL', message } });
    }
  });

  // ── Unsubscribe ───────────────────────────────────────────────────────────
  router.post('/api/p/:pid/realtime/unsubscribe', (req, res) => {
    try {
      const body = (req.body ?? {}) as { clientId?: string; subId?: string };
      if (!body.clientId || !body.subId) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'clientId dan subId wajib' } });
        return;
      }
      const ok = realtimeHub.unsubscribe(body.clientId, body.subId);
      res.json({ success: ok });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(500).json({ error: { code: 'INTERNAL', message } });
    }
  });

  // ── Stats (debug) ─────────────────────────────────────────────────────────
  router.get('/api/p/:pid/realtime/stats', (req, res) => {
    res.json(realtimeHub.stats());
  });

  return router;
}
