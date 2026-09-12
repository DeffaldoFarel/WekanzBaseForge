import { BaseService } from './baseService.js';
import type { AuthResponse, AuthUser } from '../types.js';

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
   * Masuk menggunakan email & kata sandi
   */
  async login(email: string, password: string): Promise<AuthResponse> {
    const res = await this.request<AuthResponse>(
      `api/p/${this.client.projectId}/auth/login`,
      {
        method: 'POST',
        body: { email, password },
      }
    );

    this.client.authStore.save(res.accessToken, res.refreshToken, res.user);
    return res;
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
}
