// ============================================================================
// AUD-8-O1/O2 (FASE 8): SERVER MIDDLEWARE — CORS terkurasi + nosniff global
//
// O-1: middleware CORS lama (index.ts) mengirim 'Access-Control-Allow-Origin: *'
//      TANPA syarat — komentarnya sendiri bilang "dev only!" tapi tidak ada
//      gating: produksi menjawab allow-all-origin selamanya. Kini:
//        - CORS_ALLOWED_ORIGINS='https://a.example,https://b.example'
//          → hanya origin terdaftar yang dipantulkan (spesifik, bukan '*').
//        - Token '*' di daftar = opt-in eksplisit allow-all (dev berani).
//        - Tanpa env: dev/test tetap '*' (workflow lama utuh); production
//          (NODE_ENV=production) TIDAK mengirim ACAO sama sekali — wajib
//          menyetel allowlist eksplisit.
//      Bonus: X-API-Key masuk Allow-Headers — dulu hilang, sehingga klien
//      browser ber-API-key diblokir preflight padahal server menerimanya.
//
// O-2: 'X-Content-Type-Options: nosniff' global untuk SEMUA respons —
//      serve file sudah memilikinya (FASE 4); API/JSON kini juga.
// ============================================================================

import type { Middleware } from './router.js';

/**
 * Resolusi origin CORS untuk satu request. Return:
 *   - string  → nilai Access-Control-Allow-Origin yang boleh dikirim
 *   - undefined → JANGAN kirim header ACAO (origin tidak diizinkan / mode
 *                 production tanpa allowlist)
 */
export function resolveCorsOrigin(origin: string | undefined): string | undefined {
  const raw = process.env.CORS_ALLOWED_ORIGINS?.trim();
  if (raw) {
    const list = raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (list.includes('*')) return origin ?? '*'; // opt-in eksplisit (dev berani)
    if (origin && list.includes(origin.toLowerCase())) return origin; // reflect spesifik
    return undefined; // origin tidak terdaftar → tanpa ACAO
  }
  // Tanpa konfigurasi: dev/test bebas; production WAJIB eksplisit.
  if (process.env.NODE_ENV === 'production') return undefined;
  return '*';
}

export const corsMiddleware: Middleware = (req, res) => {
  const originHeader = req.headers.origin;
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  const allowed = resolveCorsOrigin(origin);
  if (allowed) {
    res.raw.setHeader('Access-Control-Allow-Origin', allowed);
    res.raw.setHeader('Vary', 'Origin'); // cache tidak boleh mencampur origin
  }
  res.raw.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  // AUD-8-O1: X-API-Key — header autentikasi kedua platform (M26)
  res.raw.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  // AUD-8-O2: nosniff global (serve file sudah punya — ini menutup sisanya)
  res.raw.setHeader('X-Content-Type-Options', 'nosniff');

  // Browser mengirim OPTIONS "preflight" sebelum request non-sederhana
  if (req.method === 'OPTIONS') {
    res.status(204).json(null);
    return false; // berhenti di sini
  }
  return true;
};
