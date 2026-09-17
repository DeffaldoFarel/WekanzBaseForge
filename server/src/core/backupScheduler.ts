// ============================================================================
// M32: BACKUP SCHEDULER — VACUUM INTO per project + retensi otomatis
//
// Pola: gabungan M14 backup (VACUUM INTO) + M15c scheduler (interval check).
// Setiap backup membuat snapshot file SQLite yang BISA DIBUKA INDEPENDEN
// (berisi seluruh data project — restore = buka file).
//
// Config runtime per project (disimpan di platform.db):
//   schedule: 'daily' | 'weekly' | 'off' (default: 'off')
//   retention: jumlah backup yang disimpan (default: 7)
//
// Layout backup: <DATA_DIR>/backups/<projectId>/<timestamp>.db
// File metadata: <timestamp>.json (size, duration, status)
//
// Retensi: setelah backup baru, hapus backup LAMA yang melebihi retention.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getPlatformDb, listProjects, getProject, projectDbPath } from './platformDb.js';
import { getProjectDb } from './projectDbManager.js';

// ─── Konfigurasi ─────────────────────────────────────────────────────────────

export interface BackupConfig {
  schedule: 'daily' | 'weekly' | 'off';
  retention: number; // jumlah backup disimpan (min 1, max 30)
}

export interface BackupInfo {
  filename: string;
  timestamp: string;
  size: number;
  durationMs: number;
  collectionCount: number;
  recordCount: number;
}

const DEFAULT_CONFIG: BackupConfig = { schedule: 'off', retention: 7 };

function backupRoot(): string {
  return process.env.BACKUP_DIR ?? path.join(process.cwd(), 'data', 'backups');
}

function projectBackupDir(projectId: string): string {
  return path.join(backupRoot(), projectId);
}

// ─── Konfigurasi CRUD (platform.db) ──────────────────────────────────────────

function initBackupTables(): void {
  const db = getPlatformDb();
  db.exec(`CREATE TABLE IF NOT EXISTS _platform_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
}

export function getBackupConfig(projectId: string): BackupConfig {
  initBackupTables();
  const db = getPlatformDb();
  const row = db
    .prepare("SELECT value FROM _platform_settings WHERE key = ?")
    .get(`backup:${projectId}`) as { value: string } | undefined;
  if (!row) return { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(row.value) as BackupConfig;
    return {
      schedule: parsed.schedule === 'daily' || parsed.schedule === 'weekly' ? parsed.schedule : 'off',
      retention: Math.min(Math.max(parsed.retention ?? 7, 1), 30),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function setBackupConfig(projectId: string, config: BackupConfig): void {
  initBackupTables();
  const db = getPlatformDb();
  db.prepare(
    `INSERT INTO _platform_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(`backup:${projectId}`, JSON.stringify(config));
}

export function deleteBackupConfig(projectId: string): boolean {
  initBackupTables();
  const db = getPlatformDb();
  const result = db
    .prepare("DELETE FROM _platform_settings WHERE key = ?")
    .run(`backup:${projectId}`);
  return result.changes > 0;
}

// ─── Backup execution (VACUUM INTO) ─────────────────────────────────────────

/**
 * Buat backup SATU project via VACUUM INTO.
 * VACUUM INTO membuat file SQLite BARU yang self-contained (bisa dibuka
 * independen — tidak perlu WAL file tambahan).
 */
export function backupProject(projectId: string): BackupInfo {
  const project = getProject(projectId);
  if (!project) {
    throw new Error(`Project '${projectId}' not found`);
  }

  const dbPath = projectDbPath(projectId);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database for project '${projectId}' not found`);
  }

  const dir = projectBackupDir(projectId);
  fs.mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(dir, `${timestamp}.db`);
  const metaPath = path.join(dir, `${timestamp}.json`);

  // VACUUM INTO — atomic, self-contained snapshot
  // ⚠️ node:sqlite: prepare().run() TIDAK bekerja untuk VACUUM INTO
  //    — harus exec(). Dan path perlu forward-slash untuk SQLite.
  const db = getProjectDb(projectId);
  const start = Date.now();
  const sqlPath = backupPath.replace(/\\/g, '/').replace(/'/g, "''");
  db.exec(`VACUUM INTO '${sqlPath}'`);
  const durationMs = Date.now() - start;

  // Hitung collection & record count untuk metadata
  let collectionCount = 0;
  let recordCount = 0;
  try {
    const cols = db
      .prepare("SELECT name FROM _collections WHERE type != 'system'")
      .all() as { name: string }[];
    collectionCount = cols.length;
    for (const col of cols) {
      try {
        const count = (db.prepare(`SELECT COUNT(*) as n FROM "${col.name}"`).get() as { n: number }).n;
        recordCount += count;
      } catch { /* skip */ }
    }
  } catch { /* metadata best-effort */ }

  const info: BackupInfo = {
    filename: `${timestamp}.db`,
    timestamp,
    size: fs.statSync(backupPath).size,
    durationMs,
    collectionCount,
    recordCount,
  };

  // Simpan metadata JSON bersebelahan
  fs.writeFileSync(metaPath, JSON.stringify(info, null, 2));

  console.log(
    `[backup] ${projectId} → ${info.filename} (${(info.size / 1024).toFixed(1)}KB, ${durationMs}ms, ${collectionCount} cols, ${recordCount} records)`
  );

  // Retensi: hapus backup lama yang melebihi retention
  applyRetention(projectId, getBackupConfig(projectId).retention);

  return info;
}

// ─── Retensi ─────────────────────────────────────────────────────────────────

function applyRetention(projectId: string, retention: number): void {
  const dir = projectBackupDir(projectId);
  if (!fs.existsSync(dir)) return;

  // Ambil semua file .db, urutkan DESC (terbaru dulu)
  const backups = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .sort()
    .reverse(); // terbaru → tertua

  // Hapus yang melebihi retention (dari belakang = tertua)
  const toDelete = backups.slice(retention);
  for (const filename of toDelete) {
    const dbFile = path.join(dir, filename);
    const metaFile = path.join(dir, filename.replace('.db', '.json'));
    try { fs.unlinkSync(dbFile); } catch { /* skip */ }
    try { fs.unlinkSync(metaFile); } catch { /* skip */ }
    console.log(`[backup] retention: deleted ${projectId}/${filename}`);
  }
}

// ─── List backups ────────────────────────────────────────────────────────────

export function listBackups(projectId: string): BackupInfo[] {
  const dir = projectBackupDir(projectId);
  if (!fs.existsSync(dir)) return [];

  const result: BackupInfo[] = [];
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse();

  for (const metaFile of entries) {
    try {
      const raw = fs.readFileSync(path.join(dir, metaFile), 'utf8');
      result.push(JSON.parse(raw) as BackupInfo);
    } catch { /* skip corrupt metadata */ }
  }
  return result;
}

export function getBackupPath(projectId: string, filename: string): string | null {
  const dir = projectBackupDir(projectId);
  const fullPath = path.join(dir, filename);
  // Path traversal guard: resolve HARUS masih dalam dir
  if (!path.resolve(fullPath).startsWith(path.resolve(dir) + path.sep)) return null;
  if (!fs.existsSync(fullPath)) return null;
  return fullPath;
}

// ─── Scheduler loop (gaya M15c — 30s interval, anti double-fire) ─────────────

class BackupScheduler {
  private timer: NodeJS.Timeout | null = null;
  private lastRunDay = new Map<string, string>(); // `${pid}:${dayKey}` → marker
  public lastRuns = new Map<string, { time: string; ok: boolean; error?: string; durationMs: number }>();

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try { this.tick(); } catch (err) {
        console.error('[backup-scheduler] tick error:', err);
      }
    }, 30_000);
    this.timer.unref?.();
    console.log('[backup-scheduler] started (checking every 30s)');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[backup-scheduler] stopped');
    }
  }

  private tick(): void {
    const now = new Date();
    const dayKey = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const weekKey = this.getWeekKey(now);
    const projects = listProjects();

    for (const project of projects) {
      const config = getBackupConfig(project.id);
      if (config.schedule === 'off') continue;

      // Anti double-fire: 1x per hari (daily) atau per minggu (weekly)
      const runKey = config.schedule === 'daily' ? dayKey : weekKey;
      const marker = `${project.id}:${config.schedule}:${runKey}`;
      if (this.lastRunDay.has(marker)) continue;

      // Backup!
      try {
        const info = backupProject(project.id);
        this.lastRunDay.set(marker, runKey);
        this.lastRuns.set(project.id, { time: now.toISOString(), ok: true, durationMs: info.durationMs });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[backup-scheduler] ${project.id} FAILED: ${message}`);
        this.lastRuns.set(project.id, { time: now.toISOString(), ok: false, error: message, durationMs: 0 });
        // Tandai agar tidak retry berulang dalam hari/minggu yang sama
        this.lastRunDay.set(marker, runKey);
      }
    }
  }

  private getWeekKey(d: Date): string {
    // ISO week: YYYY-Www
    const jan1 = new Date(d.getFullYear(), 0, 1);
    const week = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7);
    return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
  }
}

export const backupScheduler = new BackupScheduler();
