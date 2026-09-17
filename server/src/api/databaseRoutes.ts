// ============================================================================
// M05u: DATABASE ADMIN API ROUTES
//
// Endpoint untuk mengelola collections (schema) dan records (data) pada
// sebuah project. Inilah jembatan antara engine M03-M05 dan dashboard UI.
//
// Semua route butuh admin token (requireAdmin dari M00).
// ============================================================================

import { Router } from '../core/router.js';
import { requireAdmin } from '../platform/adminAuth.js';
import { getProjectDb, closeProjectDb } from '../core/projectDbManager.js';
import { projectDbPath, projectDir } from '../core/platformDb.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  defineCollection,
  createViewCollection,
  getCollectionByName,
  listCollections,
  deleteCollection,
  duplicateCollection,
  updateCollection,
  rebuildCollection,
} from '../core/schema.js';
// M19: agregasi — modul core D7 yang sebelumnya tidak punya pintu REST.
import { aggregate, AggregateFunction } from '../core/aggregates.js';
import {
  createRecord,
  createRecordsBatch,
  getRecord,
  updateRecord,
  deleteRecord,
  listRecords,
} from '../core/records.js';
import { fireWebhooks } from '../core/webhooks.js';
import { fireTriggersSafe } from '../core/triggerExecutor.js';
import type { CollectionDefinition, IndexDefinition } from '../core/schema.js';
import type { CollectionRules } from '../core/rules.js';
import type { FieldDefinition } from '../core/fieldTypes.js';
import type { DatabaseSync } from 'node:sqlite';

// Helper: snapshot record sebelum update (untuk webhook previous)
function snapshotRecord(db: DatabaseSync, collection: string, id: string): Record<string, unknown> | null {
  const rec = getRecord(db, collection, id);
  return rec as unknown as Record<string, unknown> | null;
}

export function createDatabaseRouter(): Router {
  const router = new Router();

  // ════════════════════════════════════════════════════════════════════════
  // COLLECTIONS (SCHEMA)
  // ════════════════════════════════════════════════════════════════════════

  // GET /api/admin/projects/:pid/collections — daftar collection + jumlah record
  router.get('/api/admin/projects/:pid/collections', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const collections = listCollections(db).map((meta) => {
        // Hitung jumlah record per collection (untuk tampilan)
        let count = 0;
        try {
          count = (
            db.prepare(`SELECT COUNT(*) AS n FROM "${meta.name}"`).get() as { n: number }
          ).n;
        } catch {
          count = 0;
        }
        return {
          name: meta.name,
          type: meta.type ?? 'base',
          viewQuery: meta.viewQuery ?? null,
          fields: meta.fields,
          indexes: meta.indexes,
          rules: meta.rules,
          recordCount: count,
          created: meta.created,
        };
      });
      res.json({ collections });
    } catch (err) {
      handleError(res, err);
    }
  });

  // POST /api/admin/projects/:pid/collections — buat collection baru (base atau view)
  router.post('/api/admin/projects/:pid/collections', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const body = req.body as (CollectionDefinition & { type?: 'base' | 'view'; viewQuery?: string }) | undefined;

      if (!body?.name) {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'name is required' },
        });
        return;
      }

      if (body.type === 'view') {
        if (!body.viewQuery || typeof body.viewQuery !== 'string') {
          res.status(400).json({
            error: { code: 'BAD_REQUEST', message: 'viewQuery is required for view collections' },
          });
          return;
        }
        const meta = createViewCollection(db, {
          name: body.name,
          viewQuery: body.viewQuery,
          rules: body.rules,
        });
        res.status(201).json({ collection: meta });
        return;
      }

      // Default: base collection
      if (!Array.isArray(body.fields)) {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'fields (array) is required for base collections' },
        });
        return;
      }

      const meta = defineCollection(db, {
        name: body.name,
        type: body.type,
        fields: body.fields,
        indexes: body.indexes,
        rules: body.rules,
      });

      res.status(201).json({ collection: meta });
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET /api/admin/projects/:pid/collections/:name — detail collection
  router.get('/api/admin/projects/:pid/collections/:name', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const meta = getCollectionByName(db, req.params.name);
      if (!meta) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Collection not found' } });
        return;
      }
      res.json({ collection: meta });
    } catch (err) {
      handleError(res, err);
    }
  });

  // PATCH /api/admin/projects/:pid/collections/:name — update fields (tambah kolom baru)
  router.patch('/api/admin/projects/:pid/collections/:name', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const body = req.body as { fields?: FieldDefinition[] } | undefined;
      if (!Array.isArray(body?.fields)) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'fields must be an array' } });
        return;
      }
      const updated = updateCollection(db, req.params.name, { fields: body.fields });
      res.json({ collection: updated });
    } catch (err) {
      handleError(res, err);
    }
  });

  // PUT /api/admin/projects/:pid/collections/:name — full schema edit (rebuild table: ubah/hapus/tambah kolom & indexes)
  router.put('/api/admin/projects/:pid/collections/:name', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const body = req.body as {
        fields?: FieldDefinition[];
        indexes?: IndexDefinition[];
        rules?: Partial<CollectionRules>;
      } | undefined;
      if (!Array.isArray(body?.fields)) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'fields must be an array' } });
        return;
      }
      const updated = rebuildCollection(db, req.params.name, {
        fields: body.fields,
        indexes: Array.isArray(body.indexes) ? body.indexes : undefined,
        // M21 (B2): sebelumnya rules tidak pernah diteruskan ke sini, sehingga
        // PUT dengan rules membalas 200 tanpa menyimpan apa pun.
        rules:
          body.rules && typeof body.rules === 'object' ? body.rules : undefined,
      });
      res.json({ collection: updated });
    } catch (err) {
      handleError(res, err);
    }
  });

  // DELETE /api/admin/projects/:pid/collections/:name — hapus collection
  router.delete('/api/admin/projects/:pid/collections/:name', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const deleted = deleteCollection(db, req.params.name);
      if (!deleted) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Collection not found' } });
        return;
      }
      res.json({ success: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  // RECORDS (DATA)
  // ════════════════════════════════════════════════════════════════════════

  // M19: GET /api/admin/projects/:pid/collections/:name/aggregate
  //   ?function=count|sum|avg|min|max&field=&filter=&groupBy=
  // Admin → reqCtx undefined → bypass rules (konsisten dgn route records).
  router.get('/api/admin/projects/:pid/collections/:name/aggregate', requireAdmin, (req, res) => {
    try {
      const fn = req.query.get('function');
      if (!fn) {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: "Query param 'function' is required (count|sum|avg|min|max)" },
        });
        return;
      }
      if (!['count', 'sum', 'avg', 'min', 'max'].includes(fn)) {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: `Unknown aggregate function: '${fn}'` },
        });
        return;
      }
      // sum/avg/min/max tanpa field = permintaan tidak masuk akal → 400,
      // bukan 500. Validasi di core melempar Error biasa yang jatuh ke 500.
      const field = req.query.get('field') ?? undefined;
      if (fn !== 'count' && !field) {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: `Aggregate '${fn}' membutuhkan query param 'field'` },
        });
        return;
      }
      const db = getProjectDb(req.params.pid);
      const result = aggregate(db, req.params.name, {
        function: fn as AggregateFunction,
        field,
        filter: req.query.get('filter') ?? undefined,
        groupBy: req.query.get('groupBy') ?? undefined,
      });
      res.json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET /api/admin/projects/:pid/collections/:name/records
  //   ?filter=&sort=&page=&perPage=
  router.get('/api/admin/projects/:pid/collections/:name/records', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const result = listRecords(db, req.params.name, {
        filter: req.query.get('filter') ?? undefined,
        sort: req.query.get('sort') ?? undefined,
        search: req.query.get('search') ?? undefined,
        expand: req.query.get('expand') ?? undefined,
        page: req.query.get('page') ? parseInt(req.query.get('page')!, 10) : 1,
        perPage: req.query.get('perPage') ? parseInt(req.query.get('perPage')!, 10) : 20,
      });
      res.json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  // POST /api/admin/projects/:pid/collections/:name/records — buat record
  router.post('/api/admin/projects/:pid/collections/:name/records', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const record = createRecord(db, req.params.name, body);
      // M28: webhook + trigger + realtime untuk admin API juga
      fireWebhooks(db, {
        projectId: req.params.pid,
        action: 'create',
        collection: req.params.name,
        record: record as Record<string, unknown>,
      });
      fireTriggersSafe(db, req.params.name, 'create', record as Record<string, unknown>);
      res.status(201).json({ record });
    } catch (err) {
      handleError(res, err);
    }
  });

  // PATCH /api/admin/projects/:pid/collections/:name/records/:id — update record
  router.patch('/api/admin/projects/:pid/collections/:name/records/:id', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const oldRecord = snapshotRecord(db, req.params.name, req.params.id);
      const record = updateRecord(db, req.params.name, req.params.id, body);
      if (!record) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record not found' } });
        return;
      }
      fireWebhooks(db, {
        projectId: req.params.pid,
        action: 'update',
        collection: req.params.name,
        record: record as Record<string, unknown>,
        previous: (oldRecord ?? null) as Record<string, unknown> | null,
      });
      fireTriggersSafe(db, req.params.name, 'update', record as Record<string, unknown>, oldRecord ?? undefined);
      res.json({ record });
    } catch (err) {
      handleError(res, err);
    }
  });

  // DELETE /api/admin/projects/:pid/collections/:name/records/:id — hapus record
  router.delete('/api/admin/projects/:pid/collections/:name/records/:id', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const deleted = deleteRecord(db, req.params.name, req.params.id);
      if (!deleted) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record not found' } });
        return;
      }
      fireWebhooks(db, {
        projectId: req.params.pid,
        action: 'delete',
        collection: req.params.name,
        record: { id: req.params.id },
      });
      fireTriggersSafe(db, req.params.name, 'delete', { id: req.params.id });
      res.json({ success: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  // B3: UTILITAS (duplikasi collection + batch API)
  // ════════════════════════════════════════════════════════════════════════

  // POST /api/admin/projects/:pid/collections/:name/duplicate
  //   body: { newName, withData? }
  router.post('/api/admin/projects/:pid/collections/:name/duplicate', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const body = req.body as { newName?: string; withData?: boolean } | undefined;

      if (!body?.newName) {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'newName is required' },
        });
        return;
      }

      const created = duplicateCollection(db, req.params.name, body.newName, {
        withData: body.withData ?? false,
      });
      res.status(201).json({ collection: created });
    } catch (err) {
      handleError(res, err);
    }
  });

  // POST /api/admin/projects/:pid/collections/:name/records/batch
  //   body: { records: [...] } → insert semua dalam 1 transaksi (atomik)
  router.post('/api/admin/projects/:pid/collections/:name/records/batch', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const body = req.body as { records?: Record<string, unknown>[] } | undefined;

      if (!Array.isArray(body?.records)) {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'records must be an array' },
        });
        return;
      }

      const created = createRecordsBatch(db, req.params.name, body.records);
      res.status(201).json({ records: created, count: created.length });
    } catch (err) {
      handleError(res, err);
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  // B2: BACKUP & RESTORE
  // ════════════════════════════════════════════════════════════════════════

  // POST /api/admin/projects/:pid/backup — backup database project → file .db
  // SQLite memudahkan backup: VACUUM INTO membuat salinan konsisten.
  router.post('/api/admin/projects/:pid/backup', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupName = `backup-${req.params.pid}-${timestamp}.db`;
      const backupPath = projectDbPath(req.params.pid).replace('data.db', backupName);

      // VACUUM INTO = salinan database yang konsisten & terkompak
      db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);

      res.json({
        success: true,
        backup: backupName,
        path: backupPath,
        sizeBytes: fs.statSync(backupPath).size,
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET /api/admin/projects/:pid/backups — daftar file backup yang ada
  router.get('/api/admin/projects/:pid/backups', requireAdmin, (req, res) => {
    try {
      const dir = projectDir(req.params.pid);
      if (!fs.existsSync(dir)) {
        res.json({ backups: [] });
        return;
      }
      const backups = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith('backup-') && f.endsWith('.db'))
        .map((f) => ({
          name: f,
          sizeBytes: fs.statSync(path.join(dir, f)).size,
          modified: fs.statSync(path.join(dir, f)).mtime.toISOString(),
        }))
        .sort((a, b) => b.modified.localeCompare(a.modified));
      res.json({ backups });
    } catch (err) {
      handleError(res, err);
    }
  });

  return router;
}

// Helper: petakan error ke HTTP response yang sesuai
function handleError(res: { status: (c: number) => { json: (d: unknown) => void } }, err: unknown): void {
  const message = err instanceof Error ? err.message : 'Unknown error';

  // Error "tidak ditemukan"
  if (/not found/i.test(message)) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message } });
    return;
  }
  // Error validasi (user input salah)
  // M21 (B3): 'Duplicate' ditambahkan — field duplikat adalah kesalahan input
  // klien, sebelumnya lolos ke cabang 500 karena SQLite yang melaporkannya.
  if (/required|must be|Invalid|not exist|already exists|reserved|Duplicate|duplicate column/i.test(message)) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message } });
    return;
  }
  // Sisanya: server error
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message } });
}

export { closeProjectDb };
