// ============================================================================
// M05u: PROJECT DB MANAGER — mengelola koneksi database per project
//
// Tantangan teknis: setiap project punya file SQLite sendiri
// (data/projects/<id>/data.db). Kita tidak bisa membuka koneksi baru untuk
// SETIAP request (mahal!), jadi koneksi di-CACHE per project.
//
// Ini pelajaran connection pooling versi sederhana: buka sekali, pakai
// berulang, tutup saat tidak dipakai lagi.
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { projectDbPath, getProject } from './platformDb.js';
import { initSchemaTable } from './schema.js';

// Cache koneksi: projectId → DatabaseSync (LRU dengan batas maksimum untuk mencegah EMFILE)
const MAX_CACHED_PROJECT_DBS = 100;
const connections = new Map<string, DatabaseSync>();

/**
 * Mendapatkan koneksi database untuk sebuah project.
 * Membuka koneksi baru (dan meng-cache) kalau belum ada.
 * Menggusur koneksi terlama (LRU) jika melebihi batas kapasitas cache.
 * Melempar error kalau project tidak ditemukan.
 */
export function getProjectDb(projectId: string): DatabaseSync {
  // Sudah di-cache? Refresh posisi LRU dan pakai langsung.
  const cached = connections.get(projectId);
  if (cached) {
    connections.delete(projectId);
    connections.set(projectId, cached);
    return cached;
  }

  // Pastikan project ada di registry
  const project = getProject(projectId);
  if (!project) {
    throw new Error(`Project '${projectId}' not found`);
  }

  const dbPath = projectDbPath(projectId);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database for project '${projectId}' has not been created`);
  }

  // Evict koneksi paling jarang dipakai (LRU) jika cache penuh
  if (connections.size >= MAX_CACHED_PROJECT_DBS) {
    const oldestEntry = connections.entries().next().value;
    if (oldestEntry) {
      const [oldestId, oldestDb] = oldestEntry;
      try {
        oldestDb.exec('PRAGMA wal_checkpoint(PASSIVE)');
        oldestDb.close();
      } catch {
        // abaikan kalau sudah tertutup
      }
      connections.delete(oldestId);
    }
  }

  // Buka koneksi baru + pastikan tabel meta ada
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000'); // Ops-1: tunggu lock, jangan gagal seketika
  initSchemaTable(db);

  connections.set(projectId, db);
  return db;
}

/**
 * Menutup koneksi sebuah project (misalnya saat project dihapus).
 */
export function closeProjectDb(projectId: string): void {
  const db = connections.get(projectId);
  if (db) {
    try {
      db.close();
    } catch {
      // abaikan kalau sudah tertutup
    }
    connections.delete(projectId);
  }
}

/**
 * Menutup SEMUA koneksi (saat server shutdown).
 */
export function closeAllProjectDbs(): void {
  for (const [id, db] of connections.entries()) {
    try {
      db.exec('PRAGMA wal_checkpoint(PASSIVE)');
      db.close();
    } catch {
      // abaikan
    }
    connections.delete(id);
  }
}

export interface ProjectResourceCounts {
  collections: number;
  authUsers: number;
  storageFiles: number;
  functions: number;
}

/**
 * Menghitung jumlah data riil (koleksi, user, fungsi, berkas) pada sebuah project.
 * Query super ringan ke sqlite_master dan tabel terkait.
 */
export function getProjectResourceCounts(projectId: string): ProjectResourceCounts {
  const counts: ProjectResourceCounts = {
    collections: 0,
    authUsers: 0,
    storageFiles: 0,
    functions: 0,
  };

  try {
    const db = getProjectDb(projectId);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('_collections', '_auth_users', '_functions', '_bucket_files')"
      )
      .all() as unknown as { name: string }[];
    const tableSet = new Set(tables.map((t) => t.name));

    if (tableSet.has('_collections')) {
      const row = db.prepare('SELECT COUNT(*) as c FROM _collections').get() as { c: number } | undefined;
      counts.collections = row?.c ?? 0;
    }
    if (tableSet.has('_auth_users')) {
      const row = db.prepare('SELECT COUNT(*) as c FROM _auth_users').get() as { c: number } | undefined;
      counts.authUsers = row?.c ?? 0;
    }
    if (tableSet.has('_functions')) {
      const row = db.prepare('SELECT COUNT(*) as c FROM _functions').get() as { c: number } | undefined;
      counts.functions = row?.c ?? 0;
    }
    if (tableSet.has('_bucket_files')) {
      const row = db.prepare('SELECT COUNT(*) as c FROM _bucket_files').get() as { c: number } | undefined;
      counts.storageFiles = row?.c ?? 0;
    }
  } catch {
    // Project DB mungkin belum diinisialisasi
  }

  // Cek juga file fisik di direktori jika tabel _bucket_files belum mencakupnya
  if (counts.storageFiles === 0) {
    try {
      const dbPath = projectDbPath(projectId);
      const filesDir = path.join(path.dirname(dbPath), 'files');
      if (fs.existsSync(filesDir)) {
        counts.storageFiles = fs.readdirSync(filesDir).length;
      }
    } catch {
      // abaikan
    }
  }

  return counts;
}
