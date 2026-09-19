// ============================================================================
// M09u: AUTH API ROUTES — endpoint auth untuk END USERS (per project)
//
// Prefix: /api/p/:pid/auth/*
//
// Ini BERBEDA dari /api/admin/* (M00):
//   /api/admin/*  → untuk dashboard BaseForge (API key admin)
//   /api/p/:pid/* → untuk aplikasi end-user (JWT dari login di sini)
//
// Keamanan yang terpasang:
//   - Rate limiting login/register (anti brute force)
//   - Pesan error seragam (anti user enumeration — M08)
//   - Password hashing (scrypt — M08)
//   - Refresh token hashed di DB + revocable (M09)
// ============================================================================

import { Router } from '../core/router.js';
import type { ForgeResponse } from '../core/router.js';
import { getProjectDb } from '../core/projectDbManager.js';
import {
  initAuthUsersTable,
  createAuthUser,
  verifyAuthCredentials,
  findAuthUserById,
  updateAuthUserProfile,
} from '../auth/users.js';
import {
  initAuthTokensTable,
  issueTokens,
  refreshAccessToken,
  revokeRefreshToken,
  AuthUserDisabledError,
} from '../auth/tokens.js';
import { verifyToken } from '../auth/jwt.js';
import { checkRateLimit, secondsUntilReset } from '../auth/rateLimiter.js';
import { createEmailToken, initEmailTokensTable } from '../auth/emailTokens.js';
import { isMfaEnabled, initMfaTable } from '../auth/mfa.js';
import { listAuthFields, validateProfileValues, type ProfileValues } from '../auth/authFields.js';
import { sendMail } from '../auth/mailer.js';
import { verificationEmail } from '../auth/emails.js';
import { getProject } from '../core/platformDb.js';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthUser } from '../auth/users.js';
import type { TokenPair } from '../auth/tokens.js';

interface MinimalResponse {
  status(code: number): MinimalResponse;
  json(data: unknown): void;
  raw: { setHeader(name: string, value: string): void };
}

// Helper: ambil DB project + pastikan tabel auth ada (lazy init)
function getAuthDb(projectId: string): DatabaseSync | null {
  try {
    const db = getProjectDb(projectId);
    initAuthUsersTable(db);
    initAuthTokensTable(db);
    initEmailTokensTable(db);
    initMfaTable(db); // M27
    return db;
  } catch {
    return null; // project tidak ada
  }
}

/**
 * M23: kirim email verifikasi setelah register — SEMUA error ditelan.
 * Respons register tidak boleh gagal karena SMTP down / outbox error.
 */
async function sendVerificationEmailQuietly(
  db: DatabaseSync,
  projectId: string,
  user: AuthUser,
  headers: Record<string, unknown>
): Promise<void> {
  try {
    if (user.verified) return; // user OAuth verified — skip
    initEmailTokensTable(db);
    const token = createEmailToken(db, user.id, 'verify');
    const host = String(headers['x-forwarded-host'] ?? headers['host'] ?? 'localhost');
    const proto = String(headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim();
    const url = `${proto}://${host}/api/p/${projectId}/auth/verify-email?token=${token}`;
    const tpl = verificationEmail(getProject(projectId)?.name ?? 'BaseForge', url);
    await sendMail({ to: user.email, subject: tpl.subject, text: tpl.text, html: tpl.html });
  } catch (err) {
    console.error('[mail] auto verification email failed:', err);
  }
}

// Helper: ambil IP client (dari X-Forwarded-For kalau ada proxy, atau remote address)
function clientIp(req: { headers: Record<string, unknown>; raw: { socket: { remoteAddress?: string } } }): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0].trim();
  }
  return req.raw.socket.remoteAddress ?? 'unknown';
}

// Helper: kirim response auth sukses (user + tokens)
function sendAuthSuccess(
  db: DatabaseSync,
  res: MinimalResponse,
  user: AuthUser,
  tokens: TokenPair,
  statusCode = 200
): void {
  res.status(statusCode).json({
    user: userPayload(db, user),
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
  });
}

/**
 * Ops-16: bentuk objek `user` untuk SEMUA respons auth (login, register,
 * refresh, GET /me, PATCH /me). Satu tempat — kalau field baru ditambahkan,
 * tidak ada respons yang ketinggalan (sebelumnya blok ini disalin 4x).
 */
function userPayload(db: DatabaseSync, user: AuthUser): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    verified: user.verified,
    mfaEnabled: isMfaEnabled(db, user.id),
    created: user.created,
    // Kunci `profile` HILANG bila tidak ada custom field terdefinisi →
    // respons byte-identical dengan sebelum Ops-16.
    ...(user.profile !== undefined ? { profile: user.profile } : {}),
  };
}

/**
 * Ops-15: respons seragam untuk akun yang dinonaktifkan admin.
 * 403 (bukan 401): kredensial/token-nya sah, yang ditolak adalah AKUN-nya —
 * klien bisa menampilkan "akun dinonaktifkan" alih-alih "password salah".
 */
export function respondUserDisabled(res: ForgeResponse): void {
  res.status(403).json({
    error: { code: 'USER_DISABLED', message: 'This account has been disabled' },
  });
}

export function createProjectAuthRouter(): Router {
  const router = new Router();

  // ─── REGISTER ────────────────────────────────────────────────────────────
  // POST /api/p/:pid/auth/register { email, password, name? }
  // → auto-login (dapat tokens langsung — keputusan desain M09u)
  router.post('/api/p/:pid/auth/register', async (req, res) => {
    const ip = clientIp(req);

    // Rate limit register juga (mencegah spam pendaftaran)
    // M18d: rate limiter async (Redis backend + memory fallback)
    if (!(await checkRateLimit(`register:${ip}`, 10, 60_000))) {
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' },
      });
      return;
    }

    const db = getAuthDb(req.params.pid);
    if (!db) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
      return;
    }

    const body = req.body as
      | { email?: string; password?: string; name?: string; profile?: unknown }
      | undefined;
    if (!body?.email || !body?.password) {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'email and password are required' },
      });
      return;
    }

    // Ops-16: validasi custom profile field SEBELUM user dibuat — kalau
    // divalidasi setelahnya, user gagal-validasi tetap tercipta.
    // Mode 'register' menegakkan `required`; mode 'update' tidak (lihat authFields.ts).
    let profile: ProfileValues | undefined;
    if (body.profile !== undefined) {
      if (typeof body.profile !== 'object' || body.profile === null || Array.isArray(body.profile)) {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'profile must be an object' },
        });
        return;
      }
      profile = body.profile as ProfileValues;
    }
    const authFields = listAuthFields(db);
    if (authFields.length > 0 || profile !== undefined) {
      const perr = validateProfileValues(authFields, profile ?? {}, 'register');
      if (perr) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: perr } });
        return;
      }
    }

    try {
      const user = createAuthUser(db, {
        email: body.email,
        password: body.password,
        name: body.name,
        profile,
      });

      const tokens = await issueTokens(db, user);
      sendAuthSuccess(db, res, user, tokens, 201);

      // M23: kirim email verifikasi otomatis (fire-and-forget —
      // kegagalan email TIDAK boleh menggagalkan register).
      // Outbox mode (tanpa SMTP) tetap menyimpan link — dev/test bisa ambil.
      sendVerificationEmailQuietly(db, req.params.pid, user, req.headers).catch(() => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Registration failed';
      if (/already registered/i.test(message)) {
        res.status(409).json({ error: { code: 'EMAIL_TAKEN', message } });
        return;
      }
      // Password lemah / email invalid → 400
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message } });
    }
  });

  // ─── LOGIN ───────────────────────────────────────────────────────────────
  // POST /api/p/:pid/auth/login { email, password }
  // Pesan error SERAGAM (anti user enumeration — M08)
  router.post('/api/p/:pid/auth/login', async (req, res) => {
    const ip = clientIp(req);

    // Rate limit: 10 percobaan/menit per IP
    // M18d: rate limiter async (Redis backend + memory fallback)
    if (!(await checkRateLimit(`login:${ip}`, 10, 60_000))) {
      const retryAfter = await secondsUntilReset(`login:${ip}`);
      res.raw.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: `Too many attempts. Please try again in ${retryAfter} seconds.`,
        },
      });
      return;
    }

    const db = getAuthDb(req.params.pid);
    if (!db) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
      return;
    }

    const body = req.body as { email?: string; password?: string } | undefined;
    if (!body?.email || !body?.password) {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'email and password are required' },
      });
      return;
    }

    // Pesan SERAGAM: email tidak terdaftar & password salah = pesan sama
    const user = verifyAuthCredentials(db, body.email, body.password);
    if (!user) {
      res.status(401).json({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
      });
      return;
    }

    // Ops-15: dicek SEBELUM MFA — akun disabled tidak boleh menerima mfaToken
    // sekalipun (itu setengah sesi). Kredensial benar → 403, bukan 401.
    if (user.disabled) {
      respondUserDisabled(res);
      return;
    }

    // M27: MFA aktif → JANGAN terbitkan token. Login "setengah berhasil":
    // password benar (bukti faktor-1), beri mfaToken pendek umur untuk
    // challenge. Token penuh hanya setelah kode TOTP/recovery benar.
    if (isMfaEnabled(db, user.id)) {
      const mfaToken = createEmailToken(db, user.id, 'mfa'); // 5 menit, sekali sukses
      res.status(200).json({
        mfaRequired: true,
        mfaToken,
        message: 'MFA verification required — POST /auth/mfa/challenge { mfaToken, token }',
      });
      return;
    }

    const tokens = await issueTokens(db, user);
    sendAuthSuccess(db, res, user, tokens, 200);
  });

  // ─── REFRESH ─────────────────────────────────────────────────────────────
  // POST /api/p/:pid/auth/refresh { refreshToken }
  router.post('/api/p/:pid/auth/refresh', async (req, res) => {
    const db = getAuthDb(req.params.pid);
    if (!db) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
      return;
    }

    const body = req.body as { refreshToken?: string } | undefined;
    if (!body?.refreshToken) {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'refreshToken is required' },
      });
      return;
    }

    let tokens;
    try {
      tokens = await refreshAccessToken(db, body.refreshToken);
    } catch (err) {
      if (err instanceof AuthUserDisabledError) {
        respondUserDisabled(res); // Ops-15
        return;
      }
      throw err;
    }
    if (!tokens) {
      res.status(401).json({
        error: { code: 'INVALID_REFRESH', message: 'Refresh token is invalid or expired' },
      });
      return;
    }

    // Ops-10: sertakan `user` agar klien bisa merekonstruksi sesi penuh dari
    // SATU panggilan refresh — paritas dengan auth-collection `auth-refresh`
    // yang mengembalikan `record`. Tambahan field, jadi backward-compatible.
    const refreshed = await verifyToken(tokens.accessToken);
    const user = refreshed.valid && refreshed.payload
      ? findAuthUserById(db, refreshed.payload.sub)
      : undefined;

    res.status(200).json({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      ...(user ? { user: userPayload(db, user) } : {}),
    });
  });

  // ─── ME ──────────────────────────────────────────────────────────────────
  // GET /api/p/:pid/auth/me (Authorization: Bearer <accessToken>)
  router.get('/api/p/:pid/auth/me', async (req, res) => {
    const db = getAuthDb(req.params.pid);
    if (!db) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
      return;
    }

    // Verifikasi JWT access token
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' } });
      return;
    }

    const result = await verifyToken(token);
    if (!result.valid) {
      const reason = result.reason === 'expired' ? 'Token kedaluwarsa' : 'Invalid token';
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: reason } });
      return;
    }
    if (!result.payload) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token' } });
      return;
    }

    // Ambil user dari DB (data terbaru — bukan hanya dari payload JWT)
    const user = findAuthUserById(db, result.payload.sub);
    if (!user) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'User not found' } });
      return;
    }

    res.json({ user: userPayload(db, user) });
  });

  // ─── UPDATE PROFIL SENDIRI (Ops-9) ───────────────────────────────────────
  // PATCH /api/p/:pid/auth/me { name?, avatarUrl? }
  //
  // Paritas dengan auth collection (surface B): di sana profil bisa di-update
  // lewat PATCH record biasa. Tanpa ini, konsolidasi ke surface A akan memaksa
  // aplikasi klien kehilangan kemampuan — melanggar aturan "kekurangan
  // BaseForge diperbaiki di backend, bukan frontend yang menyesuaikan".
  router.patch('/api/p/:pid/auth/me', async (req, res) => {
    const db = getAuthDb(req.params.pid);
    if (!db) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
      return;
    }

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' } });
      return;
    }

    const result = await verifyToken(token);
    if (!result.valid || !result.payload) {
      const reason = result.reason === 'expired' ? 'Token kedaluwarsa' : 'Invalid token';
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: reason } });
      return;
    }

    const body = req.body as
      | { name?: unknown; avatarUrl?: unknown; profile?: unknown }
      | undefined;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Body must be an object' } });
      return;
    }

    // Tolak field yang punya jalur terverifikasi sendiri — jangan diam-diam diabaikan.
    for (const forbidden of ['email', 'password', 'verified', 'disabled', 'id']) {
      if (forbidden in body) {
        res.status(400).json({
          error: {
            code: 'BAD_REQUEST',
            message: `Field '${forbidden}' cannot be changed here`,
          },
        });
        return;
      }
    }

    const updates: { name?: string | null; avatarUrl?: string | null; profile?: ProfileValues } = {};

    if ('name' in body) {
      const n = body.name;
      if (n !== null && typeof n !== 'string') {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'name must be a string or null' } });
        return;
      }
      if (typeof n === 'string' && n.length > 255) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'name must be 255 characters or fewer' } });
        return;
      }
      updates.name = n;
    }

    if ('avatarUrl' in body) {
      const a = body.avatarUrl;
      if (a !== null && typeof a !== 'string') {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'avatarUrl must be a string or null' } });
        return;
      }
      if (typeof a === 'string' && a.length > 2048) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'avatarUrl must be 2048 characters or fewer' } });
        return;
      }
      updates.avatarUrl = a;
    }

    // ─── Ops-16: custom profile field ────────────────────────────────────────
    if ('profile' in body && body.profile !== undefined) {
      if (typeof body.profile !== 'object' || body.profile === null || Array.isArray(body.profile)) {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'profile must be an object' },
        });
        return;
      }
      const incoming = body.profile as ProfileValues;
      const fields = listAuthFields(db);

      // Field ber-userEditable=false adalah padanan `app_metadata` Supabase:
      // hanya Admin API yang boleh mengubahnya. Ditolak KERAS (403), bukan
      // diabaikan diam-diam — mengabaikan membuat klien mengira perubahannya
      // tersimpan (pelajaran Ops-9: penolakan senyap = 200 yang berbohong).
      for (const key of Object.keys(incoming)) {
        const f = fields.find((x) => x.name === key);
        if (f && !f.userEditable) {
          res.status(403).json({
            error: {
              code: 'FIELD_NOT_EDITABLE',
              message: `Field '${key}' can only be changed by an administrator`,
            },
          });
          return;
        }
      }

      // Mode 'update': `required` TIDAK ditegakkan — user lama yang belum
      // pernah mengisi field baru tetap bisa mengubah namanya sendiri.
      const perr = validateProfileValues(fields, incoming, 'update');
      if (perr) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: perr } });
        return;
      }
      updates.profile = incoming;
    }

    const user = updateAuthUserProfile(db, result.payload.sub, updates);
    if (!user) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'User not found' } });
      return;
    }

    res.json({ user: userPayload(db, user) });
  });

  // ─── LOGOUT ──────────────────────────────────────────────────────────────
  // POST /api/p/:pid/auth/logout { refreshToken }
  router.post('/api/p/:pid/auth/logout', (req, res) => {
    const db = getAuthDb(req.params.pid);
    if (!db) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
      return;
    }

    const body = req.body as { refreshToken?: string } | undefined;
    if (!body?.refreshToken) {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'refreshToken is required' },
      });
      return;
    }

    revokeRefreshToken(db, body.refreshToken);
    res.json({ success: true });
  });

  return router;
}
