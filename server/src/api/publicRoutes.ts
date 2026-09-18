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
import { verifyPassword } from '../auth/password.js';
import { issueTokens, initAuthTokensTable, hashToken } from '../auth/tokens.js';
import { updateCollectionRules, getCollectionByName, createViewCollection } from '../core/schema.js';
import { exportCollection, importCollection } from '../core/collectionJson.js';
import {
  listRecords,
  getRecord,
  createRecord,
  createRecordsBatch,
  updateRecord,
  deleteRecord,
  ViewWriteError,
  DuplicateIdError,
  DuplicateEmailError,
  multipartToRecordData,
  cleanupReplacedFiles,
  cleanupAllRecordFiles,
} from '../core/records.js';
import { RequestContext } from '../core/query/sqlBuilder.js';
import { ForbiddenError } from '../core/rules.js';
import type { DatabaseSync } from 'node:sqlite';
import { deleteRecordFiles } from '../core/storage.js';
import { realtimeHub } from '../core/realtime.js';
import { checkSearchRateLimit } from '../core/searchGuard.js'; // M18e
import { extractApiKey, resolveApiKey, ApiKeyError } from '../auth/apiKeys.js'; // M26
// M19: agregasi lewat REST publik — WAJIB meneruskan reqCtx supaya listRule
// ikut membatasi baris yang dihitung (COUNT saja sudah membocorkan data).
import { aggregate, AggregateFunction } from '../core/aggregates.js';
import { fireTriggersSafe } from '../core/triggerExecutor.js';
import { fireWebhooks } from '../core/webhooks.js'; // M28
import { vectorSearch, VectorSearchOptions } from '../core/vectorSearch.js'; // M29

// ─── Helper: identitas pemanggil (admin ATAU end user) ──────────────────────
// - Bearer JWT admin (login admin) → bypass rules (undefined ctx)
// - Bearer JWT end user (M09u)     → reqCtx = { auth: {...} }
// - Anonymous                      → reqCtx = { auth: null } (rules tetap jalan)

// M14: siapkan data dari body JSON ATAU multipart (file upload)
// M18c: busboy ASYNC — helper jadi async
async function prepareBodyData(
  req: { isMultipart?: boolean; rawBody?: Buffer; body: unknown; headers: { 'content-type'?: string } },
  db: DatabaseSync,
  projectId: string,
  collectionName: string,
  recordId: string // untuk create: id harus sudah dibuat dulu oleh caller
): Promise<Record<string, unknown>> {
  const reqExt = req as { isMultipart?: boolean; rawBody?: Buffer; body: unknown; headers: { 'content-type'?: string } };
  if (reqExt.isMultipart && reqExt.rawBody) {
    const meta = getCollectionByName(db, collectionName);
    if (!meta) throw new Error(`Collection '${collectionName}' not found`);
    return await multipartToRecordData(
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
  if (err instanceof ApiKeyError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof ForbiddenError) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: err.message } });
    return;
  }
  if (err instanceof ViewWriteError) {
    res.status(400).json({ error: { code: 'VIEW_READ_ONLY', message: err.message } });
    return;
  }
  if (err instanceof DuplicateIdError) {
    res.status(409).json({ error: { code: 'DOCUMENT_ID_TAKEN', message: err.message } });
    return;
  }
  // M40: email duplikat di auth collection → 409 EMAIL_TAKEN
  if (err instanceof DuplicateEmailError) {
    res.status(409).json({ error: { code: 'EMAIL_TAKEN', message: err.message } });
    return;
  }
  const message = err instanceof Error ? err.message : 'Internal error';
  const status = /not found/i.test(message) ? 404 : 400;
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
            res.status(400).json({ error: { code: 'BAD_REQUEST', message: `${key} must be a string or null` } });
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
          error: { code: 'BAD_REQUEST', message: 'name and viewQuery are required (viewQuery must be a SELECT ...)' },
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
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'data (JSON export) is required' } });
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
  // M18e: rate limit KHUSUS request dengan ?search= (FTS scan mahal, anti
  // dictionary-abuse). List biasa tanpa search tidak terbatas.
  router.get('/api/p/:pid/collections/:name/records', async (req, res) => {
    try {
      const searchQ = req.query.get('search') ?? undefined; // M17b
      if (searchQ) {
        const ip = req.raw.socket.remoteAddress ?? 'unknown';
        const allowed = await checkSearchRateLimit(req.params.pid, ip);
        if (!allowed) {
          res.status(429).json({
            error: { code: 'RATE_LIMITED', message: 'Too many search requests. Please try again shortly.' },
          });
          return;
        }
      }
      const db = getProjectDb(req.params.pid);
      const reqCtx = await resolveEndUserCtx(req, db, { pid: req.params.pid }); // admin/apikey → undefined (bypass)
      const result = listRecords(db, req.params.name, {
        filter: req.query.get('filter') ?? undefined,
        sort: req.query.get('sort') ?? undefined,
        expand: req.query.get('expand') ?? undefined, // M19
        page: req.query.get('page') ? parseInt(req.query.get('page')!, 10) : 1,
        perPage: req.query.get('perPage') ? parseInt(req.query.get('perPage')!, 10) : 20,
        reqCtx,
        search: searchQ,
      });
      res.json(result);
    } catch (err) {
      handleErrorPublic(res, err);
    }
  });

  // M19: GET /api/p/:pid/collections/:name/aggregate
  //   ?function=count|sum|avg|min|max&field=&filter=&groupBy=
  // Berbeda dari jalur admin: reqCtx DITERUSKAN, sehingga listRule membatasi
  // baris yang ikut dihitung. Tanpa ini, end user bisa meng-COUNT baris milik
  // user lain meski tidak satu pun record bisa dibaca.
  router.get('/api/p/:pid/collections/:name/aggregate', async (req, res) => {
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
      const db = getProjectDb(req.params.pid);
      const reqCtx = await resolveEndUserCtx(req, db, { pid: req.params.pid });
      const field = req.query.get('field') ?? undefined;
      if (fn !== 'count' && !field) {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: `Aggregate '${fn}' membutuhkan query param 'field'` },
        });
        return;
      }
      const result = aggregate(db, req.params.name, {
        function: fn as AggregateFunction,
        field,
        filter: req.query.get('filter') ?? undefined,
        groupBy: req.query.get('groupBy') ?? undefined,
        reqCtx,
      });
      res.json(result);
    } catch (err) {
      handleErrorPublic(res, err);
    }
  });

  // M29: POST /api/p/:pid/collections/:name/vector-search
  //   Body: { vector: [0.1, ...], k?, field?, metric?, minScore?, filter? }
  //   → { items: [{id, score, record}], totalSearched, vectorField, metric, durationMs }
  //   listRule ditegakkan (sama seperti aggregate M19 — similarity bocor data).
  router.post('/api/p/:pid/collections/:name/vector-search', async (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const body = (req.body ?? {}) as {
        vector?: number[]; k?: number; field?: string;
        metric?: string; minScore?: number; filter?: string;
      };
      if (!Array.isArray(body.vector) || body.vector.length === 0) {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'vector (array of numbers) is required' },
        });
        return;
      }
      const metric = body.metric === 'l2' ? 'l2' as const : 'cosine' as const;
      const reqCtx = await resolveEndUserCtx(req, db, { pid: req.params.pid });
      const result = vectorSearch(db, req.params.name, {
        vector: body.vector,
        k: body.k,
        field: body.field,
        metric,
        minScore: body.minScore,
        filter: body.filter,
        reqCtx,
      });
      res.json(result);
    } catch (err) {
      handleErrorPublic(res, err);
    }
  });

  // GET satu record (view)
  router.get('/api/p/:pid/collections/:name/records/:id', async (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const reqCtx = await resolveEndUserCtx(req, db, { pid: req.params.pid });
      const record = getRecord(db, req.params.name, req.params.id, reqCtx, {
        expand: req.query.get('expand') ?? undefined, // M19
      });
      if (!record) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record not found' } });
        return;
      }
      res.json({ record });
    } catch (err) {
      handleErrorPublic(res, err);
    }
  });

  // POST create
  router.post('/api/p/:pid/collections/:name/records', async (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const reqCtx = await resolveEndUserCtx(req, db, { pid: req.params.pid, write: true });

      // M14: multipart perlu recordId SEBELUM insert (nama file = <id>_<filename>).
      // Kita generate id di sini dan pass ke createRecord via data hack:
      // cara bersih = createRecord menerima optional preGeneratedId.
      const meta = getCollectionByName(db, req.params.name);
      if (!meta) throw new Error(`Collection '${req.params.name}' not found`);
      const preId = generateId();
      const body = await prepareBodyData(req, db, req.params.pid, req.params.name, preId);

      const record = createRecord(db, req.params.name, body, reqCtx, preId);
      // M13: broadcast ke realtime subscribers (setelah DB sukses)
      realtimeHub.publish(db, meta, 'create', record as Record<string, unknown>);
      // M15b: jalankan functions yang ter-trigger (setelah realtime)
      // M28: webhook outbound (fire-and-forget)
      fireWebhooks(db, {
        projectId: req.params.pid,
        action: 'create',
        collection: req.params.name,
        record: record as Record<string, unknown>,
      });
      fireTriggersSafe(db, req.params.name, 'create', record as Record<string, unknown>);
      res.status(201).json({ record });
    } catch (err) {
      handleErrorPublic(res, err);
    }
  });

  // Ops-2: POST /api/p/:pid/collections/:name/records/batch — batch transaksional
  // untuk END USER. Semua record dalam SATU transaksi (semua sukses / semua
  // rollback). Rules dievaluasi per record terhadap reqCtx — batch TIDAK
  // melewati keamanan. Maks 100 record per batch.
  router.post('/api/p/:pid/collections/:name/records/batch', async (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const reqCtx = await resolveEndUserCtx(req, db, { pid: req.params.pid, write: true });

      const meta = getCollectionByName(db, req.params.name);
      if (!meta) throw new Error(`Collection '${req.params.name}' not found`);

      const body = (req.body ?? {}) as { records?: Record<string, unknown>[] };
      if (!Array.isArray(body.records) || body.records.length === 0) {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'records must be a non-empty array' },
        });
        return;
      }
      if (body.records.length > 100) {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'a batch may hold at most 100 records' },
        });
        return;
      }

      const created = createRecordsBatch(db, req.params.name, body.records, reqCtx);

      // Side effects SETELAH commit (pola yang sama dengan single create)
      for (const record of created) {
        realtimeHub.publish(db, meta, 'create', record as Record<string, unknown>);
        fireWebhooks(db, {
          projectId: req.params.pid,
          action: 'create',
          collection: req.params.name,
          record: record as Record<string, unknown>,
        });
        fireTriggersSafe(db, req.params.name, 'create', record as Record<string, unknown>);
      }
      res.status(201).json({ records: created, count: created.length });
    } catch (err) {
      handleErrorPublic(res, err);
    }
  });

  // PATCH update
  router.patch('/api/p/:pid/collections/:name/records/:id', async (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const reqCtx = await resolveEndUserCtx(req, db, { pid: req.params.pid, write: true });
      const meta = getCollectionByName(db, req.params.name);
      if (!meta) throw new Error(`Collection '${req.params.name}' not found`);

      // M14: snapshot file lama SEBELUM update (untuk cleanup yang diganti)
      const oldRecord = getRecordRawPublic(db, req.params.name, req.params.id);
      const body = await prepareBodyData(req, db, req.params.pid, req.params.name, req.params.id);

      const record = updateRecord(db, req.params.name, req.params.id, body, reqCtx);
      if (!record) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record not found' } });
        return;
      }

      // M14: hapus file lama yang diganti (setelah UPDATE sukses)
      if (oldRecord) {
        await cleanupReplacedFiles(req.params.pid, meta, req.params.id, oldRecord, body);
      }

      // M13: broadcast ke realtime subscribers
      realtimeHub.publish(db, meta, 'update', record as Record<string, unknown>);
      // M28: webhook outbound (fire-and-forget, dengan previous)
      fireWebhooks(db, {
        projectId: req.params.pid,
        action: 'update',
        collection: req.params.name,
        record: record as Record<string, unknown>,
        previous: (oldRecord ?? null) as Record<string, unknown> | null,
      });
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
  router.delete('/api/p/:pid/collections/:name/records/:id', async (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const reqCtx = await resolveEndUserCtx(req, db, { pid: req.params.pid, write: true });
      const meta = getCollectionByName(db, req.params.name);

      // M38: snapshot record SEBELUM delete (untuk realtime/webhook/trigger payload)
      // Tanpa ini, SSE delete event hanya berisi {id} — subscriber yang
      // filter by userId tidak bisa match (userId tidak ada di payload).
      const snapshot = meta ? getRecord(db, req.params.name, req.params.id) : null;

      const ok = deleteRecord(db, req.params.name, req.params.id, reqCtx);
      if (!ok) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record not found' } });
        return;
      }
      // M14: hapus file fisik (setelah DB sukses)
      if (meta) {
        // M38: broadcast delete dengan FULL record snapshot (bukan hanya {id})
        // → subscriber bisa filter by userId, webhook punya context lengkap
        const deletePayload = (snapshot ?? { id: req.params.id }) as Record<string, unknown>;
        realtimeHub.publish(db, meta, 'delete', deletePayload);
        // M28: webhook outbound (dengan full snapshot)
        fireWebhooks(db, {
          projectId: req.params.pid,
          action: 'delete',
          collection: req.params.name,
          record: deletePayload,
        });
        // M15b: trigger delete (dengan full snapshot)
        fireTriggersSafe(db, req.params.name, 'delete', deletePayload);
        // record sudah terhapus — file cleanup by prefix
        await deleteRecordFiles(req.params.pid, req.params.id);
      }
      res.json({ success: true });
    } catch (err) {
      handleErrorPublic(res, err);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // POCKETBASE-PARITY: AUTH COLLECTION AUTHENTICATION
  // ═══════════════════════════════════════════════════════════════════════

  // POST /api/p/:pid/collections/:name/auth-with-password
  router.post('/api/p/:pid/collections/:name/auth-with-password', async (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      const meta = getCollectionByName(db, req.params.name);
      if (!meta) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Collection not found' } });
        return;
      }
      if (meta.type !== 'auth') {
        res.status(400).json({ error: { code: 'NOT_AUTH_COLLECTION', message: `Collection '${meta.name}' bukan bertipe auth` } });
        return;
      }

      const body = (req.body ?? {}) as { identity?: string; email?: string; password?: string };
      const identity = (body.identity || body.email || '').trim().toLowerCase();
      const password = body.password || '';

      if (!identity || !password) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Identity/email and password are required' } });
        return;
      }

      const row = db.prepare(`SELECT * FROM "${meta.name}" WHERE email = ?`).get(identity) as Record<string, unknown> | undefined;
      if (!row || typeof row.password_hash !== 'string' || !verifyPassword(password, row.password_hash)) {
        res.status(400).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' } });
        return;
      }

      initAuthTokensTable(db);
      const tokens = await issueTokens(db, {
        id: String(row.id),
        email: String(row.email),
        name: typeof row.name === 'string' ? row.name : null,
        avatarUrl: null,
        verified: row.verified === true || row.verified === 1,
        created: typeof row.created === 'string' ? row.created : '',
        updated: typeof row.updated === 'string' ? row.updated : '',
      });

      const record = getRecord(db, meta.name, String(row.id));
      res.json({
        token: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        record,
      });
    } catch (err) {
      handleErrorPublic(res, err);
    }
  });

  // POST /api/p/:pid/collections/:name/auth-refresh
    // M40: refreshToken dari BODY (paritas platform /auth/refresh). Bearer access
    // token masih-valid tetap diterima sebagai fallback (kompatibilitas lama —
    // client yang belum kirim body refreshToken tetap bisa refresh selama
    // access token belum expired; kalau dua-duanya ada, body MENANG).
    router.post('/api/p/:pid/collections/:name/auth-refresh', async (req, res) => {
      try {
        const db = getProjectDb(req.params.pid);
        const meta = getCollectionByName(db, req.params.name);
        if (!meta || meta.type !== 'auth') {
          res.status(400).json({ error: { code: 'NOT_AUTH_COLLECTION', message: 'Not an auth collection' } });
          return;
        }

        initAuthTokensTable(db);

        const body = (req.body ?? {}) as { refreshToken?: string };
        const userId = await refreshCollectionUserId(db, body.refreshToken);

        let userRow: {
          id: string; email: string; name: string | null;
          verified: number | 1 | boolean; created: string; updated: string;
        } | null = null;

        if (userId) {
          // Jalur 1 (M40): refresh token dari body — user dari DB collection
          const raw = db
            .prepare(`SELECT id, email, name, verified, created, updated FROM \"${meta.name}\" WHERE id = ?`)
            .get(userId) as Record<string, unknown> | undefined;
          if (raw) {
            userRow = {
              id: String(raw.id),
              email: String(raw.email ?? ''),
              name: typeof raw.name === 'string' ? raw.name : null,
              verified: raw.verified === true || raw.verified === 1,
              created: typeof raw.created === 'string' ? raw.created : '',
              updated: typeof raw.updated === 'string' ? raw.updated : '',
            };
          }
        } else if (req.headers.authorization?.startsWith('Bearer ')) {
        // Jalur 2 (fallback lama): access token masih valid
        const result = await verifyToken(req.headers.authorization.slice(7));
        if (result.valid && result.payload) {
          // ctx admin view — refresh adalah operasi auth, bukan akses data
          const record = getRecord(db, meta.name, String(result.payload.sub));
          if (record) {
              userRow = {
                id: String(record.id),
                email: String(record.email ?? ''),
                name: typeof record.name === 'string' ? record.name : null,
                verified: record.verified === true || record.verified === 1,
                created: typeof record.created === 'string' ? record.created : '',
                updated: typeof record.updated === 'string' ? record.updated : '',
              };
            }
          }
        }

        if (!userRow) {
          res.status(401).json({ error: { code: 'INVALID_REFRESH', message: 'Refresh token is invalid or expired' } });
          return;
        }

        const tokens = await issueTokens(db, {
          id: userRow.id,
          email: userRow.email,
          name: userRow.name,
          avatarUrl: null,
          verified: userRow.verified === true || userRow.verified === 1,
          created: userRow.created,
          updated: userRow.updated,
        });

        res.json({
          token: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          record: getRecord(db, meta.name, userRow.id),
        });
      } catch (err) {
        handleErrorPublic(res, err);
      }
    });

    // POST /api/p/:pid/collections/:name/auth-logout
    // M40: revoke refresh token collection-auth (paritas platform /auth/logout).
    router.post('/api/p/:pid/collections/:name/auth-logout', async (req, res) => {
      try {
        const db = getProjectDb(req.params.pid);
        const meta = getCollectionByName(db, req.params.name);
        if (!meta || meta.type !== 'auth') {
          res.status(400).json({ error: { code: 'NOT_AUTH_COLLECTION', message: 'Not an auth collection' } });
          return;
        }
        const body = (req.body ?? {}) as { refreshToken?: string };
        if (!body?.refreshToken) {
          res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'refreshToken is required' } });
          return;
        }
        initAuthTokensTable(db);
        revokeRefreshTokenByHash(db, body.refreshToken);
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
// M18b: verifyToken ASYNC (jose) — helper jadi async
// M26: API key (Bearer bf_... / X-API-Key) → service access:
//      - scope divalidasi (write untuk route mutasi)
//      - valid → undefined ctx (bypass rules, seperti admin)
//      - invalid → ApiKeyError (401/403/429) — dipetakan handleErrorPublic

async function resolveEndUserCtx(
  req: { headers: { authorization?: string; 'x-api-key'?: string } },
  db: DatabaseSync | null = null,
  opts: { write?: boolean; pid?: string } = {}
): Promise<RequestContext> {
  // M26: jalur API key (hanya jika route mengizinkan — db diteruskan)
  const apiKey = extractApiKey(req.headers as Record<string, unknown>);
  if (apiKey && db && opts.pid) {
    await resolveApiKey(db, apiKey, { write: opts.write, pid: opts.pid });
    return undefined as unknown as RequestContext; // service → bypass rules
  }

  const bearer = extractBearer(req.headers.authorization ?? null);
  if (bearer) {
    if (isAdminToken(bearer)) {
      return undefined as unknown as RequestContext; // admin → bypass (jangan dipakai)
    }
    const result = await verifyToken(bearer);
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

// ─── M40: helper auth-collection (refresh/logout via refresh token) ─────────

/**
 * Cari user_id milik refresh token collection-auth di _auth_tokens.
 * Mengembalikan null kalau token tidak ada / revoked / expired / user sudah
 * dihapus. Berbeda dari platform refreshAccessToken, di sini kita JOIN ke
 * tabel collection (bukan _auth_users) karena user hidup di situ.
 */
async function refreshCollectionUserId(
  db: DatabaseSync,
  refreshToken: string | undefined
): Promise<string | null> {
  if (!refreshToken) return null;
  const row = db
    .prepare(
      'SELECT user_id, expires_at, revoked FROM _auth_tokens WHERE token_hash = ?'
    )
    .get(hashToken(refreshToken)) as
    | { user_id: string; expires_at: string; revoked: number }
    | undefined;
  if (!row || row.revoked === 1) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row.user_id;
}

/** M40: revoke refresh token by nilai mentahnya (hash internal). */
function revokeRefreshTokenByHash(db: DatabaseSync, refreshToken: string): boolean {
  const result = db
    .prepare('UPDATE _auth_tokens SET revoked = 1 WHERE token_hash = ?')
    .run(hashToken(refreshToken));
  return result.changes > 0;
}
