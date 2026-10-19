// ============================================================================
// M41: DB SANDBOX — akses database in-process untuk function ($db)
//
// Mengapa modul ini ada: isolate V8 (M18a) sengaja tanpa akses host. M25 membuka
// jaringan via $http dengan gerbang tunggal `sandboxedHttpSend`. M41 membuka
// DATABASE dengan pola yang sama persis — SATU gerbang, semua guard di sini,
// tidak ada guard di kode user dan tidak ada di functionRunner.
//
// Keunggulan struktural: server + SQLite + runtime function ada dalam SATU
// proses. Supabase Edge Function harus memperlakukan Postgres sebagai layanan
// remote ter-pool; Appwrite Function harus HTTP ke API. Di sini panggilan
// langsung ke records.ts — nol latensi jaringan, nol kredensial.
//
// EMPAT GERBANG:
//   1. OPT-IN      — function harus punya dbAccess=true (kolom db_access).
//                    Default off: function lama tidak berubah perilaku.
//   2. ANTI-REKURSI— tulis via $db pada depth>=1 TIDAK memicu trigger, supaya
//                    trigger→function→tulis→trigger tidak tak hingga.
//                    REALTIME TIDAK ikut ditekan: SSE hanya mengirim event ke
//                    subscriber (tidak mengeksekusi kode), jadi broadcast
//                    tulisan function tidak bisa membentuk loop — subscriber
//                    realtime tetap melihat field turunan (streak, agregat)
//                    tanpa refresh (perbaikan 2026-10-19).
//   3. BUDGET      — maksimum N panggilan per eksekusi (proses tunggal: satu
//                    function tidak boleh memonopoli event loop).
//   4. SISTEM      — collection berawalan '_' (_auth_users, _functions, ...)
//                    ditolak; $db hanya untuk collection data.
//
// IDENTITAS: $db memanggil records.ts TANPA reqCtx. Konvensi repo: undefined =
// admin = BYPASS API RULES. Ini DISENGAJA — function adalah kode tepercaya milik
// pemilik project dan justru tugasnya menulis field yang rules larang ditulis
// client (agregat backend-managed). Kode di dalam function TIDAK dibatasi rules.
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import {
  createRecord,
  getRecord,
  updateRecord,
  deleteRecord,
  listRecords,
} from './records.js';

/** Operasi yang diizinkan lewat $db. */
export type DbOp = 'list' | 'get' | 'create' | 'update' | 'delete';

const ALLOWED_OPS = new Set<DbOp>(['list', 'get', 'create', 'update', 'delete']);
const WRITE_OPS = new Set<DbOp>(['create', 'update', 'delete']);

/** Default budget panggilan $db per eksekusi function. */
export const DEFAULT_MAX_DB_CALLS = 200;

/** perPage maksimum yang boleh diminta lewat $db (sejajar records.ts:817). */
const MAX_PER_PAGE = 500;

export interface DbCallOptions {
  op: DbOp;
  collection: string;
  id?: string;
  data?: Record<string, unknown>;
  /** list: filter M04, sort, page, perPage, expand */
  filter?: string;
  sort?: string;
  page?: number;
  perPage?: number;
  expand?: string;
}

export interface DbSandboxContext {
  db: DatabaseSync;
  /** Gerbang 1: function ini diizinkan pakai $db? */
  dbAccess: boolean;
  /** Gerbang 2: kedalaman eksekusi (0 = dipanggil langsung/HTTP/cron). */
  depth: number;
  /** Gerbang 3: penghitung mutable — dibagi satu eksekusi function. */
  callCounter: { count: number };
  maxDbCalls: number;
  /**
   * Dipanggil SETELAH tulis sukses, HANYA jika trigger tidak ditekan.
   * functionRunner menyuntikkan ini agar dbSandbox tidak bergantung pada
   * triggerExecutor (menghindari import melingkar).
   */
  onWrite?: (
    action: 'create' | 'update' | 'delete',
    collection: string,
    record: Record<string, unknown>,
    previous: Record<string, unknown> | null
  ) => void;
  /**
   * M13-fix: dipanggil SETELAH tulis sukses pada SEMUA depth (tidak
   * digerbang anti-rekursi). Realtime hanya mengirim event SSE — tidak
   * mengeksekusi kode subscriber — jadi tidak ada risiko loop. Dipisah
   * dari onWrite supaya tulisan $db dari function hasil trigger
   * (depth>=1, trigger ditekan) tetap ter-broadcast ke subscriber SSE.
   * Urutan panggil: realtime DULU, lalu trigger (pola M13 API layer).
   */
  onRealtimeWrite?: (
    action: 'create' | 'update' | 'delete',
    collection: string,
    record: Record<string, unknown>
  ) => void;
}

/** Error yang pesannya aman untuk ditampilkan ke kode user di dalam isolate. */
export class DbSandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbSandboxError';
  }
}

function block(reason: string): never {
  throw new DbSandboxError(`$db blocked: ${reason}`);
}

// ─── Validasi nama collection ────────────────────────────────────────────────

/**
 * Gerbang 4: collection sistem tidak boleh disentuh $db. Tabel meta BaseForge
 * berawalan '_' (_collections, _functions, _auth_users, _auth_tokens, ...);
 * menulisnya dari sandbox = eskalasi privilese (mis. membuat admin baru).
 */
export function assertCollectionAllowed(collection: string): void {
  if (typeof collection !== 'string' || collection.trim() === '') {
    block('collection name is required');
  }
  if (collection.startsWith('_')) {
    block(`'${collection}' is a system collection and cannot be accessed from a function`);
  }
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(collection)) {
    block(`invalid collection name '${collection}'`);
  }
}

// ─── Gerbang tunggal ─────────────────────────────────────────────────────────

/**
 * Satu-satunya jalan $db → database. Dipanggil functionRunner lewat
 * ivm.Reference; opts sudah di-parse dari JSON string milik guest.
 */
export async function sandboxedDbCall(
  opts: DbCallOptions,
  ctx: DbSandboxContext
): Promise<unknown> {
  // ── Gerbang 1: opt-in ──
  if (!ctx.dbAccess) {
    throw new DbSandboxError(
      '$db is not enabled for this function — set dbAccess to true on the function'
    );
  }

  // ── Validasi bentuk opts ──
  if (!opts || typeof opts !== 'object') {
    block('expected an options object');
  }
  const op = opts.op;
  if (!ALLOWED_OPS.has(op)) {
    block(`unknown operation '${String(op)}' (use ${[...ALLOWED_OPS].join('/')})`);
  }
  assertCollectionAllowed(opts.collection);

  // ── Gerbang 3: budget panggilan ──
  ctx.callCounter.count++;
  if (ctx.callCounter.count > ctx.maxDbCalls) {
    block(`exceeded the ${ctx.maxDbCalls} $db calls budget for one execution`);
  }

  // ── Gerbang 2: tulis pada depth>=1 tidak memicu trigger ──
  const suppressTriggers = ctx.depth >= 1;

  switch (op) {
    case 'list': {
      const perPage = Math.min(
        MAX_PER_PAGE,
        Math.max(1, typeof opts.perPage === 'number' ? opts.perPage : 20)
      );
      const page = Math.max(1, typeof opts.page === 'number' ? opts.page : 1);
      return listRecords(ctx.db, opts.collection, {
        page,
        perPage,
        filter: opts.filter,
        sort: opts.sort,
        expand: opts.expand,
      });
    }

    case 'get': {
      if (typeof opts.id !== 'string' || opts.id === '') block('get requires an id');
      // reqCtx undefined = admin (lihat catatan IDENTITAS di header)
      return getRecord(ctx.db, opts.collection, opts.id, undefined, {
        expand: opts.expand,
      });
    }

    case 'create': {
      if (!opts.data || typeof opts.data !== 'object') block('create requires a data object');
      const record = createRecord(ctx.db, opts.collection, { ...opts.data });
      if (record) {
        // M13-fix: realtime broadcast di SEMUA depth (rules tetap dievaluasi
        // per subscriber saat publish — lihat realtimeHub.publish).
        ctx.onRealtimeWrite?.('create', opts.collection, record as unknown as Record<string, unknown>);
      }
      if (!suppressTriggers) {
        ctx.onWrite?.('create', opts.collection, record as unknown as Record<string, unknown>, null);
      }
      return record;
    }

    case 'update': {
      if (typeof opts.id !== 'string' || opts.id === '') block('update requires an id');
      if (!opts.data || typeof opts.data !== 'object') block('update requires a data object');
      // Snapshot sebelum tulis — trigger/realtime butuh previous (pola M38)
      const previous = suppressTriggers
        ? null
        : (getRecord(ctx.db, opts.collection, opts.id) as unknown as Record<string, unknown> | null);
      const record = updateRecord(ctx.db, opts.collection, opts.id, { ...opts.data });
      if (record) {
        ctx.onRealtimeWrite?.('update', opts.collection, record as unknown as Record<string, unknown>);
      }
      if (record && !suppressTriggers) {
        ctx.onWrite?.('update', opts.collection, record as unknown as Record<string, unknown>, previous);
      }
      return record;
    }

    case 'delete': {
      if (typeof opts.id !== 'string' || opts.id === '') block('delete requires an id');
      // Snapshot pre-delete dibutuhkan trigger (previous) DAN realtime delete
      // (record sudah terhapus — rules/filter dievaluasi in-memory, pola M38).
      const needSnapshot = !suppressTriggers || ctx.onRealtimeWrite !== undefined;
      const previous = needSnapshot
        ? (getRecord(ctx.db, opts.collection, opts.id) as unknown as Record<string, unknown> | null)
        : null;
      // AUD-6-03: collector anak ter-cascade — realtime/trigger anak ikut
      // menyala (dulu anak ter-cascade hilang diam-diam dari SSE/trigger).
      const cascaded: { collection: string; record: Record<string, unknown> }[] = [];
      const deleted = deleteRecord(ctx.db, opts.collection, opts.id, undefined, cascaded);
      if (deleted && previous) {
        // Tanpa snapshot, rules delete tak bisa dievaluasi — fail-safe: skip
        // broadcast (konsisten dengan recordMatchesInMemory yang gagal → skip).
        ctx.onRealtimeWrite?.('delete', opts.collection, previous);
      }
      if (deleted && !suppressTriggers) {
        ctx.onWrite?.(
          'delete',
          opts.collection,
          (previous ?? { id: opts.id }) as Record<string, unknown>,
          previous
        );
      }
      // AUD-6-03: fan-out untuk semua anak yang ikut ter-cascade
      for (const c of cascaded) {
        ctx.onRealtimeWrite?.('delete', c.collection, c.record);
        if (!suppressTriggers) {
          ctx.onWrite?.('delete', c.collection, c.record, c.record);
        }
      }
      return deleted;
    }
  }
}

/** Apakah operasi ini menulis? Dipakai test & instrumentasi. */
export function isWriteOp(op: DbOp): boolean {
  return WRITE_OPS.has(op);
}
