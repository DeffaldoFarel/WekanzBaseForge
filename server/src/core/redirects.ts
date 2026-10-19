// ============================================================================
// AUD-1-03 / AUD-1-04 / AUD-1-07: REDIRECT TARGET VALIDATION — safe by default
//
// Sebelumnya: email flow (verifikasi & reset password) menerima redirect_to
// ke URL http(s) MANA PUN — token reset dikirim via fragment ke domain
// pilihan attacker (probe audit: 302 https://evil.example/cb#reset_token=...).
// OAuth punya allow-list per provider, tapi default kosong = SEMUA origin
// (access+refresh token ikut bocor via fragment).
//
// Kebijakan baru (seragam untuk email + OAuth):
//   1. AUTH_REDIRECT_ORIGINS (env, koma-separated) — allow-list global
//      eksplisit untuk deployment multi-domain.
//   2. PUBLIC_BASE_URL (env) — origin tepercaya server sendiri; dipakai juga
//      untuk membangun link email & callback OAuth (mengalahkan header Host
//      yang bisa dipalsukan saat akses langsung tanpa proxy).
//   3. Tanpa keduanya → hanya same-origin dengan host request yang diizinkan
//      (cukup untuk dev/test; produksi di belakang Caddy punya Host yang
//      di-match, tapi tetap disarankan menyetel PUBLIC_BASE_URL).
// Semua target di luar itu DITOLAK → respons jatuh ke fallback aman
// (halaman HTML / JSON), bukan redirect.
// ============================================================================

/** Base URL publik server (tanpa trailing slash) dari env — null bila unset. */
export function publicBaseUrl(): string | null {
  const raw = (process.env.PUBLIC_BASE_URL ?? '').trim();
  return raw ? raw.replace(/\/+$/, '') : null;
}

/**
 * Base URL API untuk membangun link email / callback OAuth.
 * PUBLIC_BASE_URL menang (tepercaya, operator yang menulis); tanpa itu jatuh
 * ke header request (x-forwarded-host/host) — perilaku lama, hanya cocok
 * untuk dev/test atau di belakang proxy yang mem-match Host.
 */
export function apiBaseUrl(headers: Record<string, unknown>): string {
  const base = publicBaseUrl();
  if (base) return base;
  const host = String(headers['x-forwarded-host'] ?? headers['host'] ?? 'localhost');
  const proto = String(headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim();
  return `${proto}://${host}`;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Allow-list origin global dari env AUTH_REDIRECT_ORIGINS (koma-separated). */
export function globalAllowedOrigins(): string[] {
  const raw = (process.env.AUTH_REDIRECT_ORIGINS ?? '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => originOf(s) ?? s);
}

/**
 * Validasi redirect target untuk EMAIL FLOW (verifikasi & reset password).
 * Mengembalikan URL yang aman, atau null (target diabaikan → fallback aman).
 * Urutan keputusan lihat header modul.
 */
export function validateRedirectTarget(raw: string | null, headers: Record<string, unknown>): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const allowed = new Set(globalAllowedOrigins());
  const own = originOf(apiBaseUrl(headers));
  if (own) allowed.add(own);

  return allowed.has(url.origin) ? url.toString() : null;
}
