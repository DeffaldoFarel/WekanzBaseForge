// ============================================================================
// M27: MFA ROUTES — TOTP enrollment, login challenge, disable, admin reset
//
// End-user (per project, prefix /api/p/:pid/auth):
//   POST /mfa/enroll              [Bearer JWT] → { secret, otpauthUrl }
//   POST /mfa/verify              [Bearer JWT] { token } → { recoveryCodes } (sekali)
//   POST /mfa/challenge           { mfaToken, token | recoveryCode } → tokens
//   POST /mfa/disable             [Bearer JWT] { token | recoveryCode } → { ok }
//
// Admin:
//   POST /api/admin/projects/:pid/auth-users/:uid/mfa-reset → { ok }
//   (GET auth-users diperkaya field mfaEnabled — lihat userAdminRoutes)
//
// Keamanan:
//   - challenge: rate limit 5/15 menit per mfaToken (6 digit = 1 juta
//     kombinasi; 5 percobaan aman terhadap brute force)
//   - login MFA tidak pernah membocorkan token penuh — hanya mfaToken
//     pendek umur (5 menit, sekali sukses)
//   - recovery codes: 10, sekali pakai, hash at-rest
// ============================================================================

import { Router } from '../core/router.js';
import { requireAdmin } from '../platform/adminAuth.js';
import { getProjectDb } from '../core/projectDbManager.js';
import { checkRateLimit } from '../auth/rateLimiter.js';
import { verifyToken } from '../auth/jwt.js';
import { issueTokens } from '../auth/tokens.js';
import { initAuthUsersTable, findAuthUserById } from '../auth/users.js';
import { initAuthTokensTable } from '../auth/tokens.js';
import { createEmailToken, consumeEmailToken, peekEmailToken } from '../auth/emailTokens.js';
import {
  initMfaTable,
  startEnrollment,
  confirmEnrollment,
  isMfaEnabled,
  disableMfa,
  consumeRecoveryCode,
  verifyUserTotp,
} from '../auth/mfa.js';
import { otpauthUri } from '../auth/totp.js';
import { adminResetMfa } from '../auth/mfa.js';

function getMfaDb(projectId: string) {
  try {
    const db = getProjectDb(projectId);
    initAuthUsersTable(db);
    initAuthTokensTable(db);
    initMfaTable(db);
    return db;
  } catch {
    return null;
  }
}

function clientIp(req: { headers: Record<string, unknown>; raw: { socket: { remoteAddress?: string } } }): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.raw.socket.remoteAddress ?? 'unknown';
}

/** Bearer JWT end-user → userId (admin token ditolak — bukan flow user). */
async function requireUserId(req: { headers: { authorization?: string } }): Promise<string | null> {
  const auth = req.headers.authorization;
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!bearer || bearer.startsWith('bf_')) return null; // API key ≠ flow user MFA
  const result = await verifyToken(bearer);
  return result.valid && result.payload?.sub ? String(result.payload.sub) : null;
}

export function createMfaRouter(): Router {
  const router = new Router();

  // ─── ENROLL: mulai (auth JWT) ──────────────────────────────────────────────
  router.post('/api/p/:pid/auth/mfa/enroll', async (req, res) => {
    const ip = clientIp(req);
    if (!(await checkRateLimit(`mfa-enroll:${ip}`, 5, 15 * 60_000))) {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again in 15 minutes.' } });
      return;
    }
    const db = getMfaDb(req.params.pid);
    if (!db) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
      return;
    }
    const userId = await requireUserId(req);
    if (!userId) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication token is required' } });
      return;
    }
    const user = findAuthUserById(db, userId);
    if (!user) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'User not found' } });
      return;
    }

    const { secretB32 } = startEnrollment(db, userId);
    res.json({
      secret: secretB32,
      otpauthUrl: otpauthUri({ secretB32, account: user.email, issuer: 'BaseForge' }),
      message: 'Scan the otpauthUrl with your authenticator app, then confirm via POST /auth/mfa/verify { token }.',
    });
  });

  // ─── VERIFY: konfirmasi enrollment → recovery codes SEKALI ─────────────────
  router.post('/api/p/:pid/auth/mfa/verify', async (req, res) => {
    const ip = clientIp(req);
    if (!(await checkRateLimit(`mfa-verify:${ip}`, 10, 15 * 60_000))) {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again in 15 minutes.' } });
      return;
    }
    const db = getMfaDb(req.params.pid);
    if (!db) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
      return;
    }
    const userId = await requireUserId(req);
    if (!userId) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication token is required' } });
      return;
    }

    const body = (req.body ?? {}) as { token?: string };
    if (!body.token || !/^\d{6}$/.test(body.token)) {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'token (6-digit TOTP code) is required' } });
      return;
    }

    const codes = confirmEnrollment(db, userId, body.token);
    if (!codes) {
      res.status(400).json({
        error: { code: 'INVALID_CODE', message: 'Invalid TOTP code or no pending enrollment' },
      });
      return;
    }

    res.json({
      mfaEnabled: true,
      recoveryCodes: codes, // SEKALI — client wajib menyimpan
      notice: 'Store these recovery codes securely — they will not be shown again.',
    });
  });

  // ─── CHALLENGE: selesaikan login MFA (dipanggil setelah login → mfaRequired) ─
  router.post('/api/p/:pid/auth/mfa/challenge', async (req, res) => {
    const db = getMfaDb(req.params.pid);
    if (!db) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
      return;
    }
    const body = (req.body ?? {}) as { mfaToken?: string; token?: string; recoveryCode?: string };

    if (!body.mfaToken || (!body.token && !body.recoveryCode)) {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'mfaToken and token (or recoveryCode) are required' },
      });
      return;
    }

    // Rate limit PER mfaToken (brute force 6-digit) — sebelum peek
    if (!(await checkRateLimit(`mfa-ch:${body.mfaToken.slice(0, 24)}`, 5, 15 * 60_000))) {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please login again.' } });
      return;
    }

    // PEEK: mfaToken harus valid & belum expired (belum dikonsumsi —
    // percobaan kode salah tidak membunuh token, konfirmasi M23 GET pattern)
    const peeked = peekEmailToken(db, body.mfaToken, 'mfa');
    if (!peeked) {
      res.status(401).json({ error: { code: 'INVALID_MFA_TOKEN', message: 'MFA token is invalid or expired — please login again' } });
      return;
    }
    const userId = peeked.userId;

    if (!isMfaEnabled(db, userId)) {
      res.status(400).json({ error: { code: 'MFA_NOT_ENABLED', message: 'MFA is not enabled for this user' } });
      return;
    }

    // Jalur recovery code (sekali pakai)
    if (body.recoveryCode) {
      const ok = consumeRecoveryCode(db, userId, body.recoveryCode.trim());
      if (!ok) {
        res.status(401).json({ error: { code: 'INVALID_CODE', message: 'Invalid or already-used recovery code' } });
        return;
      }
    } else {
      // Jalur TOTP
      const ok = verifyUserTotp(db, userId, body.token!);
      if (!ok) {
        res.status(401).json({ error: { code: 'INVALID_CODE', message: 'Invalid TOTP code' } });
        return;
      }
    }

    // Sukses → KONSUMSI mfaToken (sekali sukses) + issue token penuh
    consumeEmailToken(db, body.mfaToken, 'mfa');
    const user = findAuthUserById(db, userId);
    if (!user) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'User not found' } });
      return;
    }
    const tokens = await issueTokens(db, user);
    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        verified: user.verified,
        mfaEnabled: true,
        created: user.created,
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
    });
  });

  // ─── DISABLE: matikan MFA (auth + bukti kepemilikan) ───────────────────────
  router.post('/api/p/:pid/auth/mfa/disable', async (req, res) => {
    const db = getMfaDb(req.params.pid);
    if (!db) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
      return;
    }
    const userId = await requireUserId(req);
    if (!userId) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication token is required' } });
      return;
    }

    const body = (req.body ?? {}) as { token?: string; recoveryCode?: string };
    if (!body.token && !body.recoveryCode) {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'token (TOTP) or recoveryCode is required to disable MFA' },
      });
      return;
    }

    const ok = disableMfa(db, userId, body.token ?? null, body.recoveryCode ?? null);
    if (!ok) {
      res.status(400).json({ error: { code: 'INVALID_CODE', message: 'Invalid TOTP code or recovery code' } });
      return;
    }
    res.json({ ok: true, mfaEnabled: false });
  });

  // ─── ADMIN: reset MFA user (user terkunci — kebijakan admin) ───────────────
  router.post('/api/admin/projects/:pid/auth-users/:uid/mfa-reset', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      initMfaTable(db);
      const ok = adminResetMfa(db, req.params.uid);
      if (!ok) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found or MFA not enabled' } });
        return;
      }
      res.json({ ok: true, mfaEnabled: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  return router;
}
