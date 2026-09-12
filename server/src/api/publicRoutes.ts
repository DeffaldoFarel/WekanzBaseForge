// ============================================================================
// M11: PUBLIC RECORD API + RULES ADMIN
//
// Dua kelompok route:
// 1. /api/p/:pid/collections/:name/records  → END USERS (JWT Bearer)
//    Rules dievaluasi per record/list; admin token juga diterima (bypass).
// 2. /api/admin/projects/:pid/collections/:name/rules → admin atur rules
// ============================================================================

import { Router, generateId } from '../core/router.js';
import { getProjectDb } from '../core/projectDbManager.js';
import { requireAdmin, validateToken } from '../platform/adminAuth.js';
import { verifyToken } from '../auth/jwt.js';
import { updateCollectionRules, getCollectionByName, createViewCollection } from '../core/schema.js';
import { exportCollection, importCollection } from '../core/collectionJson.js';
import {
  listRecords,
  getRecord,
  createRecord,
  updateRecord,
  deleteRecord,
  ViewWriteError,
  multipartToRecordData,
  cleanupReplacedFiles,
  cleanupAllRecordFiles,
} from '../core/records.js';
import { RequestContext } from '../core/query/sqlBuilder.js';
import { ForbiddenError } from '../core/rules.js';
import type { DatabaseSync } from 'node:sqlite';
import { deleteRecordFiles } from '../core/storage.js';
import { realtimeHub } from '../core/realtime.js';
import { fireTriggersSafe } from '../core/triggerExecutor.js';

// ─── Helper: identitas pemanggil (admin ATAU end user) ──────────────────────
// - Bearer JWT admin (login admin) → bypass rules (undefined ctx)
// - Bearer JWT end user (M09u)     → reqCtx = { auth: {...} }
// - Anonymous                      → reqCtx = { auth: null } (rules tetap jalan)

// M14: siapkan data dari body JSON ATAU multipart (file upload)
function prepareBodyData(
  req: { isMultipart?: boolean; rawBody?: Buffer; body: unknown; headers: { 'content-type'?: string } },
  db: DatabaseSync,
  projectId: string,
  collectionName: string,
  recordId: string // untuk create: id harus sudah dibuat dulu oleh caller
): Record<string, unknown> {
  const reqExt = req as { isMultipart?: boolean; rawBody?: Buffer; body: unknown; headers: { 'content-type'?: string } };
  if (reqExt.isMultipart && reqExt.rawBody) {
    const meta = getCollectionByName(db, collectionName);
    if (!meta) throw new Error(`Collection '${collectionName}' tidak ditemukan`);
    return multipartToRecordData(
      projectId,
      meta,
      recordId,
      reqExt.rawBody,
      reqExt.headers['content-type'] ?? ''
    );
  }
  return (reqExt.body ?? {}) as Record<string, unknown>;
}

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
  if (err instanceof ViewWriteError) {
    res.status(400).json({ error: { code: 'VIEW_READ_ONLY', message: err.message } });
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
  // ADMIN: create VIEW collection (M16a)
  // ═══════════════════════════════════════════════════════════════════════

  router.post('/api/admin/projects/:pid/views', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const body = (req.body ?? {}) as {
        name?: string;
        viewQuery?: string;
        rules?: Record<string, string | null>;
      };
      if (!body.name || !body.viewQuery) {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'name dan viewQuery wajib (viewQuery harus SELECT ...)' },
        });
        return;
      }
      const meta = createViewCollection(db, {
        name: body.name,
        viewQuery: body.viewQuery,
        rules: body.rules,
      });
      res.status(201).json({ collection: meta });
    } catch (err) {
      handleErrorPublic(res, err);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // ADMIN: IMPORT/EXPORT JSON (M16c)
  // ═══════════════════════════════════════════════════════════════════════

  // GET export → JSON file download
  router.get('/api/admin/projects/:pid/collections/:name/export', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const json = exportCollection(db, req.params.name);
      res.raw.setHeader('Content-Type', 'application/json');
      res.raw.setHeader(
        'Content-Disposition',
        `attachment; filename="${req.params.name}-export.json"`
      );
      res.raw.end(json);
    } catch (err) {
      handleErrorPublic(res, err);
    }
  });

  // POST import ← JSON body (data + mode)
  router.post('/api/admin/projects/:pid/collections/import', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const body = (req.body ?? {}) as { data?: string | object; mode?: 'create' | 'replace' | 'merge' };
      if (!body.data) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'data (JSON export) wajib' } });
        return;
      }
      const json = typeof body.data === 'string' ? body.data : JSON.stringify(body.data);
      const result = importCollection(db, json, { mode: body.mode });
      res.status(201).json(result);
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

      // M14: multipart perlu recordId SEBELUM insert (nama file = <id>_<filename>).
      // Kita generate id di sini dan pass ke createRecord via data hack:
      // cara bersih = createRecord menerima optional preGeneratedId.
      const meta = getCollectionByName(db, req.params.name);
      if (!meta) throw new Error(`Collection '${req.params.name}' tidak ditemukan`);
      const preId = generateId();
      const body = prepareBodyData(req, db, req.params.pid, req.params.name, preId);

      const record = createRecord(db, req.params.name, body, reqCtx, preId);
      // M13: broadcast ke realtime subscribers (setelah DB sukses)
      realtimeHub.publish(db, meta, 'create', record as Record<string, unknown>);
      // M15b: jalankan functions yang ter-trigger (setelah realtime)
      fireTriggersSafe(db, req.params.name, 'create', record as Record<string, unknown>);
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
      const meta = getCollectionByName(db, req.params.name);
      if (!meta) throw new Error(`Collection '${req.params.name}' tidak ditemukan`);

      // M14: snapshot file lama SEBELUM update (untuk cleanup yang diganti)
      const oldRecord = getRecordRawPublic(db, req.params.name, req.params.id);
      const body = prepareBodyData(req, db, req.params.pid, req.params.name, req.params.id);

      const record = updateRecord(db, req.params.name, req.params.id, body, reqCtx);
      if (!record) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record tidak ditemukan' } });
        return;
      }

      // M14: hapus file lama yang diganti (setelah UPDATE sukses)
      if (oldRecord) {
        cleanupReplacedFiles(req.params.pid, meta, req.params.id, oldRecord, body);
      }

      // M13: broadcast ke realtime subscribers
      realtimeHub.publish(db, meta, 'update', record as Record<string, unknown>);
      // M15b: jalankan trigger dengan previous = snapshot sebelum update
      fireTriggersSafe(
        db,
        req.params.name,
        'update',
        record as Record<string, unknown>,
        oldRecord ?? undefined
      );

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
      const meta = getCollectionByName(db, req.params.name);
      const ok = deleteRecord(db, req.params.name, req.params.id, reqCtx);
      if (!ok) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record tidak ditemukan' } });
        return;
      }
      // M14: hapus file fisik (setelah DB sukses)
      if (meta) {
        // M13: broadcast delete (record id terakhir yang diketahui subscriber)
        realtimeHub.publish(db, meta, 'delete', { id: req.params.id } as Record<string, unknown>);
        // M15b: trigger delete — record yang dikirim hanya { id }
        fireTriggersSafe(db, req.params.name, 'delete', { id: req.params.id });
        // record sudah terhapus — kita tak punya isinya; deleteRecordFiles by prefix
        deleteRecordFiles(req.params.pid, req.params.id);
      }
      res.json({ success: true });
    } catch (err) {
      handleErrorPublic(res, err);
    }
  });

  return router;
}

// ─── M14: ambil record utk snapshot file lama (API layer) ────────────────────

function getRecordRawPublic(
  db: DatabaseSync,
  collection: string,
  id: string
): Record<string, unknown> | null {
  // Pakai getRecord tanpa ctx (admin view — bypass rules)
  const rec = getRecord(db, collection, id);
  return rec as unknown as Record<string, unknown> | null;
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
