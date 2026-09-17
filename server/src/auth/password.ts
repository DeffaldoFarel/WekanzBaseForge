// ============================================================================
// M08: PASSWORD HASHING — melindungi kredensial dengan scrypt
//
// Kenapa scrypt dari node:crypto (bukan argon2/bcrypt)?
//   1. argon2 adalah native module → gagal compile di Windows (pelajaran
//      yang sama dengan better-sqlite3 di project ini!)
//   2. scrypt adalah finalist Password Hashing Competition (2013), battle-
//      tested, dan digunakan secara luas (termasuk oleh banyak produk besar)
//   3. Zero dependency — konsisten dengan filosofi BaseForge
//
// Parameter scrypt (mengikuti rekomendasi OWASP):
//   N=16384 (2^14) — biaya memori/CPU
//   r=8            — block size
//   p=1            — paralelisme
//   keylen=64      — panjang hash hasil
//   → hasil: ~50-100ms per hash. Lambat itu FITUR (menghambat brute force).
// ============================================================================

import crypto from 'node:crypto';

// ─── Parameter scrypt (standar OWASP 2023+) ─────────────────────────────────

const SCRYPT_N = 16384; // 2^14 — biaya memori
const SCRYPT_r = 8;     // block size
const SCRYPT_p = 1;     // paralelisme
const KEY_LENGTH = 64;  // panjang hash dalam bytes
const SALT_LENGTH = 16; // panjang salt dalam bytes

// ─── Validasi kekuatan password ──────────────────────────────────────────────

export interface PasswordPolicyError {
  code: string;
  message: string;
}

/**
 * Memeriksa kekuatan password. Mengembalikan pesan error jika lemah,
 * null jika lolos. Aturan minimal untuk produksi:
 *   - minimal 8 karakter
 *   - maksimal 128 (mencegah DoS via password raksasa — scrypt memakai
 *     memori sebanding panjang input!)
 */
export function validatePasswordStrength(password: string): string | null {
  if (typeof password !== 'string') {
    return 'Password must be a string';
  }
  if (password.length < 8) {
    return 'Password must be at least 8 characters';
  }
  if (password.length > 128) {
    return 'Password must be at most 128 characters';
  }
  return null;
}

// ─── HASH: password → "scrypt:N:r:p:salt:hash" ──────────────────────────────

/**
 * Meng-hash password dengan scrypt + salt acak.
 * Hasil format: "scrypt:N:r:p:<salt-hex>:<hash-hex>"
 *
 * Semua parameter tersimpan DI DALAM string hash → kalau nanti kita naikkan
 * N (misal 16384 → 32768), password lama tetap bisa diverifikasi karena
 * parameter lamanya terbaca dari hash itu sendiri.
 */
export function hashPassword(password: string): string {
  const policyError = validatePasswordStrength(password);
  if (policyError) {
    throw new Error(policyError);
  }

  // Salt acak per password — inilah yang membuat dua password sama
  // menghasilkan hash berbeda (merusak rainbow table)
  const salt = crypto.randomBytes(SALT_LENGTH);

  // scrypt — sengaja LAMBAH. Inilah fiturnya: menghambat brute force.
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
  });

  return `scrypt:${SCRYPT_N}:${SCRYPT_r}:${SCRYPT_p}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

// ─── VERIFY: password + hash tersimpan → true/false ─────────────────────────

/**
 * Memverifikasi password terhadap hash tersimpan.
 * - Membaca parameter dari hash itu sendiri (forward-compatible)
 * - Membandingkan dengan timingSafeEqual (anti timing attack — lihat M00)
 * - Mengembalikan false (bukan throw) untuk hash rusak — hash korup
 *   adalah "password salah", bukan error server.
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false; // format tidak dikenal
  }

  const N = parseInt(parts[1], 10);
  const r = parseInt(parts[2], 10);
  const p = parseInt(parts[3], 10);
  const salt = Buffer.from(parts[4], 'hex');
  const expectedHash = Buffer.from(parts[5], 'hex');

  if (isNaN(N) || isNaN(r) || isNaN(p) || salt.length === 0 || expectedHash.length === 0) {
    return false;
  }

  // Hash password input dengan PARAMETER YANG SAMA dari hash tersimpan
  const actualHash = crypto.scryptSync(password, salt, expectedHash.length, { N, r, p });

  // timingSafeEqual: perbandingan waktu-konstan (anti timing attack)
  if (actualHash.length !== expectedHash.length) {
    // tetap lakukan perbandingan dummy agar timing tidak membocorkan
    crypto.timingSafeEqual(actualHash, actualHash);
    return false;
  }
  return crypto.timingSafeEqual(actualHash, expectedHash);
}
