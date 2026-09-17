// ============================================================================
// M24: METRICS — statistik request & bandwidth per project per hari
//
// Desain (pelajaran arsitektur SQLite single-writer):
//   request masuk → bump COUNTER IN-MEMORY (O(1), nol disk write)
//   setiap 30 detik → flush BATCH ke platform.db (1 upsert per project/hari)
//
// Kalau tiap request menulis satu row SQLite: antrean write meledak di
// traffic tinggi (single-writer lock!). Buffer-then-flush = write amplification
// ratusan kali lebih hemat.
//
// Agregasi harian (bukan per-request): baris = (project, tanggal) —
// 1 project sibuk = 365 baris/tahun, bukan jutaan.
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import { getPlatformDb } from './platformDb.js';

// ─── Tabel platform: _platform_metrics ────────────────────────────────────────

export function initMetricsTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _platform_metrics (
      project_id TEXT NOT NULL,
      date       TEXT NOT NULL,            -- YYYY-MM-DD (UTC)
      requests   INTEGER NOT NULL DEFAULT 0,
      bytes_in   INTEGER NOT NULL DEFAULT 0,
      bytes_out  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, date)
    );
  `);
}

// ─── Buffer in-memory ─────────────────────────────────────────────────────────

interface DayMetrics {
  requests: number;
  bytesIn: number;
  bytesOut: number;
}

/** key = `${projectId}|${YYYY-MM-DD}` — unflushed counters hidup di sini */
const buffer = new Map<string, DayMetrics>();

function utcDateKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Ekstrak projectId dari path request — dipakai router untuk atribusi. */
export function extractProjectId(path: string): string | null {
  // /api/p/{pid}/...            → public API (end-user)
  // /api/admin/projects/{pid}/… → admin API (dashboard)
  // /api/files/{pid}/...        → file serving (bandwidth besar!)
  const seg = path.split('/').filter(Boolean);
  if (seg.length < 3 || seg[0] !== 'api') return null;
  if (seg[1] === 'p' || seg[1] === 'files') return seg[2];
  if (seg[1] === 'admin' && seg[2] === 'projects') return seg[3] ?? null;
  return null;
}

/**
 * Atribusi project untuk METRICS — mengembalikan null untuk path yang
 * sengaja tidak dihitung. Observer effect: endpoint /stats membaca angka
 * dirinya sendiri — kalau ikut dihitung, tiap pembacaan dashboard menambah
 * traffic (feedback loop + test jadi non-deterministik).
 */
export function metricsProjectId(path: string): string | null {
  if (/^\/api\/admin\/projects\/[^/]+\/stats$/.test(path)) return null;
  return extractProjectId(path);
}

/**
 * Catat satu request selesai (dipanggil dari router pada event 'finish').
 * O(1) murni di memori — tidak menyentuh disk.
 */
export function trackRequest(
  projectId: string,
  bytesIn: number,
  bytesOut: number
): void {
  const key = `${projectId}|${utcDateKey()}`;
  const day = buffer.get(key) ?? { requests: 0, bytesIn: 0, bytesOut: 0 };
  day.requests += 1;
  day.bytesIn += bytesIn;
  day.bytesOut += bytesOut;
  buffer.set(key, day);
}

// ─── Flush batch ke platform.db ───────────────────────────────────────────────

/**
 Kirim seluruh buffer ke DB (upsert) lalu kosongkan.
 Dipanggil interval 30 detik — dan boleh dipanggil manual (test).
*/
export function flushMetrics(): number {
  if (buffer.size === 0) return 0;
  const db = getPlatformDb();
  initMetricsTables(db);

  let flushed = 0;
  db.exec('BEGIN');
  try {
    for (const [key, day] of buffer.entries()) {
      const [projectId, date] = key.split('|');
      db.prepare(
        `INSERT INTO _platform_metrics (project_id, date, requests, bytes_in, bytes_out)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, date) DO UPDATE SET
           requests = requests + excluded.requests,
           bytes_in = bytes_in + excluded.bytes_in,
           bytes_out = bytes_out + excluded.bytes_out`
      ).run(projectId, date, day.requests, day.bytesIn, day.bytesOut);
      flushed++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  buffer.clear();
  return flushed;
}

/** Interval flusher (dipanggil dari index.ts setelah listen). */
export function startMetricsFlusher(intervalMs = 30_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    try {
      flushMetrics();
    } catch (err) {
      console.error('[metrics] flush failed:', err); // jangan matikan server
    }
  }, intervalMs);
  timer.unref?.(); // tidak menghalangi proses exit
  return timer;
}

// ─── Query statistik (merge DB + buffer yang belum di-flush) ─────────────────

export interface DayStats {
  date: string;
  requests: number;
  bytesIn: number;
  bytesOut: number;
}

export interface ProjectStats {
  today: DayStats;
  /** 14 hari terakhir (UTC), hari tanpa data diisi nol — siap untuk chart */
  days: DayStats[];
  totals: { requests: number; bytesIn: number; bytesOut: number };
}

export function getProjectStats(projectId: string): ProjectStats {
  const db = getPlatformDb();
  initMetricsTables(db);

  // DB: semua hari untuk project ini
  const rows = db
    .prepare('SELECT date, requests, bytes_in, bytes_out FROM _platform_metrics WHERE project_id = ?')
    .all(projectId) as unknown as { date: string; requests: number; bytes_in: number; bytes_out: number }[];

  const byDate = new Map<string, DayStats>();
  let totals = { requests: 0, bytesIn: 0, bytesOut: 0 };
  for (const r of rows) {
    byDate.set(r.date, {
      date: r.date,
      requests: r.requests,
      bytesIn: r.bytes_in,
      bytesOut: r.bytes_out,
    });
    totals.requests += r.requests;
    totals.bytesIn += r.bytes_in;
    totals.bytesOut += r.bytes_out;
  }

  // Buffer: merge hari yang belum di-flush (agar stats SELALU real-time)
  for (const [key, day] of buffer.entries()) {
    const [pid, date] = key.split('|');
    if (pid !== projectId) continue;
    const existing = byDate.get(date) ?? { date, requests: 0, bytesIn: 0, bytesOut: 0 };
    existing.requests += day.requests;
    existing.bytesIn += day.bytesIn;
    existing.bytesOut += day.bytesOut;
    byDate.set(date, existing);
    totals.requests += day.requests;
    totals.bytesIn += day.bytesIn;
    totals.bytesOut += day.bytesOut;
  }

  // Rangkai 14 hari terakhir, zero-filled
  const days: DayStats[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = utcDateKey(new Date(Date.now() - i * 24 * 60 * 60 * 1000));
    days.push(
      byDate.get(d) ?? { date: d, requests: 0, bytesIn: 0, bytesOut: 0 }
    );
  }

  return {
    today: days[days.length - 1],
    days,
    totals,
  };
}
