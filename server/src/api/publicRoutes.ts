// ============================================================================
// M11: PUBLIC RECORD API + RULES ADMIN
//
// Dua kelompok route:
// 1. /api/p/:pid/collections/:name/records  → END USERS (JWT Bearer)
//    Rules dievaluasi per record/list; admin token juga diterima (bypass).
// 2. /api/admin/projects/:pid/collections/:name/rules → admin atur rules
// ============================================================================

import { Router } from '../core/router.js';
import { getProjectDb } from '../core/projectDbManager.js';
import { requireAdmin, validateToken } from '../platform/adminAuth.js';
import { verifyToken } from '../auth/jwt.js';
import { updateCollectionRules } from '../core/schema.js';
import {
  listRecords,
  getRecord,
  createRecord,
  updateRecord,
  deleteRecord,
} from '../core/records.js';
import { RequestContext } from '../core/query/sqlBuilder.js';
import { ForbiddenError } from '../core/rules.js';

// ─── Helper: identitas pemanggil (admin ATAU end user) ──────────────────────
// - Bearer JWT admin (login admin) → bypass rules (undefined ctx)
// - Bearer JWT end user (M09u)     → reqCtx = { auth: {...} }
// - Anonymous                      → reqCtx = { auth: null } (rules tetap jalan)

// Admin token = token sesi admin. Kita bedakan dengan cek session store.
function isAdminToken(token: string): boolean {
  return validateToken(token) !== null;
}

function extractBearer(header: string | null | undefined): string | null {
  return header?.startsWith('Bearer ') ? header.slice(7).trim() || null : null;
}

function handleErrorPublic(res: {
  status: (code: number) => { json: (body: unknown) => void };
}, err: unknown): void {
  if (err instanceof ForbiddenError) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: err.message } });
    return;
  }
  const message = err instanceof Error ? err.message : 'Internal error';
  const status = /tidak ditemukan|not found/i.test(message) ? 404 : 400;
  res.status(status).json({ error: { code: status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST', message } });
}

export function createPublicRouter(): Router {
  const router = new Router();

  // ═══════════════════════════════════════════════════════════════════════
  // ADMIN: atur rules collection
  // ═══════════════════════════════════════════════════════════════════════

  // PATCH /api/admin/projects/:pid/collections/:name/rules
  router.patch('/api/admin/projects/:pid/collections/:name/rules', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const body = (req.body ?? {}) as Record<string, unknown>;
      // Hanya 5 key yang dikenal; nilainya string | null
      const allowed = ['listRule', 'viewRule', 'createRule', 'updateRule', 'deleteRule'] as const;
      const rules: Record<string, string | null> = {};
      for (const key of allowed) {
        if (key in body) {
          const v = body[key];
          if (v !== null && typeof v !== 'string') {
            res.status(400).json({ error: { code: 'BAD_REQUEST', message: `${key} harus string atau null` } });
            return;
          }
          rules[key] = v as string | null;
        }
      }
      const meta = updateCollectionRules(db, req.params.name, rules);
      res.json({ rules: meta.rules });
    } catch (err) {
      handleErrorPublic(res, err);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // PUBLIC: records untuk END USERS (rules aktif)
  // ═══════════════════════════════════════════════════════════════════════

  // GET list
  router.get('/api/p/:pid/collections/:name/records', (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const reqCtx = resolveEndUserCtx(req); // admin → undefined (bypass)
      const result = listRecords(db, req.params.name, {
        filter: req.query.get('filter') ?? undefined,
        sort: req.query.get('sort') ?? undefined,
        page: req.query.get('page') ? parseInt(req.query.get('page')!, 10) : 1,
        perPage: req.query.get('perPage') ? parseInt(req.query.get('perPage')!, 10) : 20,
        reqCtx,
      });
      res.json(result);
    } catch (err) {
      handleErrorPublic(res, err);
    }
  });

  // GET satu record (view)
  router.get('/api/p/:pid/collections/:name/records/:id', (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const reqCtx = resolveEndUserCtx(req);
      const record = getRecord(db, req.params.name, req.params.id, reqCtx);
      if (!record) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record tidak ditemukan' } });
        return;
      }
      res.json({ record });
    } catch (err) {
      handleErrorPublic(res, err);
    }
  });

  // POST create
  router.post('/api/p/:pid/collections/:name/records', (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const reqCtx = resolveEndUserCtx(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const record = createRecord(db, req.params.name, body, reqCtx);
      res.status(201).json({ record });
    } catch (err) {
      handleErrorPublic(res, err);
    }
  });

  // PATCH update
  router.patch('/api/p/:pid/collections/:name/records/:id', (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const reqCtx = resolveEndUserCtx(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const record = updateRecord(db, req.params.name, req.params.id, body, reqCtx);
      if (!record) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record tidak ditemukan' } });
        return;
      }
      res.json({ record });
    } catch (err) {
      handleErrorPublic(res, err);
    }
  });

  // DELETE
  router.delete('/api/p/:pid/collections/:name/records/:id', (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const reqCtx = resolveEndUserCtx(req);
      const ok = deleteRecord(db, req.params.name, req.params.id, reqCtx);
      if (!ok) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record tidak ditemukan' } });
        return;
      }
      res.json({ success: true });
    } catch (err) {
      handleErrorPublic(res, err);
    }
  });

  return router;
}

// ─── Helper: resolve JWT → RequestContext (untuk end user) ──────────────────

function resolveEndUserCtx(req: { headers: { authorization?: string } }): RequestContext {
  const bearer = extractBearer(req.headers.authorization ?? null);
  if (bearer) {
    if (isAdminToken(bearer)) {
      return undefined as unknown as RequestContext; // admin → bypass (jangan dipakai)
    }
    const result = verifyToken(bearer);
    if (result.valid && result.payload) {
      return {
        auth: {
          id: String(result.payload.sub ?? ''),
          email: String(result.payload.email ?? ''),
        },
      };
    }
  }
  return { auth: null }; // anonymous — rules tetap dievaluasi (rule "" tetap boleh)
}
