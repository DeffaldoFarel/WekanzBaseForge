// ============================================================================
// AUD-1-01: CLIENT IP RESOLUTION — trusted-proxy aware
//
// Sebelumnya tiap route auth menyalin clientIp() yang memercayai entri
// PERTAMA X-Forwarded-For mentah. Header itu bisa dikirim CLIENT sendiri:
//   - akses langsung (tanpa proxy): spoofing membypass SEMUA rate limit;
//   - di belakang Caddy: proxy menambahkan IP asli di BELAKANG, jadi entri
//     pertama tetap milik attacker.
// Probe audit lama: 25 login dengan XFF berputar → 429=0 (bypass total).
//
// Kontrak baru:
//   TRUST_PROXY tidak diset (default) → XFF DIABAIKAN total; IP diambil dari
//     socket.remoteAddress (aman saat akses langsung / dev / tanpa proxy).
//   TRUST_PROXY=true|1 → percaya SATU hop proxy: IP client = entri TERAKHIR
//     XFF (nilai yang ditambahkan proxy tepercaya kita).
//   TRUST_PROXY=<N>   → percaya N hop proxy: ambil entri ke-N dari belakang.
//
// Peringatan operator: hanya aktifkan TRUST_PROXY kalau SEMUA request memang
// melewati proxy tepercaya yang menulis XFF — tanpa proxy di depan, mode ini
// kembali bisa di-spoof (header XFF entri tunggal langsung dipercaya).
// ============================================================================

export interface IpRequest {
  headers: Record<string, unknown>;
  raw: { socket: { remoteAddress?: string } };
}

/** Berapa hop proxy tepercaya di depan server ini (0 = tidak ada). */
export function trustedProxyDepth(): number {
  const raw = (process.env.TRUST_PROXY ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return 0;
  if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return 1;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10) : 0;
}

function forwardedEntries(headers: Record<string, unknown>): string[] {
  const raw = headers['x-forwarded-for'];
  const fwd = Array.isArray(raw) ? raw.join(',') : raw;
  if (typeof fwd !== 'string' || fwd.length === 0) return [];
  return fwd.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * IP client untuk key rate limiting. Lihat header modul untuk kontrak
 * TRUST_PROXY. Nilai fallback 'unknown' tetap menjadi bucket tersendiri
 * (lebih aman daripada melempar exception di jalur rate limit).
 */
export function clientIpFromRequest(req: IpRequest): string {
  const depth = trustedProxyDepth();
  if (depth > 0) {
    const entries = forwardedEntries(req.headers);
    if (entries.length > 0) {
      return entries[Math.max(0, entries.length - depth)];
    }
  }
  return req.raw.socket.remoteAddress ?? 'unknown';
}
