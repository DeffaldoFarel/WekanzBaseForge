// ============================================================================
// M15b: TRIGGER EXECUTOR — jalankan functions yang ter-trigger oleh CRUD
//
// Dipanggil dari API layer SETELAH create/update/delete sukses (pola sama
// dengan realtime publish). Untuk tiap function enabled yang punya trigger
// cocok (collection + action), jalankan kode di sandbox dengan konteks:
//
//   req = {
//     action:     'create' | 'update' | 'delete',
//     collection: 'posts',
//     record:     { ...data },       // utk delete: hanya { id }
//     previous:   { ... } | null,    // data SEBELUM update (null utk create)
//   }
//
// DESAIN PENTING:
// 1. Sinkron & fire-and-forget: trigger error TIDAK menggagalkan operasi
//    CRUD asli (data sudah tersimpan) — error dicatat di log server.
// 2. Timeout per function tetap berlaku (M15a).
// 3. Log trigger ditulis ke console server (operator melihat apa yang
//    terjadi; M15u nanti bisa simpan ke tabel _function_logs).
// 4. Triggers dijalankan SETELAH realtime publish — urutan: DB → realtime
//    → triggers → side effects (file cleanup). Data konsisten dulu,
//    reaksi kemudian.
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import { getCollectionByName, CollectionMeta } from './schema.js';
import { listFunctions, StoredFunction } from './functionsStore.js';
import { getSecretsForFunction } from './secretsStore.js';
import { runFunctionCode, FunctionRunResult } from './functionRunner.js';

export interface TriggerOutcome {
  functionName: string;
  ran: boolean;
  ok?: boolean;
  error?: string;
  durationMs?: number;
}

export function fireTriggers(
  db: DatabaseSync,
  collection: string,
  action: 'create' | 'update' | 'delete',
  record: Record<string, unknown>,
  previous?: Record<string, unknown> | null,
  depth = 0 // M41: kedalaman pemanggil (0 = dari HTTP/cron langsung)
): TriggerOutcome[] {
  let functions: StoredFunction[];
  try {
    functions = listFunctions(db);
  } catch {
    return []; // tabel belum ada / DB bermasalah — jangan ganggu operasi utama
  }

  const outcomes: TriggerOutcome[] = [];

  for (const fn of functions) {
    if (!fn.enabled) continue;

    const matched = fn.triggers.some((t) => t.collection === collection && t.actions.includes(action));
    if (!matched) continue;

    // M18a: isolated-vm ASYNC — trigger jalan di background (fire-and-forget).
    // Operasi CRUD asli sudah selesai; hasil trigger dicatat via .then.
    void runFunctionCode(fn.code, {
      timeoutMs: fn.timeoutMs,
      memoryLimitMb: fn.memoryMb, // M44
      httpAllow: fn.httpAllow, // M25
      // M41: $db in-process. depth+1 = tulisan $db TIDAK memicu trigger lagi
      // (anti-rekursi: trigger → function → tulis → trigger → ... tak hingga).
      projectDb: db,
      dbAccess: fn.dbAccess,
      depth: depth + 1,
      secrets: getSecretsForFunction(db, fn.name), // M42
      modules: fn.modules, // M43
      executionLog: { functionName: fn.name, source: 'trigger' }, // M46
      triggerContext: {
        action,
        collection,
        record,
        previous: previous ?? null,
      },
    })
      .then((result: FunctionRunResult) => {
        if (!result.ok) {
          console.error(
            `[trigger:${fn.name}] ${collection}.${action} FAILED (${result.durationMs}ms): ${result.error}`
          );
        } else if (result.logs.length > 0) {
          console.log(`[trigger:${fn.name}] ${collection}.${action} (${result.durationMs}ms) ${result.logs.join(' | ')}`);
        } else {
          console.log(`[trigger:${fn.name}] ${collection}.${action} ok (${result.durationMs}ms)`);
        }
        outcomes.push({
          functionName: fn.name,
          ran: true,
          ok: result.ok,
          error: result.error,
          durationMs: result.durationMs,
        });
      })
      .catch((err) => {
        console.error(`[trigger:${fn.name}] unexpected error:`, err);
      });
  }

  return outcomes;
}

// Helper untuk API layer: ambil meta + fire (ignore error — best effort)
export function fireTriggersSafe(
  db: DatabaseSync,
  collection: string,
  action: 'create' | 'update' | 'delete',
  record: Record<string, unknown>,
  previous?: Record<string, unknown> | null,
  depth = 0 // M41
): void {
  try {
    fireTriggers(db, collection, action, record, previous, depth);
  } catch (err) {
    console.error(`[trigger] unexpected error firing ${collection}.${action}:`, err);
  }
}
