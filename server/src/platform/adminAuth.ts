// ============================================================================
// M00: ADMIN AUTH (VERSI SEDERHANA)
//
// PERINGATAN: Ini implementasi BELAJAR yang disengaja tidak aman:
//  - Password disimpan PLAINTEXT di env var (M08: argon2 hashing)
//  - Token hilang saat restart (M09: JWT + session persisten)
//  - Satu admin saja (nanti: multi-admin dengan roles)
//
// Tapi perhatikan alurnya — alur ini SAMA dengan auth yang "benar":
//  1. Kredensial masuk → diverifikasi
//  2. Server menerbitkan TOKEN (bukti "sudah login")
//  3. Request berikutnya membawa token di header Authorization
//  4. Middleware memeriksa token SEBELUM handler berjalan
// Yang berubah di M08/M09 hanyalah CARA verifikasi & bentuk token-nya.
// ============================================================================

import crypto from 'node:crypto';
import type { Middleware, ForgeRequest, ForgeResponse } from '../core/router.js';
import { generateToken, generateId } from '../core/router.js';
import { initPlatformDb } from '../core/platformDb.js';
import { hashPassword, verifyPassword, validatePasswordStrength } from '../auth/password.js';

export interface PlatformAdminRow {
  id: string;
  email: string;
  password_hash: string;
  created: string;
  updated: string;
}

export function countPlatformAdmins(): number {
  try {
    const db = initPlatformDb();
    const row = db.prepare('SELECT COUNT(*) as count FROM _platform_admins').get() as { count: number } | undefined;
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

export function getAdminSetupState(): { needsSetup: boolean; hasAdmin: boolean } {
  const count = countPlatformAdmins();
  return {
    needsSetup: count === 0,
    hasAdmin: count > 0,
  };
}

export function createInitialAdmin(
  email: string,
  password: string
): { token: string; admin: { id: string; email: string } } {
  const count = countPlatformAdmins();
  if (count > 0) {
    throw new Error('Platform administrator is already configured');
  }

  const trimmedEmail = email?.trim().toLowerCase();
  if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    throw new Error('Valid email address is required');
  }

  const policyError = validatePasswordStrength(password);
  if (policyError) {
    throw new Error(policyError);
  }

  const passwordHash = hashPassword(password);
  const db = initPlatformDb();
  const id = generateId();

  db.prepare(
    'INSERT INTO _platform_admins (id, email, password_hash) VALUES (?, ?, ?)'
  ).run(id, trimmedEmail, passwordHash);

  const token = generateToken();
  sessions.set(token, { email: trimmedEmail, createdAt: Date.now() });

  return { token, admin: { id, email: trimmedEmail } };
}

// ─── Kredensial admin dari env (KHUSUS TEST) ────────────────────────────────
//
// M39u + audit auth: Akun admin platform HARUS disimpan di tabel `_platform_admins`
// (platform.db) dengan hashing scrypt OWASP. Di dev dan production tidak boleh
// ada akun default / plaintext backdoor dari env var atau hardcoded fallback.
//
// Fallback env di bawah HANYA aktif saat test runner berjalan (`node --test`),
// agar ~50 file test lama yang menyetel process.env.ADMIN_EMAIL tetap kompatibel
// tanpa harus ditulis ulang.
function isTestEnvironment(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    Boolean(process.env.NODE_TEST_CONTEXT) ||
    process.argv.includes('--test')
  );
}

function getAdminCredentials(): { email: string; password: string } | null {
  if (!isTestEnvironment()) {
    return null;
  }
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
    return null;
  }
  return {
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  };
}

// ─── Token store di memori ───────────────────────────────────────────────────
// Map<token, { email, createdAt }>
// Aha! moment: token di memori = "sesi". Server harus INGAT siapa yang login.
// Inilah kenapa disebut "stateful session" — state-nya ada di server.
// (M09: JWT memindahkan state ini ke dalam token itu sendiri — "stateless")
const sessions = new Map<string, { email: string; createdAt: number }>();

// Token kedaluwarsa setelah 24 jam
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export function loginAdmin(
  email: string,
  password: string
): { token: string; admin: { email: string } } | null {
  const trimmedEmail = email?.trim().toLowerCase();

  // 1. Cek akun database di _platform_admins (M39u)
  try {
    const db = initPlatformDb();
    const row = db
      .prepare('SELECT * FROM _platform_admins WHERE lower(email) = ?')
      .get(trimmedEmail) as PlatformAdminRow | undefined;

    if (row) {
      if (verifyPassword(password, row.password_hash)) {
        const token = generateToken();
        sessions.set(token, { email: row.email, createdAt: Date.now() });
        return { token, admin: { email: row.email } };
      }
      return null; // Email terdaftar di DB tapi password salah
    }
  } catch {
    // Abaikan jika DB belum siap
  }

  // 2. Fallback ke env var (hanya di environment test)
  const creds = getAdminCredentials();
  if (!creds) {
    return null;
  }

  const emailMatch = safeEqual(email, creds.email);
  const passwordMatch = safeEqual(password, creds.password);

  if (!emailMatch || !passwordMatch) {
    return null;
  }

  const token = generateToken();
  sessions.set(token, { email, createdAt: Date.now() });

  return { token, admin: { email } };
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Tetap lakukan perbandingan dummy agar timing tidak bocorkan panjang
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function validateToken(token: string): { email: string } | null {
  const session = sessions.get(token);
  if (!session) return null;

  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }

  return { email: session.email };
}

export function logoutAdmin(token: string): void {
  sessions.delete(token);
}

// ─── Ganti password admin ────────────────────────────────────────────────────
// Hanya untuk akun yang tersimpan di _platform_admins (M39u). Akun berbasis
// env var (fallback test) tidak punya baris DB, jadi tidak bisa diganti lewat
// jalur ini — ia memang bukan akun "nyata".
//
// Kontrak keamanan:
// - Wajib `currentPassword` yang benar (membuktikan pemilik akun, bukan sekadar
//   pembawa token yang tertinggal di perangkat lain).
// - Password baru divalidasi `validatePasswordStrength` (kebijakan yang sama
//   dengan pembuatan admin awal).
// - Setelah berhasil, SEMUA sesi admin lain dicabut — hanya token yang dipakai
//   untuk mengganti yang tetap hidup, supaya user tidak ter-logout paksa dari
//   tabnya sendiri.

export function changeAdminPassword(
  email: string,
  currentPassword: string,
  newPassword: string,
  keepToken?: string
): { ok: true } {
  const trimmedEmail = email?.trim().toLowerCase();
  if (!trimmedEmail) {
    throw new Error('Admin account not found');
  }

  const db = initPlatformDb();
  const row = db
    .prepare('SELECT * FROM _platform_admins WHERE lower(email) = ?')
    .get(trimmedEmail) as PlatformAdminRow | undefined;

  if (!row) {
    // Pesan generik — jangan bocorkan apakah akunnya ada.
    throw new Error('Current password is incorrect');
  }
  if (!verifyPassword(currentPassword, row.password_hash)) {
    throw new Error('Current password is incorrect');
  }

  const policyError = validatePasswordStrength(newPassword);
  if (policyError) {
    throw new Error(policyError);
  }

  db.prepare('UPDATE _platform_admins SET password_hash = ? WHERE id = ?').run(
    hashPassword(newPassword),
    row.id
  );

  // Cabut semua sesi untuk email ini KECUALI token yang sedang dipakai.
  for (const [token, session] of sessions.entries()) {
    if (session.email === row.email && token !== keepToken) {
      sessions.delete(token);
    }
  }

  return { ok: true };
}

// ─── Middleware: wajib admin ─────────────────────────────────────────────────
// Inilah middleware pertama kita! Ia berjalan SEBELUM handler route.
// Return false = request berhenti di sini (handler tidak pernah dipanggil).

export const requireAdmin: Middleware = (req: ForgeRequest, res: ForgeResponse): boolean => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Missing Authorization: Bearer <token>' },
    });
    return false;
  }

  const admin = validateToken(token);
  if (!admin) {
    res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' },
    });
    return false;
  }

  // Tempelkan info admin ke request — handler di ujung chain bisa memakainya
  req.admin = admin;
  return true;
};
