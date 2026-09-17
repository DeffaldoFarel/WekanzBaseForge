// ============================================================================
// M23: EMAIL ROUTES — verifikasi email & reset password + admin mail settings
//
// Endpoint publik (per project, prefix /api/p/:pid/auth):
//   POST request-verification      { email? }        → selalu 200 (anti enum)
//   GET  verify-email?token&redir  → konsumsi + 302 / halaman sukses HTML
//   POST verify-email              { token }         → JSON (untuk SDK)
//   POST request-password-reset    { email? }        → selalu 200 (anti enum)
//   GET  confirm-password-reset?token&redir → peek + 302 #reset_token / form HTML
//   POST confirm-password-reset    { token, password } → reset + logout semua device
//
// Admin (platform-level):
//   GET/PUT/DELETE /api/admin/settings/mail         → konfigurasi SMTP
//   POST /api/admin/settings/mail/test { to }       → kirim email tes
//   GET/DELETE /api/admin/settings/mail/outbox      → outbox mode dev
//
// Keamanan:
//   - anti user-enumeration: request-* selalu 200 tanpa membocorkan keberadaan email
//   - token sekali pakai (emailTokens) + TTL (verify 24j / reset 1j)
//   - reset password = revoke SEMUA refresh token user (logout semua device)
//   - rate limit 5/15 menit per IP utk kedua endpoint request-*
// ============================================================================

import crypto from 'node:crypto';
import { Router, type ForgeResponse } from '../core/router.js';
import { requireAdmin } from '../platform/adminAuth.js';
import { getProjectDb } from '../core/projectDbManager.js';
import { getProject } from '../core/platformDb.js';
import { checkRateLimit } from '../auth/rateLimiter.js';
import { verifyToken } from '../auth/jwt.js';
import { revokeAllUserTokens } from '../auth/tokens.js';
import { initAuthUsersTable, findAuthUserByEmail, findAuthUserById, changeAuthUserPassword } from '../auth/users.js';
import { createEmailToken, consumeEmailToken, initEmailTokensTable } from '../auth/emailTokens.js';
import { sendMail, resolveMailConfig, saveMailSettings, clearMailSettings, mailConfigPublic, resetTransporter, listOutbox, clearOutbox, DEFAULT_MAIL_FROM } from '../auth/mailer.js';
import { verificationEmail, passwordResetEmail, testEmail } from '../auth/emails.js';
import type { DatabaseSync } from 'node:sqlite';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clientIp(req: { headers: Record<string, unknown>; raw: { socket: { remoteAddress?: string } } }): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0].trim();
  }
  return req.raw.socket.remoteAddress ?? 'unknown';
}

/** Base URL API dari request (proxy-aware) — dipakai untuk membangun link email. */
function apiBaseUrl(headers: Record<string, unknown>): string {
  const host = String(headers['x-forwarded-host'] ?? headers['host'] ?? 'localhost');
  const proto = String(headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim();
  return `${proto}://${host}`;
}

function getAuthDb(projectId: string): DatabaseSync | null {
  try {
    const db = getProjectDb(projectId);
    initAuthUsersTable(db);
    initEmailTokensTable(db);
    return db;
  } catch {
    return null;
  }
}

function projectName(pid: string): string {
  return getProject(pid)?.name ?? 'BaseForge';
}

function validateHttpUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function sendRedirect(res: ForgeResponse, location: string): void {
  res.raw.writeHead(302, { Location: location });
  res.raw.end();
}

function htmlPage(res: ForgeResponse, status: number, title: string, messageHtml: string): void {
  res.raw.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.raw.end(`<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:Inter,system-ui,-apple-system,sans-serif;">
  <div style="max-width:440px;margin:0 auto;padding:48px 24px;">
    <div style="color:#fafafa;font-size:18px;font-weight:600;margin-bottom:24px;">
      wekanz<span style="color:#9e9e9e;">BaseForge</span>
    </div>
    <div style="background:#121212;border:1px solid #292929;border-radius:10px;padding:24px;">
      <h1 style="color:#ededed;font-size:17px;font-weight:600;margin:0 0 10px 0;">${title}</h1>
      <div style="color:#9e9e9e;font-size:14px;line-height:1.6;">${messageHtml}</div>
    </div>
  </div>
</body>
</html>`);
}

/** Kirim email verifikasi/reset; error pengiriman DIBUNGKAM (anti-enum + ops). */
async function sendActionEmail(
  kind: 'verify' | 'reset',
  pid: string,
  to: string,
  headers: Record<string, unknown>,
  redirectTo: string | null
): Promise<void> {
  const db = getAuthDb(pid);
  if (!db) return;
  const user = findAuthUserByEmail(db, to);
  if (!user) return; // email tidak ada → email tidak dikirim, respons tetap 200

  if (kind === 'verify' && user.verified) return; // sudah verified → skip

  const base = apiBaseUrl(headers);
  const token = createEmailToken(db, user.id, kind === 'verify' ? 'verify' : 'reset');
  const redirectQ = redirectTo ? `&redirect_to=${encodeURIComponent(redirectTo)}` : '';

  if (kind === 'verify') {
    const url = `${base}/api/p/${pid}/auth/verify-email?token=${token}${redirectQ}`;
    const tpl = verificationEmail(projectName(pid), url);
    await sendMail({ to: user.email, subject: tpl.subject, text: tpl.text, html: tpl.html });
  } else {
    const url = `${base}/api/p/${pid}/auth/confirm-password-reset?token=${token}${redirectQ}`;
    const tpl = passwordResetEmail(projectName(pid), url);
    await sendMail({ to: user.email, subject: tpl.subject, text: tpl.text, html: tpl.html });
  }
}

/** Resolve end-user dari Bearer token (untuk request-verification tanpa email). */
async function resolveAuthUser(db: DatabaseSync, req: { headers: Record<string, unknown> }): Promise<string | null> {
  const auth = String(req.headers['authorization'] ?? '');
  if (!auth.startsWith('Bearer ')) return null;
  const result = await verifyToken(auth.slice(7));
  if (!result.valid || !result.payload?.sub) return null;
  return result.payload.sub;
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function createEmailRouter(): Router {
  const router = new Router();

  // ═══════════════ PUBLIC: EMAIL VERIFICATION ═══════════════

  // POST /api/p/:pid/auth/request-verification { email? } — anti-enumeration
  router.post('/api/p/:pid/auth/request-verification', async (req, res) => {
    const ip = clientIp(req);
    if (!(await checkRateLimit(`mail-verify:${ip}`, 5, 15 * 60_000))) {
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again in 15 minutes.' },
      });
      return;
    }

    const db = getAuthDb(req.params.pid);
    if (!db) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
      return;
    }

    // Email dari body, atau dari token login (self-request)
    const body = (req.body ?? {}) as { email?: string; redirectTo?: string };
    let email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email) {
      const uid = await resolveAuthUser(db, req);
      if (uid) {
        const user = findAuthUserById(db, uid);
        email = user?.email ?? '';
      }
    }

    const redirectTo = validateHttpUrl(body.redirectTo ?? null);

    // SELalu 200 — email tidak ada pun respons sama (anti user enumeration)
    try {
      await sendActionEmail('verify', req.params.pid, email, req.headers, redirectTo);
    } catch (err) {
      console.error('[mail] verification send failed:', err); // ops error → dibungkam
    }
    res.status(200).json({
      message: 'If the email address is registered, a verification link has been sent.',
    });
  });

  // GET /api/p/:pid/auth/verify-email?token=...&redirect_to=... (link dari email)
  router.get('/api/p/:pid/auth/verify-email', (req, res) => {
    const db = getAuthDb(req.params.pid);
    if (!db) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
      return;
    }

    const token = req.query.get('token');
    if (!token) {
      htmlPage(res, 400, 'Invalid link', 'Verification token is missing.');
      return;
    }

    const consumed = consumeEmailToken(db, token, 'verify');
    if (!consumed) {
      htmlPage(res, 400, 'Link expired', 'This verification link is invalid, expired, or already used. Request a new one from your app.');
      return;
    }

    // Tandai verified=1
    db.prepare(
      `UPDATE _auth_users SET verified = 1, updated = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ).run(consumed.userId);
    const user = findAuthUserById(db, consumed.userId);

    // redirect ke aplikasi bila disertakan
    const redirectTo = validateHttpUrl(req.query.get('redirect_to'));
    if (redirectTo) {
      const sep = redirectTo.includes('?') ? '&' : '?';
      sendRedirect(res, `${redirectTo}${sep}verified=true`);
      return;
    }

    htmlPage(res, 200, 'Email verified',
      `Your email <strong style="color:#ededed;">${user?.email ?? ''}</strong> has been verified. You can return to the application.`);
  });

  // POST /api/p/:pid/auth/verify-email { token } — untuk SDK
  router.post('/api/p/:pid/auth/verify-email', (req, res) => {
    const db = getAuthDb(req.params.pid);
    if (!db) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
      return;
    }

    const body = (req.body ?? {}) as { token?: string };
    const consumed = body.token ? consumeEmailToken(db, body.token, 'verify') : null;
    if (!consumed) {
      res.status(400).json({
        error: { code: 'INVALID_TOKEN', message: 'Verification token is invalid, expired, or already used' },
      });
      return;
    }

    db.prepare(
      `UPDATE _auth_users SET verified = 1, updated = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ).run(consumed.userId);
    res.json({ ok: true, message: 'Email verified successfully' });
  });

  // ═══════════════ PUBLIC: PASSWORD RESET ═══════════════

  // POST /api/p/:pid/auth/request-password-reset { email? } — anti-enumeration
  router.post('/api/p/:pid/auth/request-password-reset', async (req, res) => {
    const ip = clientIp(req);
    if (!(await checkRateLimit(`mail-reset:${ip}`, 5, 15 * 60_000))) {
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again in 15 minutes.' },
      });
      return;
    }

    const db = getAuthDb(req.params.pid);
    if (!db) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
      return;
    }

    const body = (req.body ?? {}) as { email?: string; redirectTo?: string };
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const redirectTo = validateHttpUrl(body.redirectTo ?? null);

    try {
      await sendActionEmail('reset', req.params.pid, email, req.headers, redirectTo);
    } catch (err) {
      console.error('[mail] reset send failed:', err);
    }
    res.status(200).json({
      message: 'If the email address is registered, a password reset link has been sent.',
    });
  });

  // GET /api/p/:pid/auth/confirm-password-reset?token=...&redirect_to=...
  // Token hanya di-PEEK (belum dikonsumsi) — konsumsi terjadi saat password baru diset.
  router.get('/api/p/:pid/auth/confirm-password-reset', (req, res) => {
    const db = getAuthDb(req.params.pid);
    if (!db) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
      return;
    }

    const token = req.query.get('token');
    if (!token) {
      htmlPage(res, 400, 'Invalid link', 'Reset token is missing.');
      return;
    }

    // Peek: valid tanpa konsumsi (token dipakai ulang saat POST form)
    const peek = peekEmailToken(db, token, 'reset');
    if (!peek) {
      htmlPage(res, 400, 'Link expired', 'This reset link is invalid, expired, or already used. Request a new one.');
      return;
    }

    // Redirect ke halaman form aplikasi (token via fragment)
    const redirectTo = validateHttpUrl(req.query.get('redirect_to'));
    if (redirectTo) {
      const sep = redirectTo.includes('#') ? '&' : '#';
      sendRedirect(res, `${redirectTo}${sep}reset_token=${token}`);
      return;
    }

    // Tanpa redirect_to → form HTML self-contained (POST via fetch, token hidden)
    res.raw.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.raw.end(`<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:Inter,system-ui,-apple-system,sans-serif;">
  <div style="max-width:440px;margin:0 auto;padding:48px 24px;">
    <div style="color:#fafafa;font-size:18px;font-weight:600;margin-bottom:24px;">
      wekanz<span style="color:#9e9e9e;">BaseForge</span>
    </div>
    <div style="background:#121212;border:1px solid #292929;border-radius:10px;padding:24px;">
      <h1 style="color:#ededed;font-size:17px;font-weight:600;margin:0 0 16px 0;">Set a new password</h1>
      <form id="f" style="display:flex;flex-direction:column;gap:12px;">
        <input id="pw" type="password" placeholder="New password (min 8 characters)" autocomplete="new-password"
               style="background:#0a0a0a;border:1px solid #292929;color:#ededed;border-radius:8px;padding:10px 12px;font-size:14px;outline:none;">
        <button type="submit"
                style="background:#fafafa;color:#0a0a0a;border:0;border-radius:8px;padding:10px 16px;font-size:14px;font-weight:500;cursor:pointer;">
          Reset Password
        </button>
      </form>
      <p id="msg" style="color:#9e9e9e;font-size:13px;line-height:1.6;margin:16px 0 0 0;"></p>
    </div>
  </div>
  <script>
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pw = document.getElementById('pw').value;
      const msg = document.getElementById('msg');
      msg.textContent = 'Sending…';
      try {
        const res = await fetch('${req.path}', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: ${JSON.stringify(token)}, password: pw }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          msg.innerHTML = 'Password updated. You are now signed out from all devices. You can close this page.';
        } else {
          msg.textContent = (data.error && data.error.message) || 'Reset failed.';
        }
      } catch {
        msg.textContent = 'Network error — please try again.';
      }
    });
  </script>
</body>
</html>`);
  });

  // POST /api/p/:pid/auth/confirm-password-reset { token, password }
  router.post('/api/p/:pid/auth/confirm-password-reset', (req, res) => {
    const db = getAuthDb(req.params.pid);
    if (!db) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found' } });
      return;
    }

    const body = (req.body ?? {}) as { token?: string; password?: string };
    if (!body.token || !body.password) {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'token and password are required' },
      });
      return;
    }

    const consumed = consumeEmailToken(db, body.token, 'reset');
    if (!consumed) {
      res.status(400).json({
        error: { code: 'INVALID_TOKEN', message: 'Reset token is invalid, expired, or already used' },
      });
      return;
    }

    // Password baru (validasi kekuatan via changeAuthUserPassword — M08)
    try {
      const ok = changeAuthUserPassword(db, consumed.userId, body.password);
      if (!ok) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found' } });
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid password';
      res.status(400).json({ error: { code: 'WEAK_PASSWORD', message } });
      return;
    }

    // Keamanan: reset = logout dari SEMUA device (revoke refresh tokens M09)
    const revoked = revokeAllUserTokens(db, consumed.userId);

    res.json({
      ok: true,
      message: 'Password updated successfully. All other sessions have been revoked.',
      revokedSessions: revoked,
    });
  });

  // ═══════════════ ADMIN: MAIL SETTINGS (platform-level) ═══════════════

  router.get('/api/admin/settings/mail', requireAdmin, (req, res) => {
    res.json({
      config: mailConfigPublic(),
      mode: resolveMailConfig() ? 'smtp' : 'outbox',
    });
  });

  router.put('/api/admin/settings/mail', requireAdmin, (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        host?: string; port?: number; secure?: boolean;
        user?: string; pass?: string; from?: string;
      };
      if (!body.host?.trim()) {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'host is required' },
        });
        return;
      }
      saveMailSettings({
        host: body.host.trim(),
        port: body.port ?? 587,
        secure: body.secure ?? false,
        user: body.user ?? '',
        pass: body.pass, // kosong = keep existing
        from: body.from?.trim() || DEFAULT_MAIL_FROM,
      });
      resetTransporter(); // config berubah → koneksi lama tidak dipakai lagi
      res.json({ config: mailConfigPublic(), mode: 'smtp' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(400).json({ error: { code: 'BAD_REQUEST', message } });
    }
  });

  router.delete('/api/admin/settings/mail', requireAdmin, (req, res) => {
    const had = clearMailSettings();
    resetTransporter();
    res.json({ ok: true, cleared: had, mode: resolveMailConfig() ? 'smtp' : 'outbox' });
  });

  router.post('/api/admin/settings/mail/test', requireAdmin, async (req, res) => {
    try {
      const body = (req.body ?? {}) as { to?: string };
      if (!body.to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.to)) {
        res.status(400).json({
          error: { code: 'BAD_REQUEST', message: 'Invalid recipient email address' },
        });
        return;
      }
      const tpl = testEmail(body.to);
      const result = await sendMail({ to: body.to, subject: tpl.subject, text: tpl.text, html: tpl.html });
      res.json({ ok: true, mode: result.mode, messageId: result.messageId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send test email';
      res.status(502).json({ error: { code: 'SEND_FAILED', message } });
    }
  });

  router.get('/api/admin/settings/mail/outbox', requireAdmin, (req, res) => {
    const limit = req.query.get('limit') ? parseInt(req.query.get('limit')!, 10) : 20;
    res.json({ messages: listOutbox(Math.min(Math.max(limit, 1), 50)) });
  });

  router.delete('/api/admin/settings/mail/outbox', requireAdmin, (req, res) => {
    clearOutbox();
    res.json({ ok: true });
  });

  return router;
}

// ─── Peek (validasi tanpa konsumsi — dipakai GET form reset) ─────────────────

function peekEmailToken(db: DatabaseSync, token: string, purpose: 'verify' | 'reset'): boolean {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const row = db
    .prepare('SELECT purpose, expires_at FROM _auth_email_tokens WHERE token_hash = ?')
    .get(tokenHash) as { purpose: string; expires_at: string } | undefined;
  if (!row) return false;
  if (row.purpose !== purpose) return false;
  return new Date(row.expires_at).getTime() > Date.now();
}
