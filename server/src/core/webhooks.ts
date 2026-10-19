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
import net from 'node:net';
import dns from 'node:dns/promises';
import { DatabaseSync } from 'node:sqlite';
import { generateId } from './router.js';
import { isPrivateIp } from './httpSandbox.js'; // AUD-5-02: deteksi IP privat lengkap (incl. IPv6 hex-mapped)

// ─── AUD-5-02: guard SSRF webhook ────────────────────────────────────────────
// Guard lama hanya ada di create, hanya cek literal hostname (bentuk [::1]
// lolos), dan default mengizinkan target privat. Kini:
//   - SATU helper dipanggil di create DAN update (update dulu tanpa cek).
//   - Default TIDAK mengizinkan target privat; hanya test environment
//     (node --test) yang diizinkan — 127.0.0.1 adalah kasus test utama.
//     WEBHOOK_ALLOW_PRIVATE=true|false meng-override apa pun (dev eksplisit).
//   - Delivery mengecek ulang target (DNS bisa berubah sejak create) dan
//     TIDAK mengikuti redirect (public URL yang 302 ke internal = SSRF).

function webhookAllowPrivate(): boolean {
  const raw = process.env.WEBHOOK_ALLOW_PRIVATE;
  if (raw !== undefined) return raw === 'true';
  // AUD-1-11 lesson: NODE_ENV=production selalu menang atas flag test.
  if (process.env.NODE_ENV === 'production') return false;
  return Boolean(process.env.NODE_TEST_CONTEXT) || process.argv.includes('--test');
}

function hostnameOf(rawUrl: string): string {
  // URL.hostname menyertakan kurung untuk IPv6 — buang agar isPrivateIp benar.
  return new URL(rawUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

function assertWebhookUrlAllowed(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid webhook URL: '${rawUrl}'`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Webhook URL must be http:// or https://');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const privateHost =
    host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') ||
    (net.isIP(host) > 0 && isPrivateIp(host)); // mencakup ::1, ::ffff:7f00:1, dsb.
  if (privateHost && !webhookAllowPrivate()) {
    throw new Error(
      `Webhook URL host '${host}' is a private/loopback address (set WEBHOOK_ALLOW_PRIVATE=true to allow internal targets in development)`
    );
  }
}

/**
 * AUD-5-02: cek ulang tujuan SAAT DELIVERY — DNS bisa berubah sejak create
 * (rebinding: nama publik resolve ke IP privat), dan hostname bentuk non-
 * literal baru ketahuan di sini. Literal privat hanya lolos bila
 * WEBHOOK_ALLOW_PRIVATE=true.
 */
async function assertDeliveryTargetAllowed(rawUrl: string): Promise<void> {
  const host = hostnameOf(rawUrl);
  const allowPrivate = webhookAllowPrivate();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    if (!allowPrivate) throw new Error(`webhook target '${host}' is private (blocked at delivery)`);
    return;
  }
  if (net.isIP(host) > 0) {
    if (isPrivateIp(host) && !allowPrivate) throw new Error(`webhook target '${host}' is a private address (blocked at delivery)`);
    return;
  }
  const records = await dns.lookup(host, { all: true });
  for (const r of records) {
    if (isPrivateIp(r.address) && !allowPrivate) {
      throw new Error(`webhook target '${host}' resolves to private IP ${r.address} (blocked at delivery)`);
    }
  }
}

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

  // AUD-5-02: guard tunggal (protokol + host privat) — dipakai create & update.
  assertWebhookUrlAllowed(def.url.trim());

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
    // AUD-5-02: update dulu TANPA guard SSRF — PATCH ke 127.0.0.1 diterima
    // (probe) padahal create diblokir. Guard yang sama untuk kedua pintu.
    assertWebhookUrlAllowed(updates.url.trim());
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
    // AUD-5-02: cek tujuan ulang SEBELUM fetch — DNS bisa berubah sejak create
    // (nama publik resolve ke IP privat). Target yang diblokir = kegagalan
    // permanen (bukan transient) → catat & berhenti tanpa retry.
    try {
      await assertDeliveryTargetAllowed(hook.url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordDelivery(db, {
        webhookId: hook.id,
        event,
        statusCode: null,
        ok: false,
        attempt,
        error: message,
        durationMs: Date.now() - started,
        deliveredAt: new Date().toISOString(),
      });
      console.error(`[webhook:${hook.name}] ${event} → ${message} (blocked at delivery)`);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

    try {
      // AUD-5-02: redirect TIDAK diikuti — tujuan redirect tidak divalidasi
      // guard; public URL yang 302 ke endpoint internal adalah SSRF klasik.
      // 3xx dicatat sebagai kegagalan HTTP (penerima webhook harus memakai
      // URL final yang teregistrasi, bukan chain).
      const res = await fetch(hook.url, {
        method: 'POST',
        redirect: 'manual',
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
