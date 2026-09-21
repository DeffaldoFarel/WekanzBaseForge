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

/**
 * Ekstrak projectId dari path request untuk atribusi trafik aplikasi:
 * - /api/p/{pid}/...     → public API (end-user / client SDK)
 * - /api/files/{pid}/... → file & media serving
 *
 * Jalur /api/admin/... TIDAK diatribusikan:
 * Aktivitas admin di konsol dashboard (melihat skema, mengecek log, membaca
 * daftar file) bukan konsumsi trafik aplikasi. Metrik project murni mengukur
 * penggunaan oleh klien/pengguna nyata (mental model ala Supabase / Firebase).
 */
export function extractProjectId(path: string): string | null {
  const seg = path.split('/').filter(Boolean);
  if (seg.length < 3 || seg[0] !== 'api') return null;
  if (seg[1] === 'p' || seg[1] === 'files') return seg[2];
  return null;
}

/**
 * Atribusi project untuk METRICS — mengembalikan null untuk path yang
 * sengaja tidak dihitung.
 *
 * Menjamin jalur /api/admin/... tidak pernah dihitung, termasuk endpoint
 * monitoring /stats (observer effect: pembacaan statistik tidak boleh menambah
 * angka trafik dirinya sendiri).
 */
export function metricsProjectId(path: string): string | null {
  if (path.startsWith('/api/admin/')) return null;
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

/** Ringkasan murah per project — dipakai kartu daftar project (tanpa deret 14 hari). */
export interface ProjectStatsSummary {
  today: { requests: number; bytesIn: number; bytesOut: number };
  totals: { requests: number; bytesIn: number; bytesOut: number };
}

/** Batas jumlah id per panggilan batch — menjaga ukuran SQL & URL tetap waras. */
export const MAX_STATS_BATCH = 200;

/**
 * Ringkasan stats untuk BANYAK project dalam SATU query SQL.
 *
 * Kenapa ada: daftar project memanggil satu endpoint /stats per kartu — 400
 * project = 400 request HTTP + 400 query. Browser hanya membuka ~6 koneksi per
 * host, jadi kartu terakhir menunggu berpuluh antrean. Agregasi dilakukan di
 * SQL (SUM + GROUP BY), bukan di JS, supaya hanya satu baris per project yang
 * menyeberang dari SQLite.
 *
 * Catatan indeks: PRIMARY KEY (project_id, date) menjadikan project_id kolom
 * paling kiri — `WHERE project_id IN (...)` memakai index itu, bukan full scan.
 *
 * Project tanpa satu pun baris metrics tetap dikembalikan (nol) supaya klien
 * tidak perlu membedakan "belum ada data" dan "tidak dikirim server".
 */
export function getProjectsStatsSummary(
  projectIds: string[]
): Record<string, ProjectStatsSummary> {
  const out: Record<string, ProjectStatsSummary> = {};
  // Dedupe: id ganda tidak boleh menggandakan placeholder SQL.
  const ids = [...new Set(projectIds)].slice(0, MAX_STATS_BATCH);
  for (const id of ids) {
    out[id] = {
      today: { requests: 0, bytesIn: 0, bytesOut: 0 },
      totals: { requests: 0, bytesIn: 0, bytesOut: 0 },
    };
  }
  if (ids.length === 0) return out;

  const db = getPlatformDb();
  initMetricsTables(db);
  const today = utcDateKey();

  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT project_id,
              SUM(requests)  AS requests,
              SUM(bytes_in)  AS bytes_in,
              SUM(bytes_out) AS bytes_out,
              SUM(CASE WHEN date = ? THEN requests  ELSE 0 END) AS today_requests,
              SUM(CASE WHEN date = ? THEN bytes_in  ELSE 0 END) AS today_bytes_in,
              SUM(CASE WHEN date = ? THEN bytes_out ELSE 0 END) AS today_bytes_out
         FROM _platform_metrics
        WHERE project_id IN (${placeholders})
        GROUP BY project_id`
    )
    .all(today, today, today, ...ids) as unknown as {
    project_id: string;
    requests: number;
    bytes_in: number;
    bytes_out: number;
    today_requests: number;
    today_bytes_in: number;
    today_bytes_out: number;
  }[];

  for (const r of rows) {
    const entry = out[r.project_id];
    if (!entry) continue;
    entry.totals = { requests: r.requests, bytesIn: r.bytes_in, bytesOut: r.bytes_out };
    entry.today = {
      requests: r.today_requests,
      bytesIn: r.today_bytes_in,
      bytesOut: r.today_bytes_out,
    };
  }

  // Buffer in-memory: hari berjalan yang belum di-flush (stats tetap real-time,
  // konsisten dengan getProjectStats single-project).
  const wanted = new Set(ids);
  for (const [key, day] of buffer.entries()) {
    const sep = key.lastIndexOf('|');
    const pid = key.slice(0, sep);
    const date = key.slice(sep + 1);
    if (!wanted.has(pid)) continue;
    const entry = out[pid];
    entry.totals.requests += day.requests;
    entry.totals.bytesIn += day.bytesIn;
    entry.totals.bytesOut += day.bytesOut;
    if (date === today) {
      entry.today.requests += day.requests;
      entry.today.bytesIn += day.bytesIn;
      entry.today.bytesOut += day.bytesOut;
    }
  }

  return out;
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
