// ============================================================================
// M18d: RATE LIMITER — Redis-backed (PRODUCTION GRADE) dengan fallback memory
//
// Menggantikan rate limiter in-memory (M09u) sebagai backend LITERAL:
//   + Redis: persistent antar restart, SHARED antar multi-instance
//     (persiapan multi-instance di VPS tencentvps1 + WBS queue)
//   + Fallback memory otomatis saat Redis tidak tersedia (dev, test, CI):
//     server TETAP JALAN tanpa Redis — degraded, bukan mati.
//
// Algoritma: FIXED WINDOW (sama seperti versi memory, atomic via Lua script
// agar count+expiry terjadi dalam satu operasi atomik Redis).
//
// Pattern dipertahankan: satu gerbang `checkRateLimit` / `secondsUntilReset`
// — route handler (authRoutes) TIDAK berubah kecuali `await`.
// ============================================================================

import Redis from 'ioredis';

// ─── Koneksi Redis (opsional) ───────────────────────────────────────────────
// REDIS_URL diset di produksi (mis. redis://localhost:6379). Di dev/test
// biasanya tidak ada → pakai memory fallback.
//
// M18d (jebakan ESM): env VAR dibaca LAZY (saat request pertama), bukan saat
// module load — ESM mengangkat import statis di atas assignment
// `process.env.REDIS_URL = ...` di file pemanggil, jadi baca di module-load
// selalu undefined untuk test yang set env sebelum import.
let redis: Redis | null = null;
let redisAvailable = false;
let redisInitTried = false;

function ensureRedis(): void {
  if (redisInitTried) return;
  redisInitTried = true;
  const url = process.env.REDIS_URL ?? '';
  if (!url) return;
  redis = new Redis(url, {
    maxRetriesPerRequest: 1,
    // Reconnect agresif tapi terbatas; kalau Redis down, fallback memory jalan
    retryStrategy: (times) => Math.min(times * 500, 5000),
    lazyConnect: false,
  });
  redis.on('ready', () => { redisAvailable = true; });
  redis.on('error', () => { redisAvailable = false; }); // jangan crash server
  redis.on('end', () => { redisAvailable = false; });
  redis.on('reconnecting', () => { /* tunggu; tetap coba */ });
}

/**
 * Tunggu sampai Redis ready (atau gagal).
 * M18d (jebakan race): koneksi ioredis ASYNC — request pertama sering datang
 * sebelum 'ready' fired. Tanpa wait, request-request awam selamanya jatuh ke
 * memory fallback padahal Redis dikonfigurasi. Pola produksi: timeout singkat
 * (2s) — kalau Redis tak ready juga, lanjut fallback supaya server tetap hidup.
 */
async function waitForRedisReady(maxMs = 2000): Promise<void> {
  ensureRedis();
  if (!redis || redisAvailable) return;
  const start = Date.now();
  while (!redisAvailable && Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ─── Lua script: fixed window ATOMIK ────────────────────────────────────────
// KEYS[1] = key, ARGV[1] = limit, ARGV[2] = window (detik)
// Return: [allowed(0/1), ttl_sisa_detik]
// Kenapa Lua? INCR + EXPIRE dua langkah = race condition di multi-instance;
// Lua jalan atomik di server Redis.
const FIXED_WINDOW_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
local ttl = redis.call('TTL', KEYS[1])
if current > tonumber(ARGV[1]) then
  return {0, ttl}
end
return {1, ttl}
`;

// ─── Memory fallback (kode M09u asli, tak berubah) ──────────────────────────

interface RateEntry {
  count: number;
  resetAt: number; // unix ms
}

const memoryAttempts = new Map<string, RateEntry>();

let lastCleanup = Date.now();
function maybeCleanup(): void {
  const now = Date.now();
  if (now - lastCleanup > 60_000) {
    for (const [key, entry] of memoryAttempts.entries()) {
      if (entry.resetAt < now) memoryAttempts.delete(key);
    }
    lastCleanup = now;
  }
}

/**
 * Cek dan catat satu percobaan dari sebuah key (biasanya IP).
 * @returns true = DIIZINKAN (masih di bawah batas)
 *          false = DITOLAK (melebihi batas)
 */
export async function checkRateLimit(key: string, limit = 10, windowMs = 60_000): Promise<boolean> {
  // ── Jalur Redis ──
  await waitForRedisReady();
  if (redis && redisAvailable) {
    try {
      const windowSec = Math.ceil(windowMs / 1000);
      const result = (await redis.eval(
        FIXED_WINDOW_LUA, 1, `rl:${key}`, String(limit), String(windowSec)
      )) as [number, number];
      return result[0] === 1;
    } catch {
      // Redis error mendadak → fallback memory (jangan blok request)
      redisAvailable = false;
    }
  }

  // ── Jalur memory (fallback / dev / test) ──
  return checkRateLimitMemory(key, limit, windowMs);
}

function checkRateLimitMemory(key: string, limit: number, windowMs: number): boolean {
  maybeCleanup();
  const now = Date.now();

  const entry = memoryAttempts.get(key);

  // Belum ada / sudah reset → mulai hitungan baru
  if (!entry || entry.resetAt < now) {
    memoryAttempts.set(key, { count: 1, resetAt: now + windowMs });
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
export async function secondsUntilReset(key: string): Promise<number> {
  // ── Jalur Redis ──
  await waitForRedisReady();
  if (redis && redisAvailable) {
    try {
      const ttl = await redis.ttl(`rl:${key}`);
      return ttl > 0 ? ttl : 0;
    } catch {
      redisAvailable = false;
    }
  }

  // ── Jalur memory ──
  const entry = memoryAttempts.get(key);
  if (!entry) return 0;
  return Math.max(0, Math.ceil((entry.resetAt - Date.now()) / 1000));
}

/** Reset rate limit untuk key tertentu (untuk test) */
export async function resetRateLimit(key: string): Promise<void> {
  await waitForRedisReady();
  if (redis && redisAvailable) {
    try { await redis.del(`rl:${key}`); } catch { redisAvailable = false; }
  }
  memoryAttempts.delete(key);
}

/** Reset SEMUA rate limit (untuk test) */
export async function resetAllRateLimits(): Promise<void> {
  await waitForRedisReady();
  if (redis && redisAvailable) {
    try {
      // Hapus semua key prefix rl: (scan, bukan KEYS — KEYS blok di produksi)
      let cursor = '0';
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', 'rl:*', 'COUNT', 100);
        cursor = next;
        if (keys.length > 0) await redis.del(...keys);
      } while (cursor !== '0');
    } catch { redisAvailable = false; }
  }
  memoryAttempts.clear();
}

/** Tutup koneksi Redis (graceful shutdown) */
export async function closeRateLimiter(): Promise<void> {
  if (redis) {
    try { await redis.quit(); } catch { redis?.disconnect(); }
    redis = null;
    redisAvailable = false;
  }
}
