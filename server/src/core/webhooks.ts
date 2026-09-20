// ============================================================================
// M28: WEBHOOKS — outbound HTTP POST saat CRUD + HMAC signature + retry
//
// Komplementer M15b (function triggers):
//   - Function trigger = kode BERJAL di server BaseForge
//   - Webhook         = BaseForge MEMANGGIL server Anda
//
// Payload (JSON, ala PocketBase/Stripe):
//   {
//     event:      'posts.create',
//     action:     'create' | 'update' | 'delete',
//     collection: 'posts',
//     record:     { ... },
//     previous:   { ... } | null,   // utk update: data sebelum
//     timestamp:  'ISO-8601'
//   }
//
// Keamanan (ala Stripe/GitHub):
//   - X-BaseForge-Event:   nama event
//   - X-BaseForge-Signature: sha256=<hex HMAC-SHA256(body, secret)>
//   → penerima memverifikasi: crypto.timingSafeEqual(HMAC(body), signature)
//
// Delivery:
//   - timeout 10s per attempt (AbortController)
//   - retry: 3x dengan exponential backoff (1s, 4s, 16s) saat non-2xx
//   - delivery log tersimpan di _webhook_deliveries (100 terakhir per hook)
//   - fire-and-forget: CRUD asli tidak pernah tergagalkan oleh webhook
// ============================================================================

import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { generateId } from './router.js';

export interface WebhookDef {
  id: string;
  name: string;
  url: string;
  secret: string; // untuk HMAC — plaintext disimpan (perlu dipakai lagi)
  events: string[]; // ['posts.create', 'posts.update', '*', 'posts.*']
  enabled: boolean;
  created: string;
  updated: string;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: string;
  statusCode: number | null;
  ok: boolean;
  attempt: number;
  error: string | null;
  durationMs: number;
  deliveredAt: string;
}

// ─── Tabel ────────────────────────────────────────────────────────────────────

export function initWebhooksTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _webhooks (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      url       TEXT NOT NULL,
      secret    TEXT NOT NULL,
      events    TEXT NOT NULL DEFAULT '[]',
      enabled   INTEGER NOT NULL DEFAULT 1,
      created   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS _webhook_deliveries (
      id           TEXT PRIMARY KEY,
      webhook_id   TEXT NOT NULL,
      event        TEXT NOT NULL,
      status_code  INTEGER,
      ok           INTEGER NOT NULL DEFAULT 0,
      attempt      INTEGER NOT NULL DEFAULT 1,
      error        TEXT,
      duration_ms  INTEGER NOT NULL DEFAULT 0,
      delivered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
}

interface WebhookRow {
  id: string; name: string; url: string; secret: string;
  events: string; enabled: number; created: string; updated: string;
}

function rowToWebhook(row: WebhookRow): WebhookDef {
  let events: string[] = [];
  try {
    const parsed = JSON.parse(row.events);
    if (Array.isArray(parsed)) events = parsed;
  } catch { /* biarkan kosong */ }
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    secret: row.secret,
    events,
    enabled: row.enabled === 1,
    created: row.created,
    updated: row.updated,
  };
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export function createWebhook(
  db: DatabaseSync,
  def: { name: string; url: string; secret?: string; events?: string[]; enabled?: boolean }
): WebhookDef {
  initWebhooksTable(db);
  if (!def.name?.trim()) throw new Error('Webhook name is required');
  if (!def.url?.trim()) throw new Error('Webhook URL is required');

  let url: URL;
  try {
    url = new URL(def.url);
  } catch {
    throw new Error(`Invalid webhook URL: '${def.url}'`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Webhook URL must be http:// or https://');
  }

  // SSRF guard: host privat tidak boleh jadi tujuan webhook (data exfil ke
  // dalam network tidak masalah — justru berbahaya: SSRF dari webhook admin)
  const host = url.hostname;
  if (
    host === 'localhost' || host.endsWith('.localhost') ||
    host === '169.254.169.254' || // metadata cloud
    /^127\./.test(host) || /^10\./.test(host) ||
    /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    // IZINKAN eksplisit untuk development/test (127.0.0.1 adalah kasus test
    // utama). Produksi bisa menonaktifkan via env WEBHOOK_ALLOW_PRIVATE=false
    if ((process.env.WEBHOOK_ALLOW_PRIVATE ?? 'true') !== 'true') {
      throw new Error(`Webhook URL host '${host}' is a private/loopback address (blocked in production mode)`);
    }
  }

  const secret = def.secret?.trim() || `whsec_${crypto.randomBytes(24).toString('hex')}`;
  const events = validateEvents(def.events ?? ['*']);
  const id = generateId();

  db.prepare(
    `INSERT INTO _webhooks (id, name, url, secret, events, enabled) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, def.name.trim(), def.url.trim(), secret, JSON.stringify(events), def.enabled === false ? 0 : 1);

  return getWebhookById(db, id)!;
}

function validateEvents(events: string[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (typeof e !== 'string' || e.trim() === '') continue;
    const clean = e.trim().toLowerCase();
    // format: '*' | 'collection.action' | 'collection.*'
    if (!/^(\*|[a-z][a-z0-9_]*\.(\*|create|update|delete))$/.test(clean)) {
      throw new Error(`Invalid webhook event: '${clean}' (expected 'collection.action', 'collection.*', or '*')`);
    }
    if (!out.includes(clean)) out.push(clean);
  }
  if (out.length === 0) throw new Error('Webhook must listen to at least 1 event');
  return out;
}

export function getWebhookById(db: DatabaseSync, id: string): WebhookDef | undefined {
  initWebhooksTable(db);
  const row = db.prepare('SELECT * FROM _webhooks WHERE id = ?').get(id) as unknown as WebhookRow | undefined;
  return row ? rowToWebhook(row) : undefined;
}

export function listWebhooks(db: DatabaseSync): WebhookDef[] {
  initWebhooksTable(db);
  const rows = db.prepare('SELECT * FROM _webhooks ORDER BY created DESC').all() as unknown as WebhookRow[];
  return rows.map(rowToWebhook);
}

export function updateWebhook(
  db: DatabaseSync,
  id: string,
  updates: { name?: string; url?: string; events?: string[]; enabled?: boolean }
): WebhookDef | undefined {
  const existing = getWebhookById(db, id);
  if (!existing) return undefined;

  if (updates.url !== undefined) {
    let url: URL;
    try { url = new URL(updates.url); } catch {
      throw new Error(`Invalid webhook URL: '${updates.url}'`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Webhook URL must be http:// or https://');
    }
  }

  const events = updates.events !== undefined ? JSON.stringify(validateEvents(updates.events)) : null;

  db.prepare(
    `UPDATE _webhooks SET
       name = COALESCE(?, name),
       url = COALESCE(?, url),
       events = COALESCE(?, events),
       enabled = COALESCE(?, enabled),
       updated = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`
  ).run(
    updates.name ?? null,
    updates.url ?? null,
    events,
    updates.enabled === undefined ? null : updates.enabled ? 1 : 0,
    id
  );
  return getWebhookById(db, id);
}

export function deleteWebhook(db: DatabaseSync, id: string): boolean {
  initWebhooksTable(db);
  const result = db.prepare('DELETE FROM _webhooks WHERE id = ?').run(id);
  return result.changes > 0;
}

export function listDeliveries(db: DatabaseSync, webhookId: string, limit = 20): WebhookDelivery[] {
  initWebhooksTable(db);
  const rows = db
    .prepare(
      `SELECT * FROM _webhook_deliveries WHERE webhook_id = ?
       ORDER BY delivered_at DESC, rowid DESC LIMIT ?`
    )
    .all(webhookId, limit) as unknown as DeliveryRow[];
  return rows.map(rowToDelivery);
}

interface DeliveryRow {
  id: string;
  webhook_id: string;
  event: string;
  status_code: number | null;
  ok: number;
  attempt: number;
  error: string | null;
  duration_ms: number;
  delivered_at: string;
}

function rowToDelivery(row: DeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    event: row.event,
    statusCode: row.status_code,
    ok: row.ok === 1,
    attempt: row.attempt,
    error: row.error,
    durationMs: row.duration_ms,
    deliveredAt: row.delivered_at,
  };
}

function recordDelivery(db: DatabaseSync, d: Omit<WebhookDelivery, 'id'>): void {
  try {
    db.prepare(
      `INSERT INTO _webhook_deliveries (id, webhook_id, event, status_code, ok, attempt, error, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(generateId(), d.webhookId, d.event, d.statusCode, d.ok ? 1 : 0, d.attempt, d.error, d.durationMs);

    // Retensi: 100 delivery terakhir per webhook
    db.prepare(
      `DELETE FROM _webhook_deliveries WHERE webhook_id = ? AND id NOT IN (
         SELECT id FROM _webhook_deliveries WHERE webhook_id = ?
         ORDER BY delivered_at DESC, rowid DESC LIMIT 100
       )`
    ).run(d.webhookId, d.webhookId);
  } catch (err) {
    console.error('[webhook] failed to record delivery:', err);
  }
}

// ─── Event matching ───────────────────────────────────────────────────────────

export function webhookMatches(hook: WebhookDef, collection: string, action: string): boolean {
  const event = `${collection}.${action}`;
  return hook.events.some((e) => {
    if (e === '*') return true;
    if (e === event) return true;
    if (e.endsWith('.*')) return e.slice(0, -2) === collection;
    return false;
  });
}

// ─── HMAC signature ───────────────────────────────────────────────────────────

export function signPayload(body: string, secret: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

// ─── Delivery engine (fire-and-forget + retry + backoff) ──────────────────────

const WEBHOOK_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000; // 1s, 4s, 16s (exponential ×4)

export interface FireWebhookOptions {
  projectId: string;
  action: 'create' | 'update' | 'delete';
  collection: string;
  record: Record<string, unknown>;
  previous?: Record<string, unknown> | null;
}

/** Dipanggil dari triggerExecutor / API layer — ASYNC fire-and-forget. */
export function fireWebhooks(db: DatabaseSync, opts: FireWebhookOptions): void {
  let hooks: WebhookDef[];
  try {
    hooks = listWebhooks(db);
  } catch {
    return; // tabel belum ada — jangan ganggu operasi utama
  }

  const matching = hooks.filter((h) => h.enabled && webhookMatches(h, opts.collection, opts.action));
  if (matching.length === 0) return;

  const payload = JSON.stringify({
    event: `${opts.collection}.${opts.action}`,
    action: opts.action,
    collection: opts.collection,
    record: opts.record,
    previous: opts.previous ?? null,
    timestamp: new Date().toISOString(),
  });

  for (const hook of matching) {
    void deliverWithRetry(db, hook, payload);
  }
}

async function deliverWithRetry(db: DatabaseSync, hook: WebhookDef, payload: string): Promise<void> {
  const event = (JSON.parse(payload) as { event: string }).event;
  const started = Date.now();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

    try {
      const res = await fetch(hook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'BaseForge-Webhook/1.0',
          'X-BaseForge-Event': event,
          'X-BaseForge-Signature': signPayload(payload, hook.secret),
        },
        body: payload,
        signal: controller.signal,
      });
      clearTimeout(timer);

      const ok = res.status >= 200 && res.status < 300;
      const duration = Date.now() - started;
      recordDelivery(db, {
        webhookId: hook.id,
        event,
        statusCode: res.status,
        ok,
        attempt,
        error: ok ? null : `HTTP ${res.status}`,
        durationMs: duration,
        deliveredAt: new Date().toISOString(),
      });

      if (ok) {
        console.log(`[webhook:${hook.name}] ${event} delivered (${res.status}, attempt ${attempt}, ${duration}ms)`);
        return; // sukses — selesai
      }

      // Non-2xx: retry jika masih ada attempt
      console.error(`[webhook:${hook.name}] ${event} → HTTP ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS})`);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(BACKOFF_BASE_MS * 4 ** (attempt - 1));
      }
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const message = isAbort
        ? `timeout after ${WEBHOOK_TIMEOUT_MS}ms`
        : err instanceof Error ? err.message : String(err);
      const duration = Date.now() - started;

      recordDelivery(db, {
        webhookId: hook.id,
        event,
        statusCode: null,
        ok: false,
        attempt,
        error: message,
        durationMs: duration,
        deliveredAt: new Date().toISOString(),
      });
      console.error(`[webhook:${hook.name}] ${event} → ${message} (attempt ${attempt}/${MAX_ATTEMPTS})`);

      if (attempt < MAX_ATTEMPTS) {
        await sleep(BACKOFF_BASE_MS * 4 ** (attempt - 1));
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
