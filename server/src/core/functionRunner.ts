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

  const isolate = new ivm.Isolate({ memoryLimit: memoryLimitMb });
  let disposed = false;
  const dispose = () => {
    if (!disposed) {
      disposed = true;
      isolate.dispose();
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
  const wallClock = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`__WALLCLOCK__`)), timeoutMs);
  });

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

    // ── Result bridge: __setResult(serialized) → resolve deferred ──
    const setResult = new ivm.Callback((serialized: string) => {
      if (!settled) {
        settled = true;
        resolveResult(serialized);
      }
    });
    jail.setSync('__setResult', setResult);

    // ── Runtime prelude (console, $http shim, serializer) ──
    await context.eval(RUNTIME_PRELUDE, { timeout: timeoutMs });

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
      return {
        ok: false,
        error: String((result as Record<string, unknown>).__bfError),
        logs,
        durationMs: Date.now() - start,
      };
    }

    return { ok: true, result, logs, durationMs: Date.now() - start };
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const timedOut =
      /timed out/i.test(rawMessage) || rawMessage === '__WALLCLOCK__';
    const oom = /out of memory|memory limit/i.test(rawMessage);
    return {
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
    };
  } finally {
    dispose();
  }
}
