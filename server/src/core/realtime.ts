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
import { isPrivateIp } from './httpSandbox.js'; // AUD-5-03: deteksi IP proxy
import { DatabaseSync } from 'node:sqlite';

// ─── Batas (AUD-5-01/03/04) ─────────────────────────────────────────────────

/** AUD-5-04: jumlah subscription maksimum per koneksi — berlaku untuk SEMUA
 *  jalur (bulk sync MAUPUN subscribe inkremental; dulu hanya sync yang dibatasi
 *  sehingga 120 POST subscribe menghasilkan 120 subscription). */
export const MAX_REALTIME_SUBSCRIPTIONS = 100;

/** AUD-5-01: plafon byte yang boleh menumpuk di buffer tulis satu koneksi.
 *  Subscriber yang tidak membaca (jaringan lambat / pause malicious) membuat
 *  buffer tumbuh tanpa batas kalau return res.write() diabaikan (probe:
 *  805 KB dari 100 event kecil saja). Melewati plafon = koneksi DIPUTUS —
 *  pola PocketBase: satu subscriber mati lebih aman daripada OOM server. */
// AUD-5-01: plafon antrean tulis per koneksi SSE — subscriber yang tidak
// membaca diputus sebelum buffer membesar. Default 5 MB; env
// MAX_SSE_BUFFERED_BYTES menimpa. DIBACA LIVE per pengecekan (bukan sekali
// saat import) supaya test bisa menyetel nilai kecil dan deterministik
// lintas platform: buffer kernel Linux autotune bisa menelan ~10 MB
// sebelum antrean userspace membesar, Windows jauh lebih dini — dengan
// threshold test 64 KB kedua platform memicu destroy sama cepat.
function maxBufferedBytes(): number {
  const raw = parseInt(process.env.MAX_SSE_BUFFERED_BYTES ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 1024 * 1024;
}

/** AUD-5-03: limit koneksi — env-override untuk operator (dibaca per connect). */
function envLimit(name: string, def: number): number {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

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
  /** Project scope of the connection — events from other projects never reach this client. */
  projectId: string;
  /** AUD-5-03: IP asal koneksi (untuk limit per-IP; IP privat = skenario proxy). */
  ip?: string;
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
  // projectId WAJIB: koneksi hanya boleh menerima event dari project-nya
  // sendiri. Tanpa ini, client dari project X bisa menerima event project Y
  // (temuan audit: hub lama broadcast ke SEMUA client tanpa scope project).
  //
  // AUD-5-03: return null = koneksi DITOLAK (limit terlampaui) — route wajib
  // menjawab 429. Sebelumnya tidak ada limit sama sekali: 60 koneksi anonim
  // berurutan diterima semua (probe) → fd & memory exhaustion.
  // Per-IP hanya dihitung untuk IP PUBLIK: di belakang reverse proxy tanpa
  // TRUST_PROXY semua koneksi tampak berasal dari IP privat proxy tunggal —
  // membatasinya = memutus seluruh produksi. Per-project & global tetap
  // melindungi skenario itu.
  connect(res: ServerResponse, auth: RequestContext | undefined, projectId: string, ip?: string): RealtimeClient | null {
    const maxGlobal = envLimit('REALTIME_MAX_CONN_GLOBAL', 1000);
    if (this.clients.size >= maxGlobal) return null;

    const maxProject = envLimit('REALTIME_MAX_CONN_PER_PROJECT', 200);
    let projectCount = 0;
    for (const c of this.clients.values()) {
      if (c.projectId === projectId) projectCount++;
    }
    if (projectCount >= maxProject) return null;

    if (ip) {
      const maxIp = envLimit('REALTIME_MAX_CONN_PER_IP', 10);
      let isPublicIp = true;
      try {
        isPublicIp = !isPrivateIp(ip.replace(/^\[|\]$/g, ''));
      } catch {
        isPublicIp = true; // IP aneh → perlakukan publik (batasi)
      }
      if (isPublicIp) {
        let ipCount = 0;
        for (const c of this.clients.values()) {
          if (c.ip === ip) ipCount++;
        }
        if (ipCount >= maxIp) return null;
      }
    }

    const id = randomUUID().replace(/-/g, '').slice(0, 15);

    // SSE headers — INILAH yang membuat koneksi jadi "event stream"
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx: jangan buffer!
    });
    res.flushHeaders?.();

    const client: RealtimeClient = { id, res, auth, projectId, ip, subs: new Map(), connectedAt: Date.now() };
    this.clients.set(id, client);

    // Kirim PB_CONNECT — client akan pakai id ini untuk subscribe
    this.send(client, 'PB_CONNECT', { clientId: id });

    // Ping tiap 30 detik agar proxy tidak memutus koneksi idle.
    // AUD-5-01: ping pun menulis tanpa cek dulu — subscriber yang tidak pernah
    // membaca tetap menumpuk buffer pelan-pelan; cek plafon juga di sini.
    const ping = setInterval(() => {
      try {
        if (res.writableLength > maxBufferedBytes()) {
          res.destroy();
          clearInterval(ping);
          return;
        }
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

  // Audit F-05: clientId hanya boleh dioperasikan lewat route project yang
  // SAMA dengan koneksi aslinya. Tanpa cek ini, POST /realtime project B
  // bisa meng-upgrade auth koneksi milik project A (client ID diketahui/
  // bocor) — koneksi A lalu dievaluasi rules dengan subject project B.
  getClientForProject(id: string, projectId: string): RealtimeClient | undefined {
    const client = this.clients.get(id);
    if (!client || client.projectId !== projectId) return undefined;
    return client;
  }

  // ── Subscribe: client minta event dari collection ──
  subscribe(clientId: string, collection: string, filter?: string): string | null {
    const client = this.clients.get(clientId);
    if (!client) return null;

    // AUD-5-04: cap TOTAL subscription per koneksi — bulk sync sudah dibatasi
    // route (MAX_TOPICS), tapi subscribe inkremental TIDAK: 120 POST berturut
    // menghasilkan 120 subscription → biaya publish O(subs) membesar tanpa batas.
    if (client.subs.size >= MAX_REALTIME_SUBSCRIPTIONS) return null;

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
  // Audit F-05: expectedProjectId WAJIB — auth hanya boleh di-upgrade oleh
  // route project yang sama dengan koneksi; mismatch = tolak.
  setClientAuth(
    clientId: string,
    auth: RequestContext | undefined,
    expectedProjectId?: string
  ): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;
    if (expectedProjectId !== undefined && client.projectId !== expectedProjectId) return false;
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
  // tidak tahu projectId; di sini kita butuh meta + db untuk cek rules).
  // projectId WAJIB: event hanya dikirim ke client yang terhubung melalui
  // project yang sama — client project lain di-proses ini di-skip total.
  publish(
    db: DatabaseSync,
    meta: CollectionMeta,
    action: RealtimeAction,
    record: Record<string, unknown>,
    projectId: string
  ): void {
    if (this.clients.size === 0) return;

    const eventName = `PB_${action.toUpperCase()}`;
    let payload: string | null = null;

    for (const client of this.clients.values()) {
      // Project scope — koneksi project lain tidak berhak atas event ini.
      if (client.projectId !== projectId) continue;

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
  // AUD-5-01: return res.write() TIDAK diabaikan lagi. write() mengembalikan
  // false saat buffer internal penuh; data yang terus ditulis ke subscriber
  // yang tidak membaca menumpuk TANPA BATAS (probe: 805 KB dari 100 event).
  // Melewati plafon buffer = koneksi stalled → PUTUSKAN; close handler
  // membersihkan state. (Tidak hanya men-skip event: buffer lama tetap
  // menempati memori — putus adalah satu-satunya pemulihan.)
  private send(client: RealtimeClient, event: string, data: unknown, parsed = false): void {
    try {
      const body = parsed ? (data as string) : JSON.stringify(data);
      client.res.write(`event: ${event}\ndata: ${body}\n\n`);
      if (client.res.writableLength > maxBufferedBytes()) {
        client.res.destroy();
      }
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

  // ── Audit AUD-0-01: stats project-scoped ──
  // Route debug stats kini admin-only — dan TANPA scope ini angka yang
  // dikembalikan tetap GLOBAL (semua client lintas project). Operator
  // project A tidak seharusnya melihat jumlah koneksi project B.
  statsForProject(projectId: string): { clients: number; subscriptions: number } {
    let clients = 0;
    let subs = 0;
    for (const c of this.clients.values()) {
      if (c.projectId !== projectId) continue;
      clients++;
      subs += c.subs.size;
    }
    return { clients, subscriptions: subs };
  }
}

// Singleton — realtime state hidup di proses server
export const realtimeHub = new RealtimeHub();
