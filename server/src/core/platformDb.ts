// ============================================================================
// M00: PLATFORM DATABASE — tempat data PLATFORM hidup (bukan data project)
//
// Konsep kunci: "meta-database". Database ini tidak menyimpan data user
// Wekanz/Blog — ia menyimpan data TENTANG projects. Database yang mengatur
// database lainnya!
//
// Kita memakai node:sqlite — modul SQLite BAWAAN Node.js (tanpa install!).
// Catatan belajar: PocketBase juga tidak memakai ORM/library tebal untuk
// mengakses SQLite — dia memakai binding langsung. Semangat yang sama:
// sedekat mungkin ke mesinnya, supaya setiap langkah terlihat.
//
// API-nya SINKRON (bukan Promise) — bagus untuk belajar: setiap operasi
// terlihat urutannya dengan jelas.
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.env.DATA_DIR ?? '../data');
const PLATFORM_DB_PATH = path.join(DATA_DIR, 'platform.db');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');

let platformDb: DatabaseSync | null = null;

export interface ProjectRow {
  id: string;
  name: string;
  services: string; // JSON string di DB — SQLite tidak punya tipe JSON native
  created: string;
  updated: string;
}

export interface ProjectServices {
  database: boolean;
  auth: boolean;
  storage: boolean;
  functions: boolean;
}

export const DEFAULT_SERVICES: ProjectServices = {
  database: true,
  auth: true,
  storage: true,
  functions: true,
};

// ─── Inisialisasi ────────────────────────────────────────────────────────────

export function initPlatformDb(): DatabaseSync {
  if (platformDb) return platformDb;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });

  platformDb = new DatabaseSync(PLATFORM_DB_PATH);

  // WAL mode = Write-Ahead Logging. Detailnya kita pelajari di M07,
  // tapi singkatnya: lebih cepat dan lebih aman saat crash.
  // PocketBase juga mengaktifkannya.
  platformDb.exec('PRAGMA journal_mode = WAL');

  // Membuat tabel jika belum ada. Perhatikan: kita menulis SQL MENTAH di
  // sini — di M03 kita akan membuat sistem yang men-generate SQL seperti
  // ini secara otomatis dari definisi collection!
  platformDb.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id       TEXT PRIMARY KEY,
      name     TEXT NOT NULL,
      services TEXT NOT NULL DEFAULT '{}',
      created  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);

  return platformDb;
}

export function getPlatformDb(): DatabaseSync {
  if (!platformDb) throw new Error('Platform DB not initialized');
  return platformDb;
}

// ─── Project CRUD ────────────────────────────────────────────────────────────
// Perhatikan penggunaan PREPARED STATEMENTS dengan placeholder '?'.
// Nilai TIDAK PERNAH digabungkan ke string SQL — inilah pertahanan utama
// terhadap SQL injection, dan kamu akan membangun sistem ini sendiri
// secara generik di M04 (query parser)!

export function listProjects(): ProjectRow[] {
  const db = getPlatformDb();
  return db.prepare('SELECT * FROM projects ORDER BY created DESC').all() as unknown as ProjectRow[];
}

export function getProject(id: string): ProjectRow | undefined {
  const db = getPlatformDb();
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as ProjectRow | undefined;
}

export function createProject(id: string, name: string, services: ProjectServices): ProjectRow {
  const db = getPlatformDb();
  db.prepare('INSERT INTO projects (id, name, services) VALUES (?, ?, ?)').run(
    id,
    name,
    JSON.stringify(services)
  );
  return getProject(id)!;
}

export function updateProject(
  id: string,
  updates: { name?: string; services?: ProjectServices }
): ProjectRow | undefined {
  const db = getPlatformDb();
  const existing = getProject(id);
  if (!existing) return undefined;

  const name = updates.name ?? existing.name;
  const services = updates.services
    ? JSON.stringify(updates.services)
    : existing.services;

  db.prepare(
    `UPDATE projects SET name = ?, services = ?,
     updated = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).run(name, services, id);

  return getProject(id);
}

export function deleteProject(id: string): boolean {
  const db = getPlatformDb();
  const result = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  return result.changes > 0;
}

// ─── Project database provisioning ───────────────────────────────────────────
// Setiap project mendapat folder + file SQLite SENDIRI. Ini inti dari
// multi-tenancy kita: isolasi level file.

export function projectDir(projectId: string): string {
  return path.join(PROJECTS_DIR, projectId);
}

export function projectDbPath(projectId: string): string {
  return path.join(projectDir(projectId), 'data.db');
}

export function provisionProjectStorage(projectId: string): void {
  const dir = projectDir(projectId);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true }); // untuk storage nanti

  // Membuat file DB kosong + tabel meta dasar.
  // Di M03, tabel _collections akan ditambahkan di sini.
  const projectDb = new DatabaseSync(projectDbPath(projectId));
  projectDb.exec('PRAGMA journal_mode = WAL');
  projectDb.close();
}

export function destroyProjectStorage(projectId: string): void {
  const dir = projectDir(projectId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  const storageDir = path.join(DATA_DIR, 'storage', projectId);
  if (fs.existsSync(storageDir)) {
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

export function getDataDir(): string {
  return DATA_DIR;
}
