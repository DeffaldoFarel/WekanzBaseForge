// ============================================================================
// M10: OAUTH2 ROUTES — authorize + callback + admin config CRUD
//
// End-user (per project):
//   GET /api/p/:pid/auth/oauth/:provider/authorize[?redirect_to=...]
//     → 302 ke consent screen provider (state anti-CSRF dibuat di sini)
//   GET /api/p/:pid/auth/oauth/:provider/callback?code=...&state=...
//     → tukar code, find-or-create user, issue tokens
//     → 302 {redirect_to}#access_token=... (atau JSON bila tanpa redirect_to)
//
// Admin (untuk dashboard):
//   GET    /api/admin/projects/:pid/auth/providers
//   PUT    /api/admin/projects/:pid/auth/providers/:provider
//   DELETE /api/admin/projects/:pid/auth/providers/:provider
// ============================================================================

import { Router, type ForgeResponse } from '../core/router.js';
import { requireAdmin } from '../platform/adminAuth.js';
import { getProjectDb } from '../core/projectDbManager.js';
import { checkRateLimit } from '../auth/rateLimiter.js';
import { issueTokens, initAuthTokensTable } from '../auth/tokens.js';
import { initAuthUsersTable } from '../auth/users.js';
import { findOrCreateOAuthUser, initAuthIdentitiesTable } from '../auth/identities.js';
import {
  OAUTH_PROVIDER_DEFS,
  OAuthError,
  buildAuthorizeUrl,
  callbackUrlFromRequest,
  consumeOAuthState,
  createOAuthState,
  deleteOAuthProvider,
  exchangeCodeForTokens,
  getOAuthProvider,
  initOAuthTables,
  isOAuthProvider,
  listOAuthProviders,
  upsertOAuthProvider,
} from '../auth/oauth.js';
import type { DatabaseSync } from 'node:sqlite';
import type { AuthUser } from '../auth/users.js';
import type { TokenPair } from '../auth/tokens.js';
// ─── Helpers ─────────────────────────────────────────────────────────────────

function getOAuthDb(projectId: string): DatabaseSync | null {
  try {
    const db = getProjectDb(projectId);
    // Semua tabel auth harus siap: user (M08), tokens (M09), OAuth (M10)
    initAuthUsersTable(db);
    initAuthTokensTable(db);
    initOAuthTables(db);
    initAuthIdentitiesTable(db);
    return db;
  } catch {
    return null; // project tidak ada
  }
}

function clientIp(req: { headers: Record<string, unknown>; raw: { socket: { remoteAddress?: string } } }): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0].trim();
  }
  return req.raw.socket.remoteAddress ?? 'unknown';
}

/** Validasi redirect_to: harus URL http(s); origin harus cocok allow-list (jika diisi). */
function validateRedirectTo(raw: string | null, allowedOrigins: string[]): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null; // invalid → diabaikan (fallback JSON), bukan error — UX konservatif
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (allowedOrigins.length > 0) {
    const origin = url.origin;
    if (!allowedOrigins.includes(origin)) return null;
  }
  return url.toString();
}

function sendRedirect(res: ForgeResponse, location: string): void {
  res.raw.writeHead(302, { Location: location });
  res.raw.end();
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function createOAuthRouter(): Router {
  const router = new Router();

  // ─── AUTHORIZE: browser dikirim ke consent screen provider ──────────────────
  router.get('/api/p/:pid/auth/oauth/:provider/authorize', async (req, res) => {
    const ip = clientIp(req);
    const { pid, provider } = req.params;

    if (!(await checkRateLimit(`oauth-auth:${ip}:${provider}`, 30, 60_000))) {
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many OAuth requests. Please try again later.' },
      });
      return;
    }

    const db = getOAuthDb(pid);
    if (!db) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
      return;
    }

    if (!isOAuthProvider(provider)) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: `Unknown provider '${provider}'` } });
      return;
    }

    const cfg = getOAuthProvider(db, provider, { mustBeEnabled: true });
    if (!cfg) {
      res.status(404).json({
        error: { code: 'PROVIDER_NOT_CONFIGURED', message: `OAuth provider '${provider}' is not configured for this project` },
      });
      return;
    }

    // redirect_to opsional — kirim user + tokens ke sini setelah sukses
    const redirectTo = validateRedirectTo(
      req.query.get('redirect_to'),
      cfg.allowedOrigins
    );

    const state = createOAuthState(db, provider, redirectTo);
    const callbackUrl = callbackUrlFromRequest(provider, pid, req.headers, cfg.callbackUrlOverride);

    sendRedirect(res, buildAuthorizeUrl(provider, cfg.clientId, callbackUrl, state));
  });

  // ─── CALLBACK: provider mengembalikan code + state ──────────────────────────
  router.get('/api/p/:pid/auth/oauth/:provider/callback', async (req, res) => {
    const ip = clientIp(req);
    const { pid, provider } = req.params;

    if (!(await checkRateLimit(`oauth-cb:${ip}:${provider}`, 30, 60_000))) {
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many OAuth requests. Please try again later.' },
      });
      return;
    }

    const db = getOAuthDb(pid);
    if (!db) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
      return;
    }

    if (!isOAuthProvider(provider)) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: `Unknown provider '${provider}'` } });
      return;
    }

    const cfg = getOAuthProvider(db, provider);
    if (!cfg) {
      res.status(404).json({ error: { code: 'PROVIDER_NOT_CONFIGURED', message: `OAuth provider '${provider}' is not configured` } });
      return;
    }

    const code = req.query.get('code');
    const state = req.query.get('state');
    // Provider mengirim error di query (user menolak consent, dsb.)
    const providerError = req.query.get('error');

    if (!code || !state || providerError) {
      res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: providerError
            ? `Provider rejected the request: ${providerError}`
            : 'code and state parameters are required',
        },
      });
      return;
    }

    // State harus valid & SATU KALI PAKAI (anti CSRF + anti replay)
    const stateInfo = consumeOAuthState(db, state, provider);
    if (!stateInfo) {
      res.status(400).json({
        error: { code: 'BAD_STATE', message: 'State is invalid, expired, or already used' },
      });
      return;
    }

    try {
      // 1. Tukar code → access_token provider
      const callbackUrl = callbackUrlFromRequest(provider, pid, req.headers, cfg.callbackUrlOverride);
      const providerAccessToken = await exchangeCodeForTokens(
        provider, code, cfg.clientId, cfg.clientSecret, callbackUrl
      );

      // 2. Profil user dari provider
      const profile = await OAUTH_PROVIDER_DEFS[provider].fetchProfile(providerAccessToken);

      // 3. Find-or-create + linking aman (identities.ts)
      const { user } = findOrCreateOAuthUser(db, profile);

      // 4. Issue token pair BaseForge (JWT M09 — kontrak sama dengan login biasa)
      const tokens = await issueTokens(db, user);

      // 5. Kirim tokens: redirect (browser SPA) atau JSON (non-browser/test)
      if (stateInfo.redirectTo) {
        const frag = new URLSearchParams({
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          expires_in: String(tokens.expiresIn),
        });
        const sep = stateInfo.redirectTo.includes('#') ? '&' : '#';
        sendRedirect(res, `${stateInfo.redirectTo}${sep}${frag.toString()}`);
        return;
      }

      sendOAuthSuccess(res, user, tokens);
    } catch (err) {
      if (err instanceof OAuthError) {
        const status =
          err.code === 'EMAIL_UNVERIFIED_CONFLICT' ? 409 : 400;
        res.status(status).json({ error: { code: err.code, message: err.message } });
        return;
      }
      throw err; // error boundary router → 500
    }
  });

  // ─── ADMIN: konfigurasi provider (dashboard) ────────────────────────────────

  router.get('/api/admin/projects/:pid/auth/providers', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      initOAuthTables(db);
      res.json({ providers: listOAuthProviders(db) });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  router.put('/api/admin/projects/:pid/auth/providers/:provider', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      initOAuthTables(db);
      const provider = req.params.provider;
      if (!isOAuthProvider(provider)) {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: `Provider must be one of: ${Object.keys(OAUTH_PROVIDER_DEFS).join(', ')}` },
        });
        return;
      }

      const body = (req.body ?? {}) as {
        clientId?: string; clientSecret?: string; enabled?: boolean;
        callbackUrl?: string; allowedOrigins?: string[] | string;
      };
      const allowedOrigins = Array.isArray(body.allowedOrigins)
        ? body.allowedOrigins
        : typeof body.allowedOrigins === 'string'
          ? body.allowedOrigins.split(',').map((s) => s.trim()).filter(Boolean)
          : [];

      upsertOAuthProvider(db, {
        provider,
        clientId: body.clientId ?? '',
        clientSecret: body.clientSecret,
        enabled: body.enabled ?? true,
        callbackUrlOverride: body.callbackUrl ?? null,
        allowedOrigins,
      });

      // Balas TANPA secret (hanya indikasi configured)
      const cfg = getOAuthProvider(db, provider)!;
      res.json({
        provider: {
          provider: cfg.provider,
          clientId: cfg.clientId,
          enabled: cfg.enabled,
          callbackUrl: cfg.callbackUrlOverride,
          allowedOrigins: cfg.allowedOrigins,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  router.delete('/api/admin/projects/:pid/auth/providers/:provider', requireAdmin, (req, res) => {
    try {
      const db = getProjectDb(req.params.pid);
      initOAuthTables(db);
      const ok = deleteOAuthProvider(db, req.params.provider);
      if (!ok) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Provider not found' } });
        return;
      }
      res.status(200).json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  return router;
}

// ─── Response helper (kontrak sama dengan authRoutes M09u) ───────────────────

function sendOAuthSuccess(res: ForgeResponse, user: AuthUser, tokens: TokenPair): void {
  res.status(200).json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      verified: user.verified,
      created: user.created,
    },
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
  });
}
