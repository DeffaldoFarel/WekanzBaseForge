import { BaseService } from './baseService.js';
import type { AuthResponse, AuthUser, MfaRequired, OAuthCallbackResult, OAuthProvider } from '../types.js';

export class AuthService extends BaseService {
  /** Pengguna yang sedang aktif login */
  get user(): AuthUser | null {
    return this.client.authStore.user;
  }

  /** Access token yang sedang aktif */
  get token(): string {
    return this.client.authStore.token;
  }

  /** Apakah status autentikasi valid */
  get isValid(): boolean {
    return this.client.authStore.isValid;
  }

  /**
   * Mendaftar akun baru (otomatis menyimpan token & login)
   */
  async register(email: string, password: string, name?: string): Promise<AuthResponse> {
    const res = await this.request<AuthResponse>(
      `api/p/${this.client.projectId}/auth/register`,
      {
        method: 'POST',
        body: { email, password, name },
      }
    );

    this.client.authStore.save(res.accessToken, res.refreshToken, res.user);
    return res;
  }

  /**
   * Masuk menggunakan email & kata sandi.
   * Bila MFA aktif, respons berupa { mfaRequired, mfaToken } — selesaikan
   * via `mfaChallenge(mfaToken, code)`.
   */
  async login(email: string, password: string): Promise<AuthResponse | MfaRequired> {
    const res = await this.request<AuthResponse | MfaRequired>(
      `api/p/${this.client.projectId}/auth/login`,
      {
        method: 'POST',
        body: { email, password },
      }
    );

    if ('mfaRequired' in res && res.mfaRequired) return res; // gerbang MFA
    this.client.authStore.save((res as AuthResponse).accessToken, (res as AuthResponse).refreshToken, (res as AuthResponse).user);
    return res as AuthResponse;
  }

  /** Type guard: respons login yang meminta kode MFA. */
  isMfaRequired(res: AuthResponse | MfaRequired): res is MfaRequired {
    return (res as MfaRequired).mfaRequired === true;
  }

  /**
   * Memperbarui access token menggunakan refresh token yang tersimpan
   */
  async refresh(): Promise<AuthResponse> {
    const refreshToken = this.client.authStore.refreshToken;
    if (!refreshToken) {
      throw new Error('No refresh token available in authStore');
    }

    const res = await this.request<AuthResponse>(
      `api/p/${this.client.projectId}/auth/refresh`,
      {
        method: 'POST',
        body: { refreshToken },
      }
    );

    const user = res.user ?? this.client.authStore.user!;
    this.client.authStore.save(res.accessToken, res.refreshToken, user);
    return res;
  }

  /**
   * Mengambil data profil pengguna yang sedang login
   */
  async me(): Promise<{ user: AuthUser }> {
    const res = await this.request<{ user: AuthUser }>(
      `api/p/${this.client.projectId}/auth/me`,
      {
        method: 'GET',
      }
    );

    if (res.user && this.client.authStore.token) {
      this.client.authStore.save(
        this.client.authStore.token,
        this.client.authStore.refreshToken,
        res.user
      );
    }
    return res;
  }

  /**
   * Keluar dan mencabut refresh token
   */
  async logout(): Promise<void> {
    const refreshToken = this.client.authStore.refreshToken;
    try {
      if (refreshToken) {
        await this.request(`api/p/${this.client.projectId}/auth/logout`, {
          method: 'POST',
          body: { refreshToken },
        });
      }
    } finally {
      this.client.authStore.clear();
    }
  }

  // ─── M10: OAuth2 (Google / GitHub) ──────────────────────────────────────────

  /**
   * URL authorize untuk memulai login OAuth.
   * Arahkan browser (redirect penuh / window.location.href / popup) ke URL ini.
   *
   * @param provider 'google' | 'github'
   * @param redirectTo URL halaman aplikasi Anda — setelah consent sukses,
   *                   user dikirim ke sini dengan token di fragment:
   *                   `#access_token=…&refresh_token=…`
   */
  oauthAuthorizeUrl(provider: OAuthProvider, redirectTo?: string): string {
    const base = `${this.client.baseUrl}/api/p/${this.client.projectId}/auth/oauth/${provider}/authorize`;
    return redirectTo ? `${base}?redirect_to=${encodeURIComponent(redirectTo)}` : base;
  }

  /**
   * Login via OAuth: redirect browser penuh ke provider (khusus lingkungan browser).
   * Setelah sukses, user mendarat di `redirectTo` — panggil `handleOAuthCallback()`
   * di halaman tersebut untuk menyimpan token.
   */
  loginWithOAuth(provider: OAuthProvider, redirectTo: string): void {
    if (typeof window === 'undefined') {
      throw new Error('loginWithOAuth hanya bisa dipanggil di browser');
    }
    window.location.href = this.oauthAuthorizeUrl(provider, redirectTo);
  }

  /**
   * Panggil di halaman redirect target untuk mem-parse token dari URL fragment
   * (mis. `yoursite.com/callback#access_token=…&refresh_token=…`).
   * Token disimpan ke authStore lalu profil user diambil via /me.
   *
   * Fragment dibersihkan dari address bar setelah parsing (mengurangi jejak
   * token di history browser).
   *
   * @returns null bila tidak ada token/error di URL (bukan halaman callback),
   *          object bila callback terdeteksi.
   */
  async handleOAuthCallback(): Promise<OAuthCallbackResult | null> {
    if (typeof window === 'undefined') return null;

    const hash = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : '';
    if (!hash) return null;

    const params = new URLSearchParams(hash);
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    const error = params.get('error') ?? undefined;

    if (!accessToken && !error) return null; // fragment lain (router SPA, dll.)

    // Bersihkan fragment dari address bar tanpa reload
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }

    if (accessToken && refreshToken) {
      // Simpan token dulu (user null sementara) → /me mengisi profil
      this.client.authStore.save(accessToken, refreshToken, null);
      try {
        await this.me();
      } catch {
        // token bisa jadi valid tapi /me gagal sementara — tetap kembalikan hasil
      }
      return { accessToken, refreshToken };
    }

    return { accessToken: '', refreshToken: '', error: error ?? 'unknown_error' };
  }

  // ─── M23: Email Verification & Password Reset ───────────────────────────────

  /**
   * Minta email verifikasi dikirim (bisa dengan email, atau user login saat ini).
   * Respons selalu sukses (anti user-enumeration).
   */
  async requestVerification(email?: string): Promise<{ message: string }> {
    return this.request<{ message: string }>(
      `api/p/${this.client.projectId}/auth/request-verification`,
      { method: 'POST', body: { email } }
    );
  }

  /** Verifikasi email dengan token dari link (via POST — alternatif GET link). */
  async verifyEmail(token: string): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>(
      `api/p/${this.client.projectId}/auth/verify-email`,
      { method: 'POST', body: { token } }
    );
  }

  /**
   * Minta email reset password dikirim.
   * Respons selalu sukses (anti user-enumeration).
   */
  async requestPasswordReset(email: string): Promise<{ message: string }> {
    return this.request<{ message: string }>(
      `api/p/${this.client.projectId}/auth/request-password-reset`,
      { method: 'POST', body: { email } }
    );
  }

  /**
   * Set password baru dengan token dari email reset.
   * Semua sesi login lain otomatis di-revoke (logout semua device).
   */
  async confirmPasswordReset(
    token: string,
    newPassword: string
  ): Promise<{ ok: boolean; message: string; revokedSessions: number }> {
    return this.request<{ ok: boolean; message: string; revokedSessions: number }>(
      `api/p/${this.client.projectId}/auth/confirm-password-reset`,
      { method: 'POST', body: { token, password: newPassword } }
    );
  }

  // ─── M27: MFA / TOTP ─────────────────────────────────────────────────────────

  /**
   * Mulai enrollment MFA (butuh login aktif — token Bearer).
   * Scan `otpauthUrl` dengan app authenticator, lalu konfirmasi via mfaVerify.
   */
  async mfaEnroll(): Promise<{ secret: string; otpauthUrl: string; message: string }> {
    return this.request<{ secret: string; otpauthUrl: string; message: string }>(
      `api/p/${this.client.projectId}/auth/mfa/enroll`,
      { method: 'POST' }
    );
  }

  /**
   * Konfirmasi enrollment dengan kode 6-digit pertama.
   * Mengembalikan 10 recovery codes — SIMPAN, hanya muncul sekali.
   */
  async mfaVerify(token: string): Promise<{ mfaEnabled: boolean; recoveryCodes: string[] }> {
    return this.request<{ mfaEnabled: boolean; recoveryCodes: string[] }>(
      `api/p/${this.client.projectId}/auth/mfa/verify`,
      { method: 'POST', body: { token } }
    );
  }

  /**
   * Selesaikan login MFA: mfaToken (dari login) + kode TOTP ATAU recoveryCode.
   * Sukses → token tersimpan di authStore (login tuntas).
   */
  async mfaChallenge(
    mfaToken: string,
    code: string,
    recoveryCode?: string
  ): Promise<AuthResponse> {
    const res = await this.request<AuthResponse>(
      `api/p/${this.client.projectId}/auth/mfa/challenge`,
      {
        method: 'POST',
        body: recoveryCode
          ? { mfaToken, recoveryCode }
          : { mfaToken, token: code },
      }
    );
    this.client.authStore.save(res.accessToken, res.refreshToken, res.user);
    return res;
  }

  /**
   * Matikan MFA (butuh login aktif + kode TOTP atau recoveryCode sebagai bukti).
   */
  async mfaDisable(code?: string, recoveryCode?: string): Promise<{ ok: boolean; mfaEnabled: boolean }> {
    return this.request<{ ok: boolean; mfaEnabled: boolean }>(
      `api/p/${this.client.projectId}/auth/mfa/disable`,
      { method: 'POST', body: { token: code, recoveryCode } }
    );
  }
}
