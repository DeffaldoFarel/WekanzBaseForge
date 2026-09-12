// ============================================================================
// M09: JWT — JSON Web Token dari nol (HMAC-SHA256)
//
// Kita membangun JWT SENDIRI (bukan library jsonwebtoken) supaya memahami
// anatominya. Ternyata intinya hanya:
//
//   1. base64url(header) + "." + base64url(payload)
//   2. signature = HMAC-SHA256(header.payload, SECRET)
//   3. token = header + "." + payload + "." + base64url(signature)
//
// Verifikasi: hitung ulang signature dari header+payload, bandingkan dengan
// signature yang dikirim. Beda = token dimodifikasi = TOLAK.
//
// PENTING: JWT TIDAK dienkripsi! Payload bisa dibaca siapa saja (cukup
// decode base64). JWT menjamin INTEGRITAS (tidak bisa dimodifikasi diam-
// diam), BUKAN kerahasiaan. Jangan pernah menaruh data rahasia di payload!
// ============================================================================

import crypto from 'node:crypto';

// ─── Secret key ──────────────────────────────────────────────────────────────
// Di produksi: WAJIB set JWT_SECRET di env dengan nilai acak panjang.
// Untuk development: default yang jelas-jelas tidak aman (dengan peringatan).

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET wajib diisi di production!');
    }
    return 'dev-only-secret-jangan-dipakai-produksi';
  }
  return secret;
}

// ─── base64url encoding (JWT memakai base64url, bukan base64 biasa) ─────────
// base64url: '+' → '-', '/' → '_', tanpa padding '=' — aman untuk URL.

function base64urlEncode(data: Buffer | string): string {
  return Buffer.from(data)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(data: string): Buffer {
  // Kembalikan padding yang dihapus
  let base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64');
}

// ─── Tipe ────────────────────────────────────────────────────────────────────

export interface TokenPayload {
  sub: string;            // subject = user id
  email?: string;
  name?: string;
  iat: number;            // issued at (unix seconds)
  exp: number;            // expiration (unix seconds)
  [key: string]: unknown; // field tambahan (role, project, dll.)
}

// ─── SIGN: buat JWT ──────────────────────────────────────────────────────────

export function signToken(
  payload: { sub: string; email?: string; name?: string; [key: string]: unknown },
  ttlSeconds: number
): string {
  const header = { alg: 'HS256', typ: 'JWT' };

  const now = Math.floor(Date.now() / 1000);
  const fullPayload: TokenPayload = {
    sub: payload.sub,
    email: payload.email,
    name: payload.name,
    iat: now,
    exp: now + ttlSeconds,
  };

  const headerB64 = base64urlEncode(JSON.stringify(header));
  const payloadB64 = base64urlEncode(JSON.stringify(fullPayload));

  // Signature = HMAC-SHA256(header.payload, secret)
  const signature = crypto
    .createHmac('sha256', getSecret())
    .update(`${headerB64}.${payloadB64}`)
    .digest();

  return `${headerB64}.${payloadB64}.${base64urlEncode(signature)}`;
}

// ─── VERIFY: periksa JWT ─────────────────────────────────────────────────────

export type VerifyResult =
  | { valid: true; payload: TokenPayload }
  | { valid: false; reason: 'malformed' | 'bad-signature' | 'expired' };

export function verifyToken(token: string): VerifyResult {
  // ── 1. Format: harus 3 bagian ──
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { valid: false, reason: 'malformed' };
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  // ── 2. Hitung ulang signature dan bandingkan (anti tampering) ──
  // PENTING: bandingkan signature MENTAH (bytes) dengan timingSafeEqual,
  // bukan string biasa (pelajaran timing attack dari M00/M08).
  const expectedSignature = crypto
    .createHmac('sha256', getSecret())
    .update(`${headerB64}.${payloadB64}`)
    .digest();

  const actualSignature = base64urlDecode(signatureB64);

  if (
    actualSignature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(actualSignature, expectedSignature)
  ) {
    return { valid: false, reason: 'bad-signature' };
  }

  // ── 3. Parse payload ──
  let payload: TokenPayload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString('utf-8')) as TokenPayload;
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  // ── 4. Cek kedaluwarsa ──
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) {
    return { valid: false, reason: 'expired' };
  }

  return { valid: true, payload };
}
