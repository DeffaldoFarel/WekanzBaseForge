// ============================================================================
// M09u: RATE LIMITER — anti brute force untuk endpoint auth
//
// Serangan yang dicegah: attacker mencoba jutaan password pada satu akun
// (credential stuffing / brute force). Dengan batas 10 percobaan/menit,
// 1 miliar kombinasi butuh ~190 TAHUN untuk satu akun.
//
// Sengaja IN-MEMORY (Map) untuk Skenario A (single VPS):
//   + Nol dependency, nol setup
//   − Hilang saat restart (attacker dapat jendela baru — risiko kecil)
//   − Tidak cocok untuk multi-instance (butuh Redis — nanti kalau perlu)
// ============================================================================

interface RateEntry {
  count: number;
  resetAt: number; // unix ms
}

const attempts = new Map<string, RateEntry>();

// Bersihkan entri kadaluarsa secara berkala (hindari memory leak)
let lastCleanup = Date.now();
function maybeCleanup(): void {
  const now = Date.now();
  if (now - lastCleanup > 60_000) {
    for (const [key, entry] of attempts.entries()) {
      if (entry.resetAt < now) attempts.delete(key);
    }
    lastCleanup = now;
  }
}

/**
 * Cek dan catat satu percobaan dari sebuah key (biasanya IP).
 * @returns true = DIIZINKAN (masih di bawah batas)
 *          false = DITOLAK (melebihi batas)
 */
export function checkRateLimit(key: string, limit = 10, windowMs = 60_000): boolean {
  maybeCleanup();
  const now = Date.now();

  const entry = attempts.get(key);

  // Belum ada / sudah reset → mulai hitungan baru
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  // Masih dalam window
  if (entry.count < limit) {
    entry.count++;
    return true;
  }

  // Melebihi batas → tolak
  return false;
}

/** Berapa detik lagi sampai rate limit reset (untuk header Retry-After) */
export function secondsUntilReset(key: string): number {
  const entry = attempts.get(key);
  if (!entry) return 0;
  return Math.max(0, Math.ceil((entry.resetAt - Date.now()) / 1000));
}

/** Reset rate limit untuk key tertentu (untuk test) */
export function resetRateLimit(key: string): void {
  attempts.delete(key);
}

/** Reset SEMUA rate limit (untuk test) */
export function resetAllRateLimits(): void {
  attempts.clear();
}
