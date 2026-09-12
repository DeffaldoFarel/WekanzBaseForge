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
import { getProjectDb } from '../core/projectDbManager.js';
import {
  initAuthUsersTable,
  createAuthUser,
  verifyAuthCredentials,
  findAuthUserById,
} from '../auth/users.js';
import {
  initAuthTokensTable,
  issueTokens,
  refreshAccessToken,
  revokeRefreshToken,
} from '../auth/tokens.js';
import { verifyToken } from '../auth/jwt.js';
import { checkRateLimit, secondsUntilReset } from '../auth/rateLimiter.js';
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
    return db;
  } catch {
    return null; // project tidak ada
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
  res: MinimalResponse,
  user: AuthUser,
  tokens: TokenPair,
  statusCode = 200
): void {
  res.status(statusCode).json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      verified: user.verified,
      created: user.created,
    },
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
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
        error: { code: 'RATE_LIMITED', message: 'Terlalu banyak percobaan. Coba lagi nanti.' },
      });
      return;
    }

    const db = getAuthDb(req.params.pid);
    if (!db) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project tidak ditemukan' } });
      return;
    }

    const body = req.body as { email?: string; password?: string; name?: string } | undefined;
    if (!body?.email || !body?.password) {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'email dan password wajib diisi' },
      });
      return;
    }

    try {
      const user = createAuthUser(db, {
        email: body.email,
        password: body.password,
        name: body.name,
      });

      const tokens = await issueTokens(db, user);
      sendAuthSuccess(res, user, tokens, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Gagal mendaftar';
      if (/sudah terdaftar/i.test(message)) {
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
          message: `Terlalu banyak percobaan. Coba lagi dalam ${retryAfter} detik.`,
        },
      });
      return;
    }

    const db = getAuthDb(req.params.pid);
    if (!db) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project tidak ditemukan' } });
      return;
    }

    const body = req.body as { email?: string; password?: string } | undefined;
    if (!body?.email || !body?.password) {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'email dan password wajib diisi' },
      });
      return;
    }

    // Pesan SERAGAM: email tidak terdaftar & password salah = pesan sama
    const user = verifyAuthCredentials(db, body.email, body.password);
    if (!user) {
      res.status(401).json({
        error: { code: 'INVALID_CREDENTIALS', message: 'Email atau password salah' },
      });
      return;
    }

    const tokens = await issueTokens(db, user);
    sendAuthSuccess(res, user, tokens, 200);
  });

  // ─── REFRESH ─────────────────────────────────────────────────────────────
  // POST /api/p/:pid/auth/refresh { refreshToken }
  router.post('/api/p/:pid/auth/refresh', async (req, res) => {
    const db = getAuthDb(req.params.pid);
    if (!db) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project tidak ditemukan' } });
      return;
    }

    const body = req.body as { refreshToken?: string } | undefined;
    if (!body?.refreshToken) {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'refreshToken wajib diisi' },
      });
      return;
    }

    const tokens = await refreshAccessToken(db, body.refreshToken);
    if (!tokens) {
      res.status(401).json({
        error: { code: 'INVALID_REFRESH', message: 'Refresh token tidak valid atau kedaluwarsa' },
      });
      return;
    }

    res.status(200).json({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
    });
  });

  // ─── ME ──────────────────────────────────────────────────────────────────
  // GET /api/p/:pid/auth/me (Authorization: Bearer <accessToken>)
  router.get('/api/p/:pid/auth/me', async (req, res) => {
    const db = getAuthDb(req.params.pid);
    if (!db) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project tidak ditemukan' } });
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
      const reason = result.reason === 'expired' ? 'Token kedaluwarsa' : 'Token tidak valid';
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: reason } });
      return;
    }
    if (!result.payload) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Token tidak valid' } });
      return;
    }

    // Ambil user dari DB (data terbaru — bukan hanya dari payload JWT)
    const user = findAuthUserById(db, result.payload.sub);
    if (!user) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'User tidak ditemukan' } });
      return;
    }

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        verified: user.verified,
        created: user.created,
      },
    });
  });

  // ─── LOGOUT ──────────────────────────────────────────────────────────────
  // POST /api/p/:pid/auth/logout { refreshToken }
  router.post('/api/p/:pid/auth/logout', (req, res) => {
    const db = getAuthDb(req.params.pid);
    if (!db) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project tidak ditemukan' } });
      return;
    }

    const body = req.body as { refreshToken?: string } | undefined;
    if (!body?.refreshToken) {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'refreshToken wajib diisi' },
      });
      return;
    }

    revokeRefreshToken(db, body.refreshToken);
    res.json({ success: true });
  });

  return router;
}
