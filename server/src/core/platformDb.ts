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

// ─── Resolusi DATA_DIR: LAZY, bukan saat module-load ────────────────────────
//
// Jebakan ESM (pelajaran mahal — ini dulu benar-benar terjadi di repo ini):
//
//   const DATA_DIR = path.resolve(process.env.DATA_DIR ?? '../data');  // ❌
//
// Satu baris itu dievaluasi saat modul DI-IMPORT. Spesifikasi ESM mengangkat
// (hoist) seluruh static import ke atas — SEBELUM satu pun statement di file
// pemanggil dijalankan. Jadi pola test yang sangat wajar ini:
//
//   import { initPlatformDb } from '../src/core/platformDb.js';
//   before(() => { process.env.DATA_DIR = './data/my-test'; initPlatformDb(); });
//
// SELALU terlambat: modul sudah membekukan `../data` sebelum before() jalan.
// Akibatnya 42 file test di repo ini diam-diam menulis ke DATA PRODUKSI —
// kebocoran yang tidak terlihat karena test tetap "hijau" (mereka hanya
// membuat project baru, dan rmSync di after() menghapus direktori test yang
// memang tidak pernah terisi).
//
// Perbaikannya: baca env saat DIPAKAI, lalu cache. Pola yang sama sudah
// dipakai `auth/rateLimiter.ts` untuk REDIS_URL dengan alasan persis sama.
//
// Kenapa di-cache dan tidak dibaca ulang setiap kali: path data harus STABIL
// selama proses hidup. Mengubah DATA_DIR di tengah jalan akan membuat
// setengah data mendarat di satu folder dan setengahnya di folder lain.
// Cache di-set pada pemakaian pertama; `resetPlatformDbForTests()` adalah
// satu-satunya jalan resmi untuk mengosongkannya.

let cachedDataDir: string | null = null;

/** Direktori akar seluruh data (platform.db, projects/, storage/). */
export function getDataDir(): string {
  if (cachedDataDir === null) {
    cachedDataDir = path.resolve(process.env.DATA_DIR ?? '../data');
  }
  return cachedDataDir;
}

function platformDbPath(): string {
  return path.join(getDataDir(), 'platform.db');
}

function projectsDir(): string {
  return path.join(getDataDir(), 'projects');
}

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

  fs.mkdirSync(getDataDir(), { recursive: true });
  fs.mkdirSync(projectsDir(), { recursive: true });

  platformDb = new DatabaseSync(platformDbPath());

  // WAL mode = Write-Ahead Logging. Detailnya kita pelajari di M07,
  // tapi singkatnya: lebih cepat dan lebih aman saat crash.
  // PocketBase juga mengaktifkannya.
  platformDb.exec('PRAGMA journal_mode = WAL');

  // Ops-1: busy_timeout — WAL mengizinkan pembaca + SATU penulis, tapi dua
  // PENULIS tetap berebut lock. Tanpa busy_timeout, statement yang menemukan
  // lock gagal SEKETIKA (SQLITE_BUSY) alih-alih menunggu. Kritis untuk beban
  // dashboard: cron menulis via $db bersamaan dengan user aktif di UI.
  platformDb.exec('PRAGMA busy_timeout = 5000');

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

    CREATE TABLE IF NOT EXISTS _platform_admins (
      id            TEXT PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);

  return platformDb;
}

export function getPlatformDb(): DatabaseSync {
  if (!platformDb) throw new Error('Platform DB not initialized');
  return platformDb;
}

/**
 * Tutup koneksi platform.db.
 *
 * Wajib ada untuk test di Windows: selama handle SQLite masih terbuka,
 * `fs.rmSync(dir)` gagal dengan EPERM — direktori test menumpuk dan
 * assertion "direktori bersih" jadi tidak bisa dipercaya.
 */
export function closePlatformDb(): void {
  if (platformDb) {
    try {
      platformDb.close();
    } catch {
      /* sudah tertutup — bukan alasan menggagalkan cleanup */
    }
    platformDb = null;
  }
  // Reset cache path data agar pemanggilan berikutnya (misal test berikutnya
  // yang menyetel DATA_DIR berbeda) membaca ulang environment variable.
  cachedDataDir = null;
}

/**
 * Kembalikan modul ke keadaan sebelum dipakai: tutup DB DAN lupakan DATA_DIR
 * yang sudah di-cache, sehingga pemanggilan berikutnya membaca ulang env.
 *
 * KHUSUS TEST. Di produksi path data tidak boleh berpindah saat runtime —
 * setengah data akan mendarat di folder lama dan setengahnya di folder baru.
 */
export function resetPlatformDbForTests(): void {
  closePlatformDb();
  cachedDataDir = null;
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

// ─── M48: query project berpaginasi (search + sort di SQL) ──────────────────
// Dulu dashboard mengambil SELURUH project lalu memfilter di browser. Dengan
// 400+ project itu berarti mengirim seluruh registry di tiap kunjungan, lalu
// me-render 400 subtree DOM. Search & sort dipindah ke SQL supaya jumlah data
// yang menyeberang sebanding dengan yang benar-benar TAMPIL.

export type ProjectSort = 'newest' | 'oldest' | 'name';

export interface ListProjectsOptions {
  /** Cocokkan substring pada name ATAU id (case-insensitive). */
  search?: string;
  sort?: ProjectSort;
  limit?: number;
  offset?: number;
}

export interface ListProjectsPage {
  projects: ProjectRow[];
  /** Jumlah project yang cocok dengan filter — BUKAN jumlah di halaman ini. */
  total: number;
}

const PROJECT_SORT_SQL: Record<ProjectSort, string> = {
  // Tie-breaker `id` wajib: dua project yang dibuat pada milidetik yang sama
  // bisa bertukar posisi antar halaman → satu project muncul dua kali di
  // halaman berbeda sementara yang lain tak pernah muncul.
  newest: 'created DESC, id DESC',
  oldest: 'created ASC, id ASC',
  // NOCASE: 'Zebra' tidak boleh mendahului 'apple' (ORDER BY default SQLite
  // membandingkan byte, jadi semua huruf kapital menang lebih dulu).
  name: 'name COLLATE NOCASE ASC, id ASC',
};

export function listProjectsPaged(options: ListProjectsOptions = {}): ListProjectsPage {
  const db = getPlatformDb();
  const sort: ProjectSort = PROJECT_SORT_SQL[options.sort as ProjectSort]
    ? (options.sort as ProjectSort)
    : 'newest';
  const limit = Math.min(Math.max(options.limit ?? 24, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);

  const search = (options.search ?? '').trim();
  // LIKE dengan ESCAPE: '%' dan '_' di input user adalah wildcard SQL. Tanpa
  // escape, mencari "100%" akan cocok dengan apa saja.
  const params: string[] = [];
  let where = '';
  if (search) {
    const pattern = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where = `WHERE (name LIKE ? ESCAPE '\\' COLLATE NOCASE OR id LIKE ? ESCAPE '\\' COLLATE NOCASE)`;
    params.push(pattern, pattern);
  }

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM projects ${where}`)
    .get(...params) as unknown as { n: number };

  const projects = db
    .prepare(
      `SELECT * FROM projects ${where} ORDER BY ${PROJECT_SORT_SQL[sort]} LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as unknown as ProjectRow[];

  return { projects, total: totalRow?.n ?? 0 };
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
  return path.join(projectsDir(), projectId);
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
  projectDb.exec('PRAGMA busy_timeout = 5000'); // Ops-1
  projectDb.close();
}

export function destroyProjectStorage(projectId: string): void {
  const dir = projectDir(projectId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  const storageDir = path.join(getDataDir(), 'storage', projectId);
  if (fs.existsSync(storageDir)) {
    fs.rmSync(storageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
