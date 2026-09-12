// ============================================================================
// M15a: FUNCTION RUNNER — sandbox node:vm
//
// Kode user dijalankan dalam V8 context TERPISAH:
// - TIDAK ADA process / require / fs / os — dunia user terisolasi
// - Yang lolos masuk HANYA yang kita berikan: req, console (tertangkap)
// - timeout menghentikan kode sinkron yang macet (while(true)!)
// - console.log tertangkap dan dibatasi (max N baris) — tidak mencemari
//   log server & tidak jadi vektor membludaknya memori
//
// Kejujuran keamanan (Node docs): node:vm BUKAN boundary keamanan untuk
// kode HOSTILE. Untuk BaseForge: kode dari admin/developer itu sendiri
// (bukan orang asing) — vm + timeout + no-host-access adalah isolasi
// yang tepat sasaran, tanpa dependency berat (isolated-vm/docker).
// ============================================================================

import vm from 'node:vm';
import type { RequestContext } from './query/sqlBuilder.js';

export interface FunctionRunOptions {
  body?: unknown;
  query?: Record<string, string>;
  auth?: RequestContext['auth'];
  timeoutMs?: number; // default 2000ms
  maxLogs?: number; // default 100 baris console
  // M15b: konteks trigger — kalau ada, req = ini (bukan body/query/auth)
  triggerContext?: {
    action: 'create' | 'update' | 'delete';
    collection: string;
    record: Record<string, unknown>;
    previous?: Record<string, unknown> | null;
  };
}

export interface FunctionRunResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  logs: string[];
  durationMs: number;
  timedOut?: boolean;
}

export function runFunctionCode(code: string, opts: FunctionRunOptions = {}): FunctionRunResult {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const maxLogs = opts.maxLogs ?? 100;
  const logs: string[] = [];
  const start = Date.now();

  // ── Console sandbox: tangkap log ke array, buang ke stderr host jika overflow ──
  const pushLog = (level: string, args: unknown[]) => {
    if (logs.length >= maxLogs) {
      if (logs.length === maxLogs) logs.push('... (log dipotong — melebihi batas)');
      return;
    }
    const line = args
      .map((a) => {
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ');
    logs.push(`[${level}] ${line}`);
  };

  const sandboxConsole = {
    log: (...args: unknown[]) => pushLog('log', args),
    warn: (...args: unknown[]) => pushLog('warn', args),
    error: (...args: unknown[]) => pushLog('error', args),
    info: (...args: unknown[]) => pushLog('info', args),
  };

  // ── Sandbox context — inilah SELURUH dunia yang dilihat kode user ──
  const sandbox = {
    console: sandboxConsole,
    req: opts.triggerContext ?? {
      body: opts.body ?? {},
      query: opts.query ?? {},
      auth: opts.auth ?? null, // { id, email } | null
    },
    // Utilitas aman yang KITA izinkan (tidak membawa akses host):
    JSON,
    Math,
    Date,
    isNaN,
    parseInt,
    parseFloat,
    String,
    Number,
    Boolean,
    Array,
    Object,
  };
  // vm.createContext: virtualisasi — globals host TIDAK terlihat dari dalam
  const context = vm.createContext(sandbox);

  // Bungkus IIFE supaya top-level return berfungsi
  const wrapped = `(function(){\n"use strict";\n${code}\n})()`;

  try {
    const result = vm.runInNewContext(wrapped, context, {
      timeout: timeoutMs,
      displayErrors: true,
    });

    return { ok: true, result, logs, durationMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = /Script execution timed out/i.test(message);
    return {
      ok: false,
      error: timedOut
        ? `Function melebihi batas waktu ${timeoutMs}ms (infinite loop?)`
        : message,
      logs,
      durationMs: Date.now() - start,
      timedOut,
    };
  }
}
