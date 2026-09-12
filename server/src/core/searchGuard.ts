// ============================================================================
// M18e: SEARCH GUARD — rate limit khusus endpoint list/search
//
// Kenapa terpisah dari rate limit auth? Search FTS = operasi MAHAL (MATCH
// scan + join). Attacker bisa scanning isi collection lewat ?search= kata
// demi kata (dictionary attack via fulltext). Batas khusus: 60 req/menit
// per (project, IP) — cukup longgar untuk app nyata, ketat untuk scanner.
//
// Memakai rateLimiter umum (Redis + fallback memory) — satu backend.
// ============================================================================

import { checkRateLimit } from '../auth/rateLimiter.js';

/** Key rate limit search: terisolasi per project & per IP */
export function buildSearchRateKey(projectId: string, ip: string): string {
  return `search:${projectId}:${ip}`;
}

/**
 * Cek & catat satu request search (dipanggil DI LIST ROUTE dengan ?search=).
 * @returns true = diizinkan, false = terlalu sering (kirim 429)
 */
export async function checkSearchRateLimit(projectId: string, ip: string): Promise<boolean> {
  return checkRateLimit(buildSearchRateKey(projectId, ip), 60, 60_000);
}
