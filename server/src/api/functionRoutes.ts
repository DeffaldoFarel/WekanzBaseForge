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
import { fireTriggersSafe } from '../core/triggerExecutor.js';
import { setSecret, listSecrets, deleteSecret, getSecretsForFunction } from '../core/secretsStore.js';
import { setModule, listModules, getModule, deleteModule } from '../core/moduleRegistry.js';
import type { RequestContext } from '../core/query/sqlBuilder.js';
import { verifyToken } from '../auth/jwt.js';
import { validateToken } from '../platform/adminAuth.js';

// Helper: auth end user dari Bearer JWT (anonymous → auth: null)
// M18b: verifyToken ASYNC (jose) — helper jadi async juga
async function resolveUserAuth(req: { headers: { authorization?: string } }): Promise<RequestContext['auth']> {
  const auth = req.headers.authorization;
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!bearer || validateToken(bearer)) return null; // admin token → tidak dipakai sebagai user
  const result = await verifyToken(bearer);
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
        schedule?: string | null;
        httpAllow?: string[];
        timezone?: string;
        dbAccess?: boolean;
        modules?: string[];
        memoryMb?: number;
      };
      if (!body.name || !body.code) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'name and code are required' } });
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
              error: { code: 'BAD_REQUEST', message: `Trigger collection '${t.collection}' does not exist in this project` },
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
        schedule: body.schedule,
        httpAllow: body.httpAllow, // M25
        timezone: body.timezone, // M39
        dbAccess: body.dbAccess, // M41
        modules: body.modules, // M43
        memoryMb: body.memoryMb, // M44
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
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Function not found' } });
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
        schedule?: string | null;
        httpAllow?: string[];
        timezone?: string;
        dbAccess?: boolean;
        modules?: string[];
        memoryMb?: number;
      };
      // Validasi trigger collection terhadap skema project
      let triggers;
      if (Array.isArray(body.triggers)) {
        const existing = listCollections(db).map((c) => c.name);
        for (const t of body.triggers) {
          if (!existing.includes(t.collection)) {
            res.status(400).json({
              error: { code: 'BAD_REQUEST', message: `Trigger collection '${t.collection}' does not exist in this project` },
            });
            return;
          }
        }
        triggers = body.triggers.map((t) => ({
          collection: t.collection,
          actions: t.actions as ('create' | 'update' | 'delete')[],
        }));
      }
      const fn = updateFunction(db, req.params.name, {
        code: body.code,
        enabled: body.enabled,
        timeoutMs: body.timeoutMs,
        triggers,
        schedule: body.schedule,
        httpAllow: body.httpAllow, // M25: undefined = tidak disentuh
        timezone: body.timezone, // M39: undefined = tidak disentuh
        dbAccess: body.dbAccess, // M41: undefined = tidak disentuh
        modules: body.modules, // M43: undefined = tidak disentuh
        memoryMb: body.memoryMb, // M44: undefined = tidak disentuh
      });
      if (!fn) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Function not found' } });
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
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Function not found' } });
        return;
      }
      res.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  // ═════════════════════════════════════════════════════════════════════
  // SECRETS — M42 (admin-only; nilai TIDAK pernah dikembalikan)
  // ═════════════════════════════════════════════════════════════════════

  // PUT /api/admin/projects/:pid/functions/:name/secrets  { key, value }
  router.put('/api/admin/projects/:pid/functions/:name/secrets', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const fn = getFunctionByName(db, req.params.name);
      if (!fn) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Function not found' } });
        return;
      }
      const body = (req.body ?? {}) as { key?: string; value?: string };
      if (!body.key || body.value === undefined) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'key and value are required' } });
        return;
      }
      setSecret(db, req.params.name, body.key, body.value);
      res.json({ success: true, key: body.key });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  // GET /api/admin/projects/:pid/functions/:name/secrets → metadata (TANPA nilai)
  router.get('/api/admin/projects/:pid/functions/:name/secrets', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const fn = getFunctionByName(db, req.params.name);
      if (!fn) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Function not found' } });
        return;
      }
      res.json({ secrets: listSecrets(db, req.params.name) });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  // DELETE /api/admin/projects/:pid/functions/:name/secrets/:key
  router.delete('/api/admin/projects/:pid/functions/:name/secrets/:key', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const fn = getFunctionByName(db, req.params.name);
      if (!fn) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Function not found' } });
        return;
      }
      const ok = deleteSecret(db, req.params.name, req.params.key);
      if (!ok) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Secret not found' } });
        return;
      }
      res.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  // ═════════════════════════════════════════════════════════════════════
  // MODULES — M43 (admin-only; kode bersama yang di-load sebagai $lib)
  // ═════════════════════════════════════════════════════════════════════

  // PUT /api/admin/projects/:pid/modules/:name  { code }
  router.put('/api/admin/projects/:pid/modules/:name', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const body = (req.body ?? {}) as { code?: string };
      if (!body.code) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'code is required' } });
        return;
      }
      setModule(db, req.params.name, body.code);
      res.json({ success: true, name: req.params.name });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  // GET /api/admin/projects/:pid/modules → metadata semua modul
  router.get('/api/admin/projects/:pid/modules', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      res.json({ modules: listModules(db) });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  // GET /api/admin/projects/:pid/modules/:name → satu modul (dengan kode)
  router.get('/api/admin/projects/:pid/modules/:name', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const mod = getModule(db, req.params.name);
      if (!mod) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Module not found' } });
        return;
      }
      res.json({ module: mod });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  // DELETE /api/admin/projects/:pid/modules/:name
  router.delete('/api/admin/projects/:pid/modules/:name', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const ok = deleteModule(db, req.params.name);
      if (!ok) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Module not found' } });
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

  router.post('/api/admin/projects/:pid/functions/:name/execute', requireAdmin, async (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const fn = getFunctionByName(db, req.params.name);
      if (!fn) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Function not found' } });
        return;
      }

      const body = (req.body ?? {}) as { body?: unknown; query?: Record<string, string> };
      const result = await runFunctionCode(fn.code, {
        body: body.body ?? {},
        query: body.query ?? {},
        auth: null,
        timeoutMs: fn.timeoutMs,
        memoryLimitMb: fn.memoryMb, // M44
        httpAllow: fn.httpAllow, // M25: allowlist $http per function
        // M41: $db in-process. depth 0 = invoke langsung → tulisan $db
        // boleh memicu trigger; onDbWrite disuntik agar reaksi tetap jalan.
        projectDb: db,
        dbAccess: fn.dbAccess,
        depth: 0,
        secrets: getSecretsForFunction(db, fn.name), // M42
        modules: fn.modules, // M43
        onDbWrite: (action, collection, record, previous) =>
          fireTriggersSafe(db, collection, action, record, previous, 1),
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

  router.post('/api/p/:pid/functions/:name/execute', async (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const fn = getFunctionByName(db, req.params.name);
      if (!fn) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Function not found' } });
        return;
      }
      if (!fn.enabled) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Function is disabled' } });
        return;
      }

      const body = (req.body ?? {}) as { body?: unknown; query?: Record<string, string> };
      const result = await runFunctionCode(fn.code, {
        body: body.body ?? {},
        query: body.query ?? {},
        auth: await resolveUserAuth(req),
        timeoutMs: fn.timeoutMs,
        memoryLimitMb: fn.memoryMb, // M44
        httpAllow: fn.httpAllow, // M25: allowlist $http per function
        // M41: $db in-process (lihat catatan IDENTITAS di dbSandbox.ts —
        // $db berjalan sebagai admin, TIDAK dibatasi API rules, walaupun
        // pemanggilnya end user; itulah gunanya opt-in db_access).
        projectDb: db,
        dbAccess: fn.dbAccess,
        depth: 0,
        secrets: getSecretsForFunction(db, fn.name), // M42
        modules: fn.modules, // M43
        onDbWrite: (action, collection, record, previous) =>
          fireTriggersSafe(db, collection, action, record, previous, 1),
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
