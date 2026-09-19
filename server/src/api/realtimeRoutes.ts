// ============================================================================
// M13 + Ops-6: REALTIME ROUTES — SSE + subscribe/unsubscribe + bulk sync
//
// GET  /api/p/:pid/realtime[?token=<jwt>]   → SSE stream (EventSource)
// POST /api/p/:pid/realtime                 → bulk sync { clientId, subscriptions[] }
//                                             (contract SDK — semantik REPLACE)
// POST /api/p/:pid/realtime/subscribe       → { clientId, collection, filter? }
// POST /api/p/:pid/realtime/unsubscribe     → { clientId, subId }
// GET  /api/p/:pid/realtime/stats           → debug stats
//
// Ops-6 (2026-09-19, pemicu real-test WekanzDashboard):
// 1. POST /realtime BARU — SDK @wekanz/baseforge syncSubscriptions() POST ke
//    path ini sejak M36, tapi route-nya tidak pernah ada di server → 404 →
//    realtime mati total untuk SEMUA konsumen SDK. Semantik: ganti seluruh
//    subscription set (idempotent full-sync, ala PocketBase).
// 2. Auth SSE — EventSource browser TIDAK BISA mengirim header Authorization
//    (asumsi lama "koneksi sudah auth'd" hanya benar untuk klien non-browser
//    → SSE browser selalu anonymous → rules publish() menolak semua event).
//    Sekarang: (a) token boleh via ?token= di GET; (b) POST sync/subscribe
//    membawa Authorization → auth koneksi di-UPGRADE di hub. Token INVALID →
//    401 keras (jangan diam-diam jatuh ke anonymous — kegagalan senyap
//    adalah bug aslinya).
// 3. Fail-safe delete — evaluasi rule in-memory (core/realtime.ts): dulu
//    event delete (payload full record) bocor ke semua subscriber.
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

// Topik SDK PocketBase-style: "collection" | "collection/*" | "collection/<recordId>"
const TOPIC_RE = /^([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_-]+|\*))?$/;
const MAX_TOPICS = 100;

// ── Ops-6: resolusi auth ────────────────────────────────────────────────────
// none    = tanpa token (SSE anonymous; POST tidak mengubah auth koneksi)
// admin   = token sesi admin platform (bypass rules)
// user    = JWT user project
// invalid = token ada tapi tidak valid → 401 (fail loud)

type AuthResolution =
  | { kind: 'none' }
  | { kind: 'admin' }
  | { kind: 'user'; reqCtx: RequestContext }
  | { kind: 'invalid' };

function extractBearer(
  authorization: string | string[] | undefined,
  queryToken: string | null
): string | null {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return queryToken ?? null;
}

async function resolveAuth(bearer: string | null): Promise<AuthResolution> {
  if (!bearer) return { kind: 'none' };
  if (validateToken(bearer)) return { kind: 'admin' };
  const result = await verifyToken(bearer);
  if (result.valid && result.payload) {
    return {
      kind: 'user',
      reqCtx: {
        auth: {
          id: String(result.payload.sub ?? ''),
          email: String(result.payload.email ?? ''),
        },
      },
    };
  }
  return { kind: 'invalid' };
}

// Upgrade auth koneksi SSE di hub — dipanggil route POST (sync/subscribe).
// 'none' → tidak mengubah (koneksi tetap apa adanya — anonymous tetap
// anonymous; admin tetap admin). clientId hanya diketahui pemilik koneksi.
function upgradeClientAuth(clientId: string, resolved: AuthResolution): void {
  if (resolved.kind === 'admin') realtimeHub.setClientAuth(clientId, undefined);
  else if (resolved.kind === 'user') realtimeHub.setClientAuth(clientId, resolved.reqCtx);
}

export function createRealtimeRouter(): Router {
  const router = new Router();

  // ─── SSE stream ────────────────────────────────────────────────────────────
  // Koneksi terbuka sampai client putus. Auth dibaca SEKALI di sini —
  // header DULU, lalu ?token= (Ops-6: EventSource browser tidak bisa header).
  // M18b: verifyToken ASYNC (jose) — handler jadi async
  router.get('/api/p/:pid/realtime', async (req, res) => {
    const bearer = extractBearer(req.headers.authorization, req.query.get('token'));
    const resolved = await resolveAuth(bearer);

    if (resolved.kind === 'invalid') {
      // Ops-6: gagal KERAS, jangan fallback diam-diam ke anonymous —
      // event yang tidak pernah sampai tanpa penjelasan adalah bug senyap.
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
      return;
    }

    let reqCtx: RequestContext | undefined;
    if (resolved.kind === 'user') reqCtx = resolved.reqCtx;
    else if (resolved.kind === 'none') reqCtx = { auth: null }; // anonymous

    // Koneksi terbuka — jangan res.json()! hub mengambil alih response.
    realtimeHub.connect(res.raw, reqCtx);
  });

  // ── Ops-6: bulk sync ala PocketBase (contract SDK) ──────────────────────────
  // POST /api/p/:pid/realtime  body: { clientId, subscriptions: string[] }
  // Semantik REPLACE: seluruh subscription client diganti dengan set baru —
  // idempotent, persis cara SDK memanggilnya setelah subscribe/unsubscribe.
  // Header Authorization valid → auth koneksi SSE di-upgrade.
  router.post('/api/p/:pid/realtime', async (req, res) => {
    try {
      // 401 untuk token invalid SEBELUM validasi lain — SDK M37 auto-refresh
      // menangkap 401 → refresh → retry dengan token segar → upgrade sukses.
      const resolved = await resolveAuth(
        extractBearer(req.headers.authorization, req.query.get('token'))
      );
      if (resolved.kind === 'invalid') {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
        return;
      }

      const body = (req.body ?? {}) as { clientId?: string; subscriptions?: unknown };

      if (!body.clientId) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'clientId is required' } });
        return;
      }
      if (!realtimeHub.getClient(body.clientId)) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown clientId — connect first' } });
        return;
      }
      if (!Array.isArray(body.subscriptions)) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'subscriptions must be an array of topics' } });
        return;
      }
      if (body.subscriptions.length > MAX_TOPICS) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: `Too many subscriptions (max ${MAX_TOPICS})` } });
        return;
      }

      // Parse topik: "collection" | "collection/*" | "collection/<recordId>"
      const parsed: { collection: string; recordId?: string }[] = [];
      for (const topic of body.subscriptions) {
        if (typeof topic !== 'string') {
          res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'subscriptions must be strings' } });
          return;
        }
        const m = TOPIC_RE.exec(topic.trim());
        if (!m) {
          res.status(400).json({
            error: {
              code: 'BAD_REQUEST',
              message: `Invalid topic '${topic}' — expected 'collection', 'collection/*' or 'collection/<recordId>'`,
            },
          });
          return;
        }
        if (m[2] && m[2] !== '*') parsed.push({ collection: m[1], recordId: m[2] });
        else parsed.push({ collection: m[1] });
      }

      // Validasi collection ada (biar typo tidak diam-diam tanpa event).
      // Array kosong = unsubscribe semua — tidak perlu buka DB project.
      if (parsed.length > 0) {
        const db = getProjectDb(req.params.pid);
        for (const p of parsed) {
          const meta = getCollectionByName(db, p.collection);
          if (!meta) {
            res.status(400).json({ error: { code: 'BAD_REQUEST', message: `Collection '${p.collection}' not found` } });
            return;
          }
        }
      }

      // Upgrade auth koneksi ('none' → tidak berubah)
      upgradeClientAuth(body.clientId, resolved);

      const subs = realtimeHub.syncSubscriptions(body.clientId, parsed);
      res.json({ subscriptions: subs });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(500).json({ error: { code: 'INTERNAL', message } });
    }
  });

  // ── Subscribe (satu atau banyak collection) ───────────────────────────────
  router.post('/api/p/:pid/realtime/subscribe', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        clientId?: string;
        collections?: string[];
        collection?: string;
        filter?: string;
      };

      const clientId = body.clientId;
      if (!clientId) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'clientId is required' } });
        return;
      }

      const client = realtimeHub.getClient(clientId);
      if (!client) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown clientId — connect first' } });
        return;
      }

      // Ops-6: upgrade auth koneksi dari Authorization request — klien custom
      // / SDK lama yang memakai route ini juga dapat evaluasi rules yang benar
      const resolved = await resolveAuth(
        extractBearer(req.headers.authorization, req.query.get('token'))
      );
      if (resolved.kind === 'invalid') {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
        return;
      }
      upgradeClientAuth(clientId, resolved);

      // Validasi collection ada (biar typo tidak diam-diam tanpa event)
      const db = getProjectDb(req.params.pid);
      const collections = body.collections ?? (body.collection ? [body.collection] : []);
      if (collections.length === 0) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'collection(s) are required' } });
        return;
      }
      for (const name of collections) {
        const meta = getCollectionByName(db, name);
        if (!meta) {
          res.status(404).json({ error: { code: 'NOT_FOUND', message: `Collection '${name}' not found` } });
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
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'clientId and subId are required' } });
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
