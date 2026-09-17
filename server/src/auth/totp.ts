// ============================================================================
// M27: TOTP — RFC 6238 (Time-based One-Time Password) via node:crypto
//
// Mengapa dari nol: prinsip proyek — komponen yang BISA dipahami penuh
// dipahami. Algoritma RFC 6238 cuma: HMAC-SHA1 + dynamic truncation + mod.
// Dites terhadap VEKTOR RESMI RFC 6238 (bukan self-test circular!).
//
// Parameter (standar Google Authenticator & co):
//   - secret  : 160-bit (20 byte), base32-encoded untuk transport
//   - period  : 30 detik
//   - digits  : 6
//   - window  : ±1 step (toleransi clock drift) — standar industri
//
// Keamanan:
//   - perbandingan timingSafeEqual (anti timing attack)
//   - verify membandingkan SEMUA kandidat window (kode lama 30s tetap valid
//     — UX standar; window juga ±1)
// ============================================================================

import crypto from 'node:crypto';

// ─── Base32 (RFC 4648, alphabet A-Z2-7 — dipakai seluruh authenticator) ──────

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += B32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output; // tanpa padding '=' — authenticator toleran, URI lebih bersih
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base32 character: '${ch}'`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ─── HOTP (RFC 4226) — fondasi TOTP ────────────────────────────────────────────

/**
 * HOTP: HMAC-SHA1(secret, counter 8-byte BE) → dynamic truncation → N digit.
 * Ini jantung RFC 4226/6238 — 12 baris yang menjaga jutaan akun dunia.
 */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  // counter 8-byte big-endian (Number amah hingga 2^53 — jauh di atas epoch/30)
  msg.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac('sha1', secret).update(msg).digest();

  // Dynamic truncation (RFC 4226 §5.3):
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(code % 10 ** digits).padStart(digits, '0');
}

// ─── TOTP (RFC 6238) ──────────────────────────────────────────────────────────

export const TOTP_PERIOD = 30; // detik per step
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1; // ±1 step tolerance

export function totpAt(secret: Buffer, unixTime: number, digits = TOTP_DIGITS): string {
  const counter = Math.floor(unixTime / TOTP_PERIOD);
  return hotp(secret, counter, digits);
}

export function totpNow(secret: Buffer, digits = TOTP_DIGITS): string {
  return totpAt(secret, Math.floor(Date.now() / 1000), digits);
}

/**
 * Verifikasi kode 6-digit dengan window ±1 step dan perbandingan
 * timing-safe. Urutan pengecekan: current → +1 (clock user maju) → -1.
 * (Urutan sengaja jangan publikasikan di API docs — tidak relevan keamanan,
 * tapi stabil untuk test.)
 */
export function verifyTotp(
  secret: Buffer,
  token: string,
  unixTime = Math.floor(Date.now() / 1000),
  window = TOTP_WINDOW
): boolean {
  if (!/^\d{6}$/.test(token)) return false;

  const counter = Math.floor(unixTime / TOTP_PERIOD);
  const a = Buffer.from(token);
  for (let w = 0; w <= window; w++) {
    for (const c of [counter + w, counter - w]) {
      if (c < 0) continue;
      const b = Buffer.from(hotp(secret, c));
      if (crypto.timingSafeEqual(a, b)) return true;
    }
  }
  return false;
}

// ─── Secret & URI ─────────────────────────────────────────────────────────────

/** Secret acak 160-bit (standar Google Authenticator) → base32. */
export function generateTotpSecret(): { secretB32: string; secretBytes: Buffer } {
  const secretBytes = crypto.randomBytes(20);
  return { secretB32: base32Encode(secretBytes), secretBytes };
}

/**
 * otpauth:// URI — format standar yang discan semua app authenticator.
 * Label & issuer di-encode sesuai spec (Google Key URI Format).
 */
export function otpauthUri(opts: { secretB32: string; account: string; issuer?: string }): string {
  const issuer = opts.issuer ?? 'BaseForge';
  const label = encodeURIComponent(`${issuer}:${opts.account}`);
  const params = new URLSearchParams({
    secret: opts.secretB32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ─── Recovery codes (backup sekali pakai) ─────────────────────────────────────

const RECOVERY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'; // 36 char

/** 10 kode recovery 10-karakter (entropi ~51 bit per kode). */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = crypto.randomBytes(10);
    let code = '';
    for (const b of bytes) code += RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length];
    codes.push(code);
  }
  return codes;
}

/** Hash recovery code untuk penyimpanan (kode = nilai, bukan kunci → sha256 cukup). */
export function hashRecoveryCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}
