// ============================================================================
// AUD-1-06: PRODUCTION SECRET GATE — fail-loud, bukan fallback senyap
//
// Sebelumnya rantai fallback JWT_SECRET ?? ADMIN_PASSWORD ?? dev-constant
// berjalan tanpa protes: produksi yang lupa menyetel JWT_SECRET diam-diam
// menandatangani SEMUA token user dengan password admin (atau dev-constant
// yang bisa dipalsukan siapa pun). .env.example bilang "WAJIB di production"
// tapi tidak ada penegakan runtime.
//
// Gate ini dipanggil SEKALI saat server start (index.ts): fatal → refuse to
// start dengan pesan jelas; warn → lanjut tapi teriak di console.
// ============================================================================

export interface SecretGateResult {
  /** Pesan fatal — server harus menolak menyala. */
  fatal: string | null;
  /** Peringatan non-fatal — dicetak saat start. */
  warn: string | null;
}

export function productionSecretGate(): SecretGateResult {
  if (process.env.NODE_ENV !== 'production') {
    return { fatal: null, warn: null };
  }

  const jwt = (process.env.JWT_SECRET ?? '').trim();
  if (!jwt) {
    return {
      fatal:
        'JWT_SECRET is required when NODE_ENV=production. Without it, user access tokens would be signed ' +
        'with the admin password (or the built-in dev constant — forgeable by anyone). Set JWT_SECRET to a long, ' +
        'random string before starting the server.',
      warn: null,
    };
  }

  const oauth = (process.env.OAUTH_SECRET ?? '').trim();
  if (!oauth) {
    return {
      fatal: null,
      warn:
        'OAUTH_SECRET is not set — OAuth client secrets, MFA secrets, and mail credentials will be encrypted ' +
        'with a key derived from JWT_SECRET. Functional, but a separate OAUTH_SECRET is recommended for defense in depth.',
    };
  }

  return { fatal: null, warn: null };
}
