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
import { projectDbPath, getProject } from './platformDb.js';
import { initSchemaTable } from './schema.js';

// Cache koneksi: projectId → DatabaseSync
const connections = new Map<string, DatabaseSync>();

/**
 * Mendapatkan koneksi database untuk sebuah project.
 * Membuka koneksi baru (dan meng-cache) kalau belum ada.
 * Melempar error kalau project tidak ditemukan.
 */
export function getProjectDb(projectId: string): DatabaseSync {
  // Sudah di-cache? Pakai langsung.
  const cached = connections.get(projectId);
  if (cached) return cached;

  // Pastikan project ada di registry
  const project = getProject(projectId);
  if (!project) {
    throw new Error(`Project '${projectId}' tidak ditemukan`);
  }

  const dbPath = projectDbPath(projectId);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database untuk project '${projectId}' belum dibuat`);
  }

  // Buka koneksi baru + pastikan tabel meta ada
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
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
      db.close();
    } catch {
      // abaikan
    }
    connections.delete(id);
  }
}
