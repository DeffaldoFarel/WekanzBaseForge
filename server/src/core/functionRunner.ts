// ============================================================================
// M18a: FUNCTION RUNNER — isolated-vm (PRODUCTION GRADE)
//
// Menggantikan node:vm (yang MENURUT DOKUMENTASI NODE bukan mekanisme
// keamanan) dengan isolated-vm: V8 Isolate sungguhan — heap terpisah,
// memory limit per-isolate, tidak bisa menyentuh host walau escape trick.
//
// M25: dukungan ASYNC + $http.send —
//   - User code dibungkus async IIFE → `await $http.send(...)` bekerja
//   - Hasil dikirim keluar via Callback __setResult (bukan return value,
//     karena promise completion tidak auto-resolve oleh context.eval)
//   - Timeout ganda: ivm timeout (CPU/sync loop) + wall-clock race
//     (total anggaran function termasuk waktu nunggu HTTP)
//   - $http = Reference host; guest memanggil .apply(null, [json, cb])
//     dan host memanggil balik cb via ivm.Callback — pola bridge standar
//
// POLA TRANSFER (penting!):
// - Masuk  : ExternalCopy(value).copyInto()  — JSON-safe
// - Keluar : result DI-SERIALIZE DI DALAM isolate (JSON.stringify) lalu
//            dikirim sebagai STRING — lalu di-parse di host.
// - Console: satu ivm.Callback __pushLog(level, serializedString)
//
// KONTRAK TETAP SAMA (M15a/M15b/M15c):
//   req (callable) = { body, query, auth }
//   req (trigger)  = { action, collection, record, previous }
//   req (scheduled)= { scheduled: true, time }
//   return value → JSON-able; console tertangkap (max N baris)
//   M25: `await $http.send({url, method, headers, body, timeout}) →
//         { status, headers, body, truncated, json() }`
// ============================================================================

import ivm from 'isolated-vm';
import { sandboxedHttpSend } from './httpSandbox.js';
import {
  sandboxedDbCall,
  DEFAULT_MAX_DB_CALLS,
  type DbCallOptions,
  type DbSandboxContext,
} from './dbSandbox.js';
import { buildModulesPrelude } from './moduleRegistry.js';
import { recordExecution, type ExecutionSource } from './executionLog.js';
import type { DatabaseSync } from 'node:sqlite';
import type { RequestContext } from './query/sqlBuilder.js';

export interface FunctionRunOptions {
  body?: unknown;
  query?: Record<string, string>;
  auth?: RequestContext['auth'];
  timeoutMs?: number; // default 2000ms
  maxLogs?: number; // default 100 baris console
  memoryLimitMb?: number; // default 32MB per isolate
  /** M25: allowlist host untuk $http (kosong = $http dimatikan) */
  httpAllow?: string[];
  /** M41: DB project — WAJIB ada agar $db bisa aktif */
  projectDb?: DatabaseSync;
  /** M41: function ini diizinkan pakai $db? (default false = off) */
  dbAccess?: boolean;
  /** M41: kedalaman eksekusi — depth>=1 menekan trigger dari tulisan $db */
  depth?: number;
  /** M41: budget panggilan $db per eksekusi (default 200) */
  maxDbCalls?: number;
  /**
   * M41: dipanggil setelah tulis $db sukses (depth 0 saja). Disuntik oleh
   * pemanggil (API/trigger/scheduler) agar functionRunner tidak mengimpor
   * triggerExecutor — menghindari import melingkar.
   */
  onDbWrite?: DbSandboxContext['onWrite'];
  /**
   * M42: rahasia function (KEY → plaintext), disuntik sebagai `$env` frozen
   * read-only. Didekripsi di HOST sebelum isolate dibuat (getSecretsForFunction),
   * BUKAN di dalam sandbox. Function tidak bisa menulisnya balik.
   */
  secrets?: Record<string, string>;
  /**
   * M43: nama-nama modul $lib yang di-load (urutan = urutan eval). Prelude
   * modul disusun di HOST (buildModulesPrelude) lalu dieval di dalam isolate
   * SEBELUM kode user, mengisi `$lib.<name>`.
   */
  modules?: string[];
  /**
   * M46: bila diset, hasil eksekusi dicatat ke `_function_logs` (perlu
   * projectDb). Gate di sini — bukan di call site — supaya SEMUA pemanggil
   * (invoke, trigger, cron, dan pemanggil masa depan) otomatis tercatat.
   */
  executionLog?: { functionName: string; source: ExecutionSource };
  triggerContext?: {
    action: 'create' | 'update' | 'delete';
    collection: string;
    record: Record<string, unknown>;
    previous?: Record<string, unknown> | null;
  };
  scheduledContext?: {
    time: string;
  };
}

export interface FunctionRunResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  logs: string[];
  durationMs: number;
  timedOut?: boolean;
  oom?: boolean;
  /** M44: plafon memori yang dipakai eksekusi ini (untuk observability). */
  memoryMb?: number;
}

// Bentuk req mengikuti kontrak: scheduled > trigger > callable
function buildReq(opts: FunctionRunOptions): unknown {
  if (opts.scheduledContext) {
    return { scheduled: true, time: opts.scheduledContext.time };
  }
  if (opts.triggerContext) {
    return opts.triggerContext;
  }
  return { body: opts.body ?? {}, query: opts.query ?? {}, auth: opts.auth ?? null };
}

// JSON-safe transfer:ExternalCopy menolak undefined/circular — normalisasi
function safeForTransfer(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return null;
  }
}

// Runtime bootstrap di dalam isolate: console bridge + $http shim + serializer.
const RUNTIME_PRELUDE = `
  var __stringify = function(value) {
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  };
  var __emit = function(level, args) {
    __pushLog(level, __stringify(Array.prototype.slice.call(args)));
  };
  var console = {
    log:   function() { __emit('log', arguments); },
    warn:  function() { __emit('warn', arguments); },
    error: function() { __emit('error', arguments); },
    info:  function() { __emit('info', arguments); }
  };

  // ── M25: $http shim — jembatan async ke host via Reference.apply ──
  // Guest mengirim options (JSON string, copy) + callback (reference);
  // host memanggil balik callback dengan (errorMessage | null, serializedResult).
  var $http = {
    send: function(opts) {
      return new Promise(function(resolve, reject) {
        var serialized;
        try { serialized = __stringify(opts); }
        catch (e) { reject(new Error('$http.send: options are not serializable')); return; }
        __httpSend.apply(
          null,
          [serialized, function(err, resultJson) {
            if (err) {
              reject(new Error(typeof err === 'string' ? err : __stringify(err)));
              return;
            }
            try {
              var parsed = JSON.parse(resultJson);
              parsed.json = function() { return JSON.parse(this.body); };
              resolve(parsed);
            } catch (e) { reject(e); }
          }],
          { arguments: [ { copy: true }, { reference: true } ], async: true }
        );
      });
    }
  };

  // ── M41: $db shim — jembatan async ke database in-process ──
  // Pola IDENTIK $http (M25): options JSON string (copy) + callback (reference).
  // Host memanggil balik dengan (errorMessage | null, serializedResult).
  var __dbCall = function(opts) {
    return new Promise(function(resolve, reject) {
      var serialized;
      try { serialized = __stringify(opts); }
      catch (e) { reject(new Error('$db: arguments are not serializable')); return; }
      __dbSend.apply(
        null,
        [serialized, function(err, resultJson) {
          if (err) {
            reject(new Error(typeof err === 'string' ? err : __stringify(err)));
            return;
          }
          try { resolve(JSON.parse(resultJson)); }
          catch (e) { reject(e); }
        }],
        { arguments: [ { copy: true }, { reference: true } ], async: true }
      );
    });
  };

  var $db = {
    collection: function(name) {
      return {
        list:   function(o) { o = o || {}; return __dbCall({ op: 'list', collection: name, filter: o.filter, sort: o.sort, page: o.page, perPage: o.perPage, expand: o.expand }); },
        get:    function(id, o) { o = o || {}; return __dbCall({ op: 'get', collection: name, id: id, expand: o.expand }); },
        create: function(data) { return __dbCall({ op: 'create', collection: name, data: data }); },
        update: function(id, data) { return __dbCall({ op: 'update', collection: name, id: id, data: data }); },
        delete: function(id) { return __dbCall({ op: 'delete', collection: name, id: id }); }
      };
    }
  };

  // ── M42: $env — rahasia function, READ-ONLY via Proxy ──
  // Kenapa bukan Object.freeze: ExternalCopy/copyInto melewati boundary
  // isolate dan mengembalikan objek BARU yang tidak membawa status frozen;
  // Object.freeze($env) di prelude pun terbukti tidak menempel (probe:
  // isFrozen=false, write berhasil). Proxy dengan trap set/deleteProperty/
  // defineProperty bekerja pada objek copy — deterministik & teruji.
  // Konvensi process.env: baca key yang tidak ada → undefined (bukan error).
  var $env = new Proxy(__envSource, {
    set: function() { throw new TypeError('$env is read-only'); },
    deleteProperty: function() { throw new TypeError('$env is read-only'); },
    defineProperty: function() { throw new TypeError('$env is read-only'); },
    setPrototypeOf: function() { throw new TypeError('$env is read-only'); }
  });

  // ── M43: $lib — registry modul bersama ──
  // Diisi oleh prelude modul (buildModulesPrelude) yang dieval SETELAH prelude
  // ini. Objek biasa: modul BISA bergantung pada modul sebelumnya lewat $lib.
  var $lib = {};
`;

export async function runFunctionCode(
  code: string,
  opts: FunctionRunOptions = {}
): Promise<FunctionRunResult> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const maxLogs = opts.maxLogs ?? 100;
  const memoryLimitMb = opts.memoryLimitMb ?? 32;
  const start = Date.now();

  const logs: string[] = [];
  let logOverflowed = false;

  // M46: pencatatan riwayat. Dibuat SEKALI, dipanggil di ketiga return path.
  // recordExecution sendiri tahan-gagal (tidak pernah menggagalkan eksekusi).
  const logExecution = (result: FunctionRunResult): void => {
    if (!opts.executionLog || !opts.projectDb) return;
    recordExecution(opts.projectDb, {
      functionName: opts.executionLog.functionName,
      source: opts.executionLog.source,
      ok: result.ok,
      error: result.error ?? null,
      logs: result.logs,
      durationMs: result.durationMs,
      memoryMb: result.memoryMb ?? null,
    });
  };

  const isolate = new ivm.Isolate({ memoryLimit: memoryLimitMb });
  let disposed = false;
  const dispose = () => {
    if (!disposed) {
      disposed = true;
      try {
        // M44: isolate yang OOM dibunuh V8 — memanggil dispose() lagi akan
        // melempar 'Isolate is already disposed' dan MENGHANCURKAN proses,
        // mengubah satu function yang kehabisan memori menjadi crash server.
        if (!isolate.isDisposed) isolate.dispose();
      } catch {
        /* isolate sudah mati karena OOM — tidak ada yang perlu dibersihkan */
      }
    }
  };

  // Hasil via Callback __setResult + deferred host (M25: async-capable)
  let settled = false;
  let resolveResult!: (serialized: string) => void;
  let rejectResult!: (err: Error) => void;
  const resultPromise = new Promise<string>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  // Wall-clock race: anggaran TOTAL function (termasuk nunggu $http).
  // ivm timeout hanya menjaga CPU sync — await di $http tidak men-tick-nya.
  // PENTING: handle timer disimpan agar di-clearTimeout di finally. Tanpa itu,
  // setiap eksekusi menyisakan timer yang meledak SETELAH function selesai —
  // rejection tak tertangani yang muncul di event loop sebagai async activity
  // (bug lama, tersembunyi karena jarang ada yang memicu path throw).
  let wallClockTimer: ReturnType<typeof setTimeout> | null = null;
  const wallClock = new Promise<never>((_, reject) => {
    wallClockTimer = setTimeout(() => reject(new Error(`__WALLCLOCK__`)), timeoutMs);
  });
  // Cegah unhandledRejection bila wallClock tidak memenangkan race.
  wallClock.catch(() => {});

  try {
    const context = await isolate.createContext();
    const jail = context.global;

    // ── Console bridge: satu Callback untuk semua level ──
    const pushLog = new ivm.Callback((level: string, serialized: string) => {
      if (logs.length >= maxLogs) {
        if (!logOverflowed) {
          logOverflowed = true;
          logs.push('... (log truncated — limit exceeded)');
        }
        return;
      }
      logs.push(`[${level}] ${serialized}`);
    });
    jail.setSync('__pushLog', pushLog);

    // ── M25: $http bridge — Reference host + guard di httpSandbox ──
    // Fungsi guest diterima sebagai ivm.Reference (probe-verified: hanya
    // .apply yang tersedia, TIDAK applyIgnored); host memanggil balik via
    // .apply async fire-and-forget, error guest callback ditelan.
    const httpSend = new ivm.Reference(
      (serializedOpts: string, callback: ivm.Reference<(...args: unknown[]) => unknown>) => {
        // Jangan biarkan request jalan setelah isolate mati/timed out
        if (disposed) return;
        const reply = (err: string | null, payload?: string): void => {
          if (disposed) return;
          try {
            const invoked = callback.apply(
              null,
              [err, payload ?? null],
              { arguments: { copy: true }, async: true }
            ) as unknown;
            // fire-and-forget: error di dalam callback guest tidak boleh
            // jadi unhandled rejection di host
            if (invoked && typeof (invoked as Promise<unknown>).catch === 'function') {
              (invoked as Promise<unknown>).catch(() => {});
            }
          } catch {
            /* isolate sudah mati — abaikan */
          }
        };
        let parsedOpts: unknown;
        try {
          parsedOpts = JSON.parse(serializedOpts);
        } catch {
          reply('$http.send: options must be valid JSON');
          return;
        }
        sandboxedHttpSend(parsedOpts as never, opts.httpAllow ?? [])
          .then((result) => reply(null, JSON.stringify(result)))
          .catch((err) => reply(err instanceof Error ? err.message : String(err)));
      }
    );
    jail.setSync('__httpSend', httpSend);

    // ── M41: $db bridge — gerbang tunggal ke dbSandbox ──
    // Pola sama dengan $http: Reference host, callback guest via .apply async.
    // Konteks (counter budget) dibuat SEKALI per eksekusi agar budget dibagi
    // seluruh panggilan $db dalam satu run.
    const dbCtx: DbSandboxContext = {
      db: opts.projectDb as DatabaseSync,
      dbAccess: opts.dbAccess === true && opts.projectDb !== undefined,
      depth: opts.depth ?? 0,
      callCounter: { count: 0 },
      maxDbCalls: opts.maxDbCalls ?? DEFAULT_MAX_DB_CALLS,
      onWrite: opts.onDbWrite,
    };

    const dbSend = new ivm.Reference(
      (serializedOpts: string, callback: ivm.Reference<(...args: unknown[]) => unknown>) => {
        if (disposed) return;
        const reply = (err: string | null, payload?: string): void => {
          if (disposed) return;
          try {
            const invoked = callback.apply(
              null,
              [err, payload ?? null],
              { arguments: { copy: true }, async: true }
            ) as unknown;
            if (invoked && typeof (invoked as Promise<unknown>).catch === 'function') {
              (invoked as Promise<unknown>).catch(() => {});
            }
          } catch {
            /* isolate sudah mati — abaikan */
          }
        };
        let parsedOpts: unknown;
        try {
          parsedOpts = JSON.parse(serializedOpts);
        } catch {
          reply('$db: arguments must be valid JSON');
          return;
        }
        // sandboxedDbCall async agar seragam dengan $http, walau records.ts sinkron
        sandboxedDbCall(parsedOpts as DbCallOptions, dbCtx)
          .then((result) => reply(null, JSON.stringify(result ?? null)))
          .catch((err) => reply(err instanceof Error ? err.message : String(err)));
      }
    );
    jail.setSync('__dbSend', dbSend);

    // ── Result bridge: __setResult(serialized) → resolve deferred ──
    const setResult = new ivm.Callback((serialized: string) => {
      if (!settled) {
        settled = true;
        resolveResult(serialized);
      }
    });
    jail.setSync('__setResult', setResult);

    // ── M42: __envSource HARUS diset SEBELUM eval RUNTIME_PRELUDE ──
    // Prelude membungkus __envSource menjadi $env (Proxy) — kalau variabelnya
    // belum ada saat prelude jalan, guest melempar '__envSource is not defined'.
    const envObject = { ...(opts.secrets ?? {}) };
    jail.setSync('__envSource', new ivm.ExternalCopy(envObject).copyInto());

    // ── Runtime prelude (console, $http shim, serializer) ──
    await context.eval(RUNTIME_PRELUDE, { timeout: timeoutMs });

    // ── M43: prelude modul — disusun di HOST, dieval sebelum kode user ──
    // Mengisi $lib.<name> lewat factory IIFE gaya CJS. Urutan = urutan array.
    if (opts.modules && opts.modules.length > 0) {
      const dbForModules = opts.projectDb;
      if (!dbForModules) {
        throw new Error('$lib modules require projectDb (modules live in the project DB)');
      }
      const modulesPrelude = buildModulesPrelude(dbForModules, opts.modules);
      if (modulesPrelude) {
        await context.eval(modulesPrelude, { timeout: timeoutMs });
      }
    }

    // ── Injeksi req via ExternalCopy ──
    const req = safeForTransfer(buildReq(opts));
    jail.setSync('req', new ivm.ExternalCopy(req).copyInto());

    // ── Eksekusi: async IIFE (M25) — `await` bekerja di user code ──
    // Hasil & error keduanya lewat __setResult agar tidak bergantung pada
    // apakah context.eval me-resolve promise completion value.
    const wrapped = `
      (async function(){
        "use strict";
        var __userResult = await (async function(){ ${code}\n })();
        __setResult(__stringify(__userResult === undefined ? null : __userResult));
      })().catch(function(e){
        __setResult(JSON.stringify({ __bfError: String(e && e.message || e) }));
      });
      null
    `;

    // ivm timeout menjaga sync CPU (infinite loop); wall-clock menjaga total.
    const evalPromise = context.eval(wrapped, { timeout: timeoutMs }).catch((err: Error) => {
      // Sync crash (syntax error, sync timeout, OOM) → tolak deferred
      if (!settled) {
        settled = true;
        rejectResult(err);
      }
    });

    const serialized = await Promise.race([resultPromise, evalPromise.then(() => resultPromise), wallClock]);

    let result: unknown = null;
    try {
      result = JSON.parse(serialized);
    } catch {
      result = serialized; // fallback: kirim apa adanya (string)
    }

    // Marker error runtime async (user code throw di dalam await)
    if (
      result &&
      typeof result === 'object' &&
      '__bfError' in (result as Record<string, unknown>)
    ) {
      const failResult: FunctionRunResult = {
        ok: false,
        error: String((result as Record<string, unknown>).__bfError),
        logs,
        durationMs: Date.now() - start,
        memoryMb: memoryLimitMb, // M44: konsisten — semua path membawa plafon
      };
      logExecution(failResult); // M46
      return failResult;
    }

    const okResult: FunctionRunResult = {
      ok: true,
      result,
      logs,
      durationMs: Date.now() - start,
      memoryMb: memoryLimitMb,
    };
    logExecution(okResult); // M46
    return okResult;
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const timedOut =
      /timed out/i.test(rawMessage) || rawMessage === '__WALLCLOCK__';
    const oom = /out of memory|memory limit/i.test(rawMessage);
    const errResult: FunctionRunResult = {
      ok: false,
      error: timedOut
        ? `Function exceeded the ${timeoutMs}ms timeout (infinite loop or slow $http request?)`
        : oom
          ? `Function exceeded the ${memoryLimitMb}MB memory limit`
          : rawMessage,
      logs,
      durationMs: Date.now() - start,
      timedOut,
      oom,
      memoryMb: memoryLimitMb,
    };
    logExecution(errResult); // M46
    return errResult;
  } finally {
    if (wallClockTimer) clearTimeout(wallClockTimer);
    dispose();
  }
}
