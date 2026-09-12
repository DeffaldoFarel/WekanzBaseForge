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
import { generateToken } from '../core/router.js';

// ─── Kredensial admin dari env ───────────────────────────────────────────────
// M09u: dibaca LAZY (saat dipanggil), bukan saat modul dimuat.
// Pelajaran dari perubahan ini: module-level const membaca env TERLALU DINI
// (sebelum test/deploying mengubah env). Lazy = selalu nilai terbaru.
// (M11 nanti: admin credentials pindah ke platform.db dengan hashing proper.)

function getAdminCredentials(): { email: string; password: string } {
  return {
    email: process.env.ADMIN_EMAIL ?? 'admin@baseforge.local',
    password: process.env.ADMIN_PASSWORD ?? 'admin123',
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
  const creds = getAdminCredentials();

  // timingSafeEqual: perbandingan string biasa (===) bisa bocorkan info
  // lewat TIMING (berhenti di karakter pertama yang beda → attacker bisa
  // menebak karakter per karakter). Fungsi ini selalu membandingkan
  // semua karakter dengan waktu konstan. Detail seru di M08!
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
