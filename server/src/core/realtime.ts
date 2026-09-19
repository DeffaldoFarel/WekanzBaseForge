// ============================================================================
// M13: REALTIME HUB — pub/sub in-memory untuk SSE ala PocketBase
//
// Koneksi SSE = client yang MENUNGGU event. Hub menyimpan semua koneksi
// + subscription mereka. Saat CRUD terjadi (records.ts), API layer
// memanggil hub.publish() → hub menyaring subscriber berdasarkan rules
// + auth → kirim SSE event ke yang berhak.
//
// PENTING: rules dicek SAAT PUBLISH (bukan saat subscribe) — karena
// rules bisa berubah kapan pun (M11), dan auth koneksi bisa expire.
// ============================================================================

import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { CollectionMeta } from './schema.js';
import type { RequestContext } from './query/sqlBuilder.js';
import { decideRule } from './rules.js';
import { filterToSql } from './query/sqlBuilder.js';
import { DatabaseSync } from 'node:sqlite';

// ─── Tipe ────────────────────────────────────────────────────────────────────

export interface Subscription {
  id: string;
  collection: string;
  filter?: string; // filter M04 opsional — hanya record yang cocok
  recordId?: string; // Ops-6: topik "collection/<recordId>" — filter per record di server
}

export interface RealtimeClient {
  id: string;
  res: ServerResponse;
  auth: RequestContext | undefined; // undefined = admin; {auth:null} = anonymous
  subs: Map<string, Subscription>;
  connectedAt: number;
}

export type RealtimeAction = 'create' | 'update' | 'delete';

export interface RealtimeEvent {
  collection: string;
  action: RealtimeAction;
  record: Record<string, unknown>;
}

// ─── Hub (singleton) ─────────────────────────────────────────────────────────

class RealtimeHub {
  private clients = new Map<string, RealtimeClient>();

  // ── Connect: client SSE baru ──
  connect(res: ServerResponse, auth: RequestContext | undefined): RealtimeClient {
    const id = randomUUID().replace(/-/g, '').slice(0, 15);

    // SSE headers — INILAH yang membuat koneksi jadi "event stream"
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx: jangan buffer!
    });
    res.flushHeaders?.();

    const client: RealtimeClient = { id, res, auth, subs: new Map(), connectedAt: Date.now() };
    this.clients.set(id, client);

    // Kirim PB_CONNECT — client akan pakai id ini untuk subscribe
    this.send(client, 'PB_CONNECT', { clientId: id });

    // Ping tiap 30 detik agar proxy tidak memutus koneksi idle
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(ping);
      }
    }, 30_000);

    // Cleanup saat koneksi putus
    res.on('close', () => {
      clearInterval(ping);
      this.clients.delete(id);
    });

    return client;
  }

  getClient(id: string): RealtimeClient | undefined {
    return this.clients.get(id);
  }

  // ── Subscribe: client minta event dari collection ──
  subscribe(clientId: string, collection: string, filter?: string): string | null {
    const client = this.clients.get(clientId);
    if (!client) return null;

    const subId = randomUUID().replace(/-/g, '').slice(0, 12);
    client.subs.set(subId, { id: subId, collection, filter });
    this.send(client, 'PB_SUBSCRIBE', { tokenId: subId, collection });
    return subId;
  }

  // ── Unsubscribe ──
  unsubscribe(clientId: string, subId: string): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;
    return client.subs.delete(subId);
  }

  // ── Ops-6: upgrade auth koneksi SSE SETELAH connect ──
  // EventSource browser tidak bisa mengirim header — auth user datang
  // belakangan via POST sync/subscribe yang membawa Authorization.
  // clientId hanya diketahui pemilik koneksi (dikirim via stream SSE),
  // jadi upgrade tidak bisa disalahgunakan lintas klien.
  setClientAuth(clientId: string, auth: RequestContext | undefined): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;
    client.auth = auth;
    return true;
  }

  // ── Ops-6: bulk sync — GANTI seluruh subscription set (semantik PocketBase) ──
  // Dipanggil oleh POST /api/p/:pid/realtime ({clientId, subscriptions}).
  // Idempotent: state akhir = set yang dikirim, apa pun state sebelumnya.
  syncSubscriptions(
    clientId: string,
    subs: { collection: string; recordId?: string }[]
  ): { id: string; collection: string; recordId?: string }[] {
    const client = this.clients.get(clientId);
    if (!client) return [];

    client.subs.clear();
    const result: { id: string; collection: string; recordId?: string }[] = [];
    for (const s of subs) {
      const subId = randomUUID().replace(/-/g, '').slice(0, 12);
      const sub: Subscription = { id: subId, collection: s.collection };
      if (s.recordId) sub.recordId = s.recordId;
      client.subs.set(subId, sub);
      result.push(sub);
    }
    return result;
  }

  // ── Publish: broadcast ke subscriber yang BERHAK ──
  // dipanggil dari API layer SETELAH CRUD sukses (bukan di core — core
  // tidak tahu projectId; di sini kita butuh meta + db untuk cek rules)
  publish(
    db: DatabaseSync,
    meta: CollectionMeta,
    action: RealtimeAction,
    record: Record<string, unknown>
  ): void {
    if (this.clients.size === 0) return;

    const eventName = `PB_${action.toUpperCase()}`;
    let payload: string | null = null;

    for (const client of this.clients.values()) {
      for (const sub of client.subs.values()) {
        if (sub.collection !== meta.name) continue;

        // Ops-6: topik "collection/<recordId>" — filter per record di server
        if (sub.recordId && sub.recordId !== String(record.id ?? '')) continue;

        // ── Cek rules SAAT PUBLISH (listRule mengatur siapa boleh list) ──
        if (client.auth !== undefined) {
          // end user / anonymous — rules berlaku
          const lRule = meta.rules.listRule;
          if (lRule === null) continue; // admin-only → tidak boleh lihat
          if (lRule.trim() !== '') {
            const decided = decideRule(lRule, client.auth, meta.fields);
            if (decided.mode === 'filter' && decided.sql) {
              // record harus lolos rule: evaluasi via query kecil
              // (cara paling benar — reuses query engine, bukan evaluator baru)
              //
              // Ops-6: untuk DELETE, record SUDAH terhapus dari DB — SELECT
              // terhadap tabel pasti kosong. Cabang lama menggantikan
              // evaluasi dengan cek string `lRule.includes('@request.auth.id')`
              // → event delete (payload FULL record, M38) bocor ke SEMUA
              // subscriber termasuk anonymous & user lain. Sekarang rule
              // dievaluasi terhadap SNAPSHOT record in-memory
              // (recordMatchesInMemory) — engine SQL yang sama, tanpa
              // evaluator baru. Untuk create/update record masih ada di DB.
              const ok = action === 'delete'
                ? this.recordMatchesInMemory(db, meta, record, decided.sql, decided.params ?? [])
                : this.recordMatches(db, meta, record.id as string, decided.sql, decided.params ?? []);
              if (!ok) continue;
            }
            // mode 'public' → lolos
          }
        }
        // admin (auth undefined) → lolos semua

        // ── Cek filter subscriber (jika ada) ──
        // Ops-6: untuk delete, filter dievaluasi terhadap snapshot
        // in-memory (dulu di-skip utk delete — subscriber ber-filter bisa
        // menerima event record yang tidak cocok filter mereka sendiri).
        if (sub.filter && sub.filter.trim() !== '') {
          try {
            const { where, params } = filterToSql(sub.filter, meta.fields, client.auth);
            const ok = action === 'delete'
              ? this.recordMatchesInMemory(db, meta, record, where, params)
              : this.recordMatches(db, meta, record.id as string, where, params);
            if (!ok) continue;
          } catch {
            continue; // filter invalid → jangan kirim (aman)
          }
        }

        payload ??= JSON.stringify({ collection: meta.name, action, record });
        this.send(client, eventName, payload, true);
      }
    }
  }

  // Evaluasi SQL WHERE terhadap SATU record — reuse query engine!
  private recordMatches(
    db: DatabaseSync,
    meta: CollectionMeta,
    recordId: string,
    where: string,
    params: (string | number | boolean | null)[]
  ): boolean {
    try {
      const row = db
        .prepare(`SELECT id FROM "${meta.name}" WHERE id = ? AND (${where})`)
        .get(recordId, ...(params as never[])) as { id: string } | undefined;
      return !!row;
    } catch {
      return false; // field di filter hilang dsb — jangan kirim
    }
  }

  // ── Ops-6: proyeksi snapshot record → derived table SQL ──
  // Dipakai untuk mengevaluasi rule/filter saat record TIDAK ada lagi di
  // DB (delete). Kolom: id + created + updated + semua field skema.
  // Nilai object (json) di-stringify meniru bentuk TEXT tersimpan;
  // field hilang dari snapshot → NULL → klausa yang merujuknya false
  // (fail-safe). SQLite menerima `FROM (SELECT ? AS "a", ...) AS t`.
  private buildProjection(
    meta: CollectionMeta,
    record: Record<string, unknown>
  ): { sql: string; values: (string | number | boolean | null)[] } {
    const columns = ['id', 'created', 'updated', ...meta.fields.map((f) => f.name)];
    const parts: string[] = [];
    const values: (string | number | boolean | null)[] = [];
    for (const col of columns) {
      parts.push(`? AS "${col}"`);
      const v = record[col];
      if (v === null || v === undefined) values.push(null);
      else if (typeof v === 'object') values.push(JSON.stringify(v));
      else if (typeof v === 'boolean' || typeof v === 'number') values.push(v);
      else values.push(String(v));
    }
    return { sql: `SELECT ${parts.join(', ')}`, values };
  }

  // ── Ops-6: evaluasi WHERE terhadap snapshot record IN-MEMORY ──
  // Record sudah terhapus → SELECT terhadap tabel kosong; proyeksi ke
  // derived table membuat rule tetap bisa dievaluasi dengan engine SQL
  // yang sama. Params: nilai proyeksi DULU (muncul lebih dulu di SQL),
  // lalu params klausa WHERE.
  private recordMatchesInMemory(
    db: DatabaseSync,
    meta: CollectionMeta,
    record: Record<string, unknown>,
    where: string,
    params: (string | number | boolean | null)[]
  ): boolean {
    try {
      const proj = this.buildProjection(meta, record);
      const row = db
        .prepare(`SELECT 1 WHERE EXISTS (SELECT 1 FROM (${proj.sql}) AS t WHERE (${where}))`)
        .get(...(proj.values as never[]), ...(params as never[]));
      return row !== undefined;
    } catch {
      return false; // field di rule tidak terproyeksi dsb — jangan kirim (aman)
    }
  }

  // ── Kirim SSE. parsed=true berarti payload sudah JSON string ──
  private send(client: RealtimeClient, event: string, data: unknown, parsed = false): void {
    try {
      const body = parsed ? (data as string) : JSON.stringify(data);
      client.res.write(`event: ${event}\ndata: ${body}\n\n`);
    } catch {
      // koneksi mati — close handler akan membersihkan
    }
  }

  // ── Stats (untuk admin/debug) ──
  stats(): { clients: number; subscriptions: number } {
    let subs = 0;
    for (const c of this.clients.values()) subs += c.subs.size;
    return { clients: this.clients.size, subscriptions: subs };
  }
}

// Singleton — realtime state hidup di proses server
export const realtimeHub = new RealtimeHub();
