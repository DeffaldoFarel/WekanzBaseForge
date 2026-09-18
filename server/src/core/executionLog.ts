// ============================================================================
// M46: EXECUTION LOG — riwayat eksekusi function + log persisten
//
// Mengapa modul ini ada: hasil eksekusi function sebelumnya hanya dicetak ke
// stdout server (triggerExecutor/scheduler) — hilang saat restart dan tidak
// bisa dibaca via API. Tanpa riwayat, function tidak bisa di-debug: pemilik
// tidak bisa menjawab "function mana yang gagal, kapan, dan kenapa".
//
// PRINSIP UTAMA: pencatatan TIDAK PERNAH menggagalkan eksekusi. Seluruh
// pekerjaan recordExecution dibungkus try/catch — tabel hilang, DB locked,
// disk penuh: function tetap mengembalikan hasilnya. Observability tidak
// pernah lebih penting daripada hasil.
//
// RETENSI: 200 eksekusi terakhir per function (≈3 bulan untuk cron harian).
// Ditentukan oleh pertanyaan yang dijawab ("kenapa cron tadi pagi gagal"),
// bukan oleh kapasitas disk.
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

/** Retensi: jumlah eksekusi terbaru yang dipertahankan per function. */
export const EXECUTION_LOG_RETENTION = 200;

export type ExecutionSource = 'callable' | 'public' | 'trigger' | 'schedule';

export interface ExecutionLogEntry {
  id: string;
  functionName: string;
  source: ExecutionSource;
  ok: boolean;
  error: string | null;
  logs: string[];
  durationMs: number;
  memoryMb: number | null;
  created: string;
}

export interface ExecutionLogPage {
  page: number;
  perPage: number;
  totalItems: number;
  items: ExecutionLogEntry[];
}

// ─── Tabel (per project DB, idempotent) ──────────────────────────────────────

export function initExecutionLogTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _function_logs (
      id TEXT PRIMARY KEY,
      function_name TEXT NOT NULL,
      source TEXT NOT NULL,
      ok INTEGER NOT NULL,
      error TEXT,
      logs TEXT NOT NULL DEFAULT '[]',
      duration_ms INTEGER NOT NULL DEFAULT 0,
      memory_mb INTEGER,
      created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  // Index untuk query "riwayat function X terbaru" — pola paling umum.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_function_logs_name_created
    ON _function_logs(function_name, created DESC, id DESC);
  `);
}

// ─── Pencatatan (tahan-gagal) ────────────────────────────────────────────────

export interface RecordExecutionInput {
  functionName: string;
  source: ExecutionSource;
  ok: boolean;
  error?: string | null;
  logs?: string[];
  durationMs: number;
  memoryMb?: number | null;
}

/**
 * Catat satu eksekusi + pangkas retensi. SELURUH pekerjaan dibungkus try/catch:
 * kegagalan logging TIDAK PERNAH menggagalkan function yang sedang berjalan.
 */
export function recordExecution(db: DatabaseSync, input: RecordExecutionInput): void {
  try {
    initExecutionLogTable(db);
    db.prepare(
      `INSERT INTO _function_logs (id, function_name, source, ok, error, logs, duration_ms, memory_mb)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      crypto.randomUUID(),
      input.functionName,
      input.source,
      input.ok ? 1 : 0,
      input.error ?? null,
      JSON.stringify(input.logs ?? []),
      Math.max(0, Math.round(input.durationMs)),
      input.memoryMb ?? null
    );

    // Pangkas: pertahankan N terbaru per function. ORDER BY created DESC,
    // id DESC — id sebagai tiebreaker untuk eksekusi dalam milidetik yang sama.
    db.prepare(
      `DELETE FROM _function_logs
       WHERE function_name = ?
         AND id NOT IN (
           SELECT id FROM _function_logs
           WHERE function_name = ?
           ORDER BY created DESC, id DESC
           LIMIT ?
         )`
    ).run(input.functionName, input.functionName, EXECUTION_LOG_RETENTION);
  } catch (err) {
    // Sengaja ditelan: lihat catatan PRINSIP UTAMA di header.
    console.error(
      `[execution-log] failed to record ${input.functionName}:`,
      err instanceof Error ? err.message : err
    );
  }
}

// ─── Pembacaan ───────────────────────────────────────────────────────────────

interface LogRow {
  id: string;
  function_name: string;
  source: string;
  ok: number;
  error: string | null;
  logs: string;
  duration_ms: number;
  memory_mb: number | null;
  created: string;
}

function rowToEntry(row: LogRow): ExecutionLogEntry {
  let logs: string[] = [];
  try {
    const parsed = JSON.parse(row.logs ?? '[]');
    if (Array.isArray(parsed)) logs = parsed.filter((l) => typeof l === 'string');
  } catch {
    logs = [];
  }
  return {
    id: row.id,
    functionName: row.function_name,
    source: row.source as ExecutionSource,
    ok: row.ok === 1,
    error: row.error,
    logs,
    durationMs: row.duration_ms,
    memoryMb: row.memory_mb,
    created: row.created,
  };
}

/**
 * Riwayat eksekusi. functionName undefined = semua function (untuk halaman
 * Executions agregat). Terbaru dulu (created DESC, id DESC).
 */
export function listExecutions(
  db: DatabaseSync,
  opts: { functionName?: string; page?: number; perPage?: number } = {}
): ExecutionLogPage {
  initExecutionLogTable(db);
  const page = Math.max(1, opts.page ?? 1);
  const perPage = Math.min(200, Math.max(1, opts.perPage ?? 20));

  const where = opts.functionName ? 'WHERE function_name = ?' : '';
  const params: (string | number)[] = opts.functionName ? [opts.functionName] : [];

  const countRow = db
    .prepare(`SELECT COUNT(*) AS n FROM _function_logs ${where}`)
    .get(...(params as never[])) as { n: number };
  const totalItems = countRow.n;

  const rows = db
    .prepare(
      `SELECT * FROM _function_logs ${where}
       ORDER BY created DESC, id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...([...params, perPage, (page - 1) * perPage] as never[])) as unknown as LogRow[];

  return { page, perPage, totalItems, items: rows.map(rowToEntry) };
}

/** Hapus seluruh riwayat satu function. Return jumlah baris terhapus. */
export function clearExecutions(db: DatabaseSync, functionName: string): number {
  initExecutionLogTable(db);
  const res = db
    .prepare('DELETE FROM _function_logs WHERE function_name = ?')
    .run(functionName);
  return Number(res.changes);
}
