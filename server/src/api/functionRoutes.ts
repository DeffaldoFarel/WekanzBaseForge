// ============================================================================
// M15a: FUNCTION ROUTES — CRUD (admin) + EXECUTE (admin & public)
//
// Admin endpoints (kelola function):
//   POST   /api/admin/projects/:pid/functions            → buat
//   GET    /api/admin/projects/:pid/functions            → list
//   PATCH  /api/admin/projects/:pid/functions/:name      → ubah code/enabled
//   DELETE /api/admin/projects/:pid/functions/:name      → hapus
//   POST   /api/admin/projects/:pid/functions/:name/execute → jalankan + log
//
// Public endpoint (END USERS — hanya function yang enabled):
//   POST   /api/p/:pid/functions/:name/execute → { body } → hasil sandbox
//
// Response execute selalu berisi logs — transparansi penting untuk debug,
// dan ini juga MELATIH pola M15b (triggers) yang akan memakai log sama.
// ============================================================================

import { Router } from '../core/router.js';
import { requireAdmin } from '../platform/adminAuth.js';
import { getProjectDb } from '../core/projectDbManager.js';
import { listCollections } from '../core/schema.js';
import {
  initFunctionsTable,
  createFunction,
  listFunctions,
  getFunctionByName,
  updateFunction,
  deleteFunction,
} from '../core/functionsStore.js';
import { runFunctionCode } from '../core/functionRunner.js';
import type { RequestContext } from '../core/query/sqlBuilder.js';
import { verifyToken } from '../auth/jwt.js';
import { validateToken } from '../platform/adminAuth.js';

// Helper: auth end user dari Bearer JWT (anonymous → auth: null)
function resolveUserAuth(req: { headers: { authorization?: string } }): RequestContext['auth'] {
  const auth = req.headers.authorization;
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!bearer || validateToken(bearer)) return null; // admin token → tidak dipakai sebagai user
  const result = verifyToken(bearer);
  if (result.valid && result.payload) {
    return { id: String(result.payload.sub ?? ''), email: String(result.payload.email ?? '') };
  }
  return null;
}

export function createFunctionRouter(): Router {
  const router = new Router();

  // ═════════════════════════════════════════════════════════════════════
  // ADMIN: CRUD
  // ═════════════════════════════════════════════════════════════════════

  router.post('/api/admin/projects/:pid/functions', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const body = (req.body ?? {}) as {
        name?: string;
        code?: string;
        enabled?: boolean;
        timeoutMs?: number;
        triggers?: { collection: string; actions: string[] }[];
      };
      if (!body.name || !body.code) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'name dan code wajib' } });
        return;
      }
      // Validasi trigger collection terhadap skema project
      let triggers;
      if (Array.isArray(body.triggers)) {
        const existing = listCollections(db).map((c) => c.name);
        triggers = body.triggers.map((t) => ({
          collection: t.collection,
          actions: t.actions as ('create' | 'update' | 'delete')[],
        }));
        for (const t of triggers) {
          if (!existing.includes(t.collection)) {
            res.status(400).json({
              error: { code: 'BAD_REQUEST', message: `Trigger collection '${t.collection}' tidak ada di project ini` },
            });
            return;
          }
        }
      }
      const fn = createFunction(db, {
        name: body.name,
        code: body.code,
        enabled: body.enabled,
        timeoutMs: body.timeoutMs,
        triggers,
      });
      res.status(201).json({ function: fn });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      const status = /already exists/i.test(message) ? 409 : 400;
      res.status(status).json({ error: { code: status === 409 ? 'CONFLICT' : 'BAD_REQUEST', message } });
    }
  });

  router.get('/api/admin/projects/:pid/functions', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      res.json({ functions: listFunctions(db) });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  router.get('/api/admin/projects/:pid/functions/:name', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const fn = getFunctionByName(db, req.params.name);
      if (!fn) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Function tidak ditemukan' } });
        return;
      }
      res.json({ function: fn });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  router.patch('/api/admin/projects/:pid/functions/:name', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const body = (req.body ?? {}) as {
        code?: string;
        enabled?: boolean;
        timeoutMs?: number;
        triggers?: { collection: string; actions: string[] }[];
      };
      // Validasi trigger collection terhadap skema project
      let triggers;
      if (Array.isArray(body.triggers)) {
        const existing = listCollections(db).map((c) => c.name);
        for (const t of body.triggers) {
          if (!existing.includes(t.collection)) {
            res.status(400).json({
              error: { code: 'BAD_REQUEST', message: `Trigger collection '${t.collection}' tidak ada di project ini` },
            });
            return;
          }
        }
        triggers = body.triggers.map((t) => ({
          collection: t.collection,
          actions: t.actions as ('create' | 'update' | 'delete')[],
        }));
      }
      const fn = updateFunction(db, req.params.name, { ...body, triggers });
      if (!fn) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Function tidak ditemukan' } });
        return;
      }
      res.json({ function: fn });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  router.delete('/api/admin/projects/:pid/functions/:name', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const ok = deleteFunction(db, req.params.name);
      if (!ok) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Function tidak ditemukan' } });
        return;
      }
      res.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  // ═════════════════════════════════════════════════════════════════════
  // EXECUTE — admin (selalu, + logs detail)
  // ═════════════════════════════════════════════════════════════════════

  router.post('/api/admin/projects/:pid/functions/:name/execute', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const fn = getFunctionByName(db, req.params.name);
      if (!fn) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Function tidak ditemukan' } });
        return;
      }

      const body = (req.body ?? {}) as { body?: unknown; query?: Record<string, string> };
      const result = runFunctionCode(fn.code, {
        body: body.body ?? {},
        query: body.query ?? {},
        auth: null,
        timeoutMs: fn.timeoutMs,
      });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(500).json({ error: { code: 'INTERNAL', message } });
    }
  });

  // ═════════════════════════════════════════════════════════════════════
  // EXECUTE — public (END USERS; hanya function enabled)
  // ═════════════════════════════════════════════════════════════════════

  router.post('/api/p/:pid/functions/:name/execute', (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const fn = getFunctionByName(db, req.params.name);
      if (!fn) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Function tidak ditemukan' } });
        return;
      }
      if (!fn.enabled) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Function tidak aktif' } });
        return;
      }

      const body = (req.body ?? {}) as { body?: unknown; query?: Record<string, string> };
      const result = runFunctionCode(fn.code, {
        body: body.body ?? {},
        query: body.query ?? {},
        auth: resolveUserAuth(req),
        timeoutMs: fn.timeoutMs,
      });

      if (!result.ok) {
        res.status(400).json({ error: { code: 'FUNCTION_ERROR', message: result.error, logs: result.logs } });
        return;
      }
      res.json({ result: result.result, logs: result.logs });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(500).json({ error: { code: 'INTERNAL', message } });
    }
  });

  return router;
}
