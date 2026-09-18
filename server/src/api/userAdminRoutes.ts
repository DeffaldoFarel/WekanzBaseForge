// ============================================================================
// M10u: ADMIN API — USER MANAGEMENT + RULES ROUTES
//
// Endpoint untuk dashboard:
// 1. /api/admin/projects/:pid/auth-users       → kelola END USERS
//    (bukan admin! ini user aplikasi milik project)
// 2. /api/admin/projects/:pid/collections/:name/rules → lihat/atur rules
// ============================================================================

import { Router } from '../core/router.js';
import { requireAdmin } from '../platform/adminAuth.js';
import { getProjectDb } from '../core/projectDbManager.js';
import { getCollectionByName, updateCollectionRules } from '../core/schema.js';
import {
  initAuthUsersTable,
  createAuthUser,
  listAuthUsers,
  findAuthUserById,
  changeAuthUserPassword,
  deleteAuthUser,
  setAuthUserVerified,
  setAuthUserDisabled,
} from '../auth/users.js';
import { initMfaTable, isMfaEnabled } from '../auth/mfa.js';

export function createUserAdminRouter(): Router {
  const router = new Router();

  // ─── AUTH USERS (end users milik project) ────────────────────────────────

  // GET list users
  router.get('/api/admin/projects/:pid/auth-users', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      initAuthUsersTable(db); // idempotent — jaga-jaga kalau belum ada
      initMfaTable(db); // M27
      const page = req.query.get('page') ? parseInt(req.query.get('page')!, 10) : 1;
      const perPage = req.query.get('perPage') ? parseInt(req.query.get('perPage')!, 10) : 50;
      const search = req.query.get('search') ?? undefined; // M47
      const result = listAuthUsers(db, page, perPage, search);
      // M27: perkaya dengan status MFA per user
      const items = result.items.map((u) => ({ ...u, mfaEnabled: isMfaEnabled(db, u.id) }));
      res.json({ ...result, items });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  // POST create user (dashboard mendaftarkan user baru)
  router.post('/api/admin/projects/:pid/auth-users', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      initAuthUsersTable(db);
      const body = (req.body ?? {}) as { email?: string; password?: string; name?: string };
      if (!body.email || !body.password) {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'email and password are required' },
        });
        return;
      }
      const user = createAuthUser(db, {
        email: body.email,
        password: body.password,
        name: body.name,
      });
      res.status(201).json({ user });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      const status = /sudah digunakan|already/i.test(message) ? 409 : 400;
      res.status(status).json({ error: { code: status === 409 ? 'CONFLICT' : 'BAD_REQUEST', message } });
    }
  });

  // PATCH ganti password
  router.patch('/api/admin/projects/:pid/auth-users/:uid', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const body = (req.body ?? {}) as { password?: string };
      if (!body.password) {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'password is required' },
        });
        return;
      }
      const ok = changeAuthUserPassword(db, req.params.uid, body.password);
      if (!ok) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
        return;
      }
      res.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  // DELETE user
  router.delete('/api/admin/projects/:pid/auth-users/:uid', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const ok = deleteAuthUser(db, req.params.uid);
      if (!ok) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
        return;
      }
      res.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  // GET satu user
  router.get('/api/admin/projects/:pid/auth-users/:uid', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const user = findAuthUserById(db, req.params.uid);
      if (!user) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
        return;
      }
      res.json({ user });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  // M47: PATCH verify user
  router.post('/api/admin/projects/:pid/auth-users/:uid/verify', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      initAuthUsersTable(db); // pastikan kolom disabled ada
      const body = (req.body ?? {}) as { verified?: boolean };
      const verified = body.verified !== false; // default true
      const ok = setAuthUserVerified(db, req.params.uid, verified);
      if (!ok) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
        return;
      }
      res.json({ success: true, verified });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  // M47: PATCH disable/enable user
  router.post('/api/admin/projects/:pid/auth-users/:uid/disable', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      initAuthUsersTable(db);
      const body = (req.body ?? {}) as { disabled?: boolean };
      const disabled = body.disabled !== false; // default true
      const ok = setAuthUserDisabled(db, req.params.uid, disabled);
      if (!ok) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
        return;
      }
      res.json({ success: true, disabled });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  // ─── RULES (lihat & atur per collection) ─────────────────────────────────

  // GET rules collection
  router.get('/api/admin/projects/:pid/collections/:name/rules', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const meta = getCollectionByName(db, req.params.name);
      if (!meta) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Collection not found' } });
        return;
      }
      res.json({ rules: meta.rules });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  // PATCH rules (update sebagian/semua rule)
  router.patch('/api/admin/projects/:pid/collections/:name/rules', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const allowed = ['listRule', 'viewRule', 'createRule', 'updateRule', 'deleteRule'] as const;
      const rules: Record<string, string | null> = {};
      for (const key of allowed) {
        if (key in body) {
          const v = body[key];
          if (v !== null && typeof v !== 'string') {
            res.status(400).json({
              error: { code: 'BAD_REQUEST', message: `${key} must be a string or null` },
            });
            return;
          }
          rules[key] = v as string | null;
        }
      }
      const meta = updateCollectionRules(db, req.params.name, rules);
      res.json({ rules: meta.rules });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  return router;
}
