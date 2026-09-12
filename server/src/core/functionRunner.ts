// ============================================================================
// M18a: FUNCTION RUNNER — isolated-vm (PRODUCTION GRADE)
//
// Menggantikan node:vm (yang MENURUT DOKUMENTASI NODE bukan mekanisme
// keamanan) dengan isolated-vm: V8 Isolate sungguhan — heap terpisah,
// memory limit per-isolate, tidak bisa menyentuh host walau escape trick.
//
// POLA TRANSFER (penting!):
// - Masuk  : ExternalCopy(value).copyInto()  — JSON-safe
// - Keluar : result DI-SERIALIZE DI DALAM isolate (JSON.stringify) lalu
//            dikirim sebagai STRING — lalu di-parse di host. Ini menghindari
//            seluruh kompleksitas Reference/applySync untuk return value.
// - Console: satu ivm.Callback __pushLog(level, serializedString) —
//            pemanggilan cross-isolate paling sederhana & andal.
//
// KONTRAK TETAP SAMA (M15a/M15b/M15c):
//   req (callable) = { body, query, auth }
//   req (trigger)  = { action, collection, record, previous }
//   req (scheduled)= { scheduled: true, time }
//   return value → JSON-able; console tertangkap (max N baris)
//
// PENINGKATAN KEAMANAN vs node:vm:
// - Heap V8 terpisah sungguhan (bukan context sharing)
// - memoryLimit per isolate (OOM = error terkontrol, server aman)
// - Timeout native isolate (lebih akurat)
// ============================================================================

import ivm from 'isolated-vm';
import type { RequestContext } from './query/sqlBuilder.js';

export interface FunctionRunOptions {
  body?: unknown;
  query?: Record<string, string>;
  auth?: RequestContext['auth'];
  timeoutMs?: number; // default 2000ms
  maxLogs?: number; // default 100 baris console
  memoryLimitMb?: number; // default 32MB per isolate
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

// Runtime bootstrap di dalam isolate: console bridge + serializer.
// console user → __pushLog(level, jsonString) → host Callback.
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

  try {
    const context = await isolate.createContext();
    const jail = context.global;

    // ── Console bridge: satu Callback untuk semua level ──
    const pushLog = new ivm.Callback((level: string, serialized: string) => {
      if (logs.length >= maxLogs) {
        if (!logOverflowed) {
          logOverflowed = true;
          logs.push('... (log dipotong — melebihi batas)');
        }
        return;
      }
      logs.push(`[${level}] ${serialized}`);
    });
    jail.setSync('__pushLog', pushLog);

    // ── Runtime prelude (console, serializer) ──
    await context.eval(RUNTIME_PRELUDE, { timeout: timeoutMs });

    // ── Injeksi req via ExternalCopy ──
    const req = safeForTransfer(buildReq(opts));
    jail.setSync('req', new ivm.ExternalCopy(req).copyInto());

    // ── Eksekusi: IIFE agar top-level return bekerja.
    // Result DI-SERIALIZE DI DALAM isolate → string JSON → host parse.
    // Ini menghindari Reference/transfer object secara menyeluruh.
    const wrapped = `
      (function(){
        "use strict";
        var __userResult = (function(){ ${code}\n })();
        return __stringify(__userResult === undefined ? null : __userResult);
      })()
    `;

    const serialized = (await context.eval(wrapped, { timeout: timeoutMs })) as string;

    let result: unknown = null;
    try {
      result = JSON.parse(serialized);
    } catch {
      result = serialized; // fallback: kirim apa adanya (string)
    }

    return { ok: true, result, logs, durationMs: Date.now() - start };
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const timedOut = /timed out/i.test(rawMessage);
    const oom = /out of memory|memory limit/i.test(rawMessage);
    return {
      ok: false,
      error: timedOut
        ? `Function melebihi batas waktu ${timeoutMs}ms (infinite loop?)`
        : oom
          ? `Function melebihi batas memori ${memoryLimitMb}MB`
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
