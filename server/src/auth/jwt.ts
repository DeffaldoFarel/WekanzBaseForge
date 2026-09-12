// ============================================================================
// M18b: JWT — jose (PRODUCTION GRADE)
//
// Menggantikan JWT hand-rolled (M09) dengan library `jose`:
// - alg whitelist KETAT (hanya HS256 diterima — anti alg-confusion attack)
// - exp/nbf/iat divalidasi otomatis + clock tolerance
// - Key rotation siap (secret per token-type bisa beda)
//
// KONTRAK TETAP SAMA (dipakai authRoutes & semua resolveUserCtx):
//   signToken(payload { sub, email?, name? }, ttlSeconds) → string token
//   verifyToken(token) → { valid, payload?, reason? }
//
// FORMAT TOKEN BERUBAH (header/payload internal berbeda dari M09) —
// semua token lama otomatis invalid setelah deploy. Ini acceptable:
// sesi user hanya perlu re-login sekali (rotasi aman).
// ============================================================================

import { SignJWT, jwtVerify } from 'jose';

export interface TokenPayload {
  sub: string; // subject = user id
  email?: string;
  name?: string;
  [key: string]: unknown;
}

export interface VerifyResult {
  valid: boolean;
  payload?: TokenPayload;
  reason?: 'malformed' | 'bad-signature' | 'expired' | 'invalid-claims';
}

// ─── Secret management ───────────────────────────────────────────────────────
// Secret dari env (produksi WAJIB set) — fallback dev secret.
// Sama seperti M09: env dibaca saat dipanggil (bukan module-level).

function getSecret(): Uint8Array {
  const secret =
    process.env.JWT_SECRET ??
    process.env.ADMIN_PASSWORD ?? // fallback dev (M00 compat)
    'dev-only-insecure-secret-change-me';
  return new TextEncoder().encode(secret);
}

// ─── SIGN ────────────────────────────────────────────────────────────────────

export async function signToken(
  payload: { sub: string; email?: string; name?: string; [key: string]: unknown },
  ttlSeconds: number
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .setIssuer('baseforge')
    .sign(getSecret());
}

// ─── VERIFY ──────────────────────────────────────────────────────────────────
// Kontrak hasil sama dengan M09 — pemanggil tidak berubah.

export async function verifyToken(token: string): Promise<VerifyResult> {
  if (typeof token !== 'string' || token.trim() === '') {
    return { valid: false, reason: 'malformed' };
  }

  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      algorithms: ['HS256'], // WHITELIST KETAT — anti alg-confusion
      issuer: 'baseforge',
      clockTolerance: 5, // 5 detik toleransi clock skew antar server
    });

    return {
      valid: true,
      payload: payload as unknown as TokenPayload,
    };
  } catch (err) {
    const code = (err as { code?: string }).code ?? '';
    if (code === 'ERR_JWT_EXPIRED') {
      return { valid: false, reason: 'expired' };
    }
    if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' || code === 'ERR_JWS_INVALID') {
      return { valid: false, reason: 'bad-signature' };
    }
    if (code === 'ERR_JWT_MALFORMED') {
      return { valid: false, reason: 'malformed' };
    }
    return { valid: false, reason: 'invalid-claims' };
  }
}
