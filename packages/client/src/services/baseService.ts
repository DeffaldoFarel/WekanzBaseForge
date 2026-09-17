import type { BaseForge } from '../client.js';
import { ClientResponseError, type RequestOptions } from '../types.js';

export abstract class BaseService {
  protected client: BaseForge;

  // M37: Singleton refresh lock — mencegah multiple simultaneous refresh
  // saat banyak request 401 pada saat yang sama. Hanya SATU refresh POST
  // yang berjalan; request lain menunggu lalu pakai token hasil refresh.
  private static refreshPromise: Promise<boolean> | null = null;

  constructor(client: BaseForge) {
    this.client = client;
  }

  /**
   * M37: Auto-refresh access token saat 401, lalu retry original request.
   *
   * Flow:
   *   1. Request → 401 (token expired)
   *   2. Kalau ada refreshToken → singleton refresh (satu POST untuk semua)
   *   3. Token baru tersimpan di authStore
   *   4. Retry original request dengan token baru
   *   5. Kalau refresh gagal → clear authStore → throw SESSION_EXPIRED
   *
   * Kalau request INI adalah refresh endpoint → jangan auto-refresh
   * (mencegah infinite loop).
   */
  private async tryRefreshToken(originalPath: string): Promise<boolean> {
    const refreshToken = this.client.authStore.refreshToken;
    if (!refreshToken) return false;

    // Jangan auto-refresh kalau request INI adalah refresh endpoint
    if (originalPath.includes('/auth/refresh')) return false;

    // Singleton lock: kalau refresh sudah berjalan, tunggu hasilnya
    if (BaseService.refreshPromise) {
      return BaseService.refreshPromise;
    }

    BaseService.refreshPromise = (async () => {
      try {
        const res = await this.client.auth.refresh();
        return !!res?.accessToken;
      } catch {
        // Refresh gagal → clear store (user harus login ulang)
        this.client.authStore.clear();
        return false;
      } finally {
        BaseService.refreshPromise = null;
      }
    })();

    return BaseService.refreshPromise;
  }

  /**
   * Helper request HTTP terpusat dengan penanganan auth, auto-refresh (M37), & error
   */
  protected async request<T = unknown>(
    path: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const result = await this.requestWithRetry<T>(path, options);
    return result;
  }

  private async requestWithRetry<T>(
    path: string,
    options: RequestOptions,
    isRetry = false
  ): Promise<T> {
    const { params, headers: customHeaders, body, ...fetchOpts } = options;

    // 1. Susun URL dengan query parameters jika ada
    let url = `${this.client.baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
    if (params) {
      const searchParams = new URLSearchParams();
      for (const [key, val] of Object.entries(params)) {
        if (val !== undefined && val !== null && val !== '') {
          searchParams.set(key, String(val));
        }
      }
      const qs = searchParams.toString();
      if (qs) {
        url += (url.includes('?') ? '&' : '?') + qs;
      }
    }

    // 2. Susun Headers
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...((customHeaders as Record<string, string>) || {}),
    };

    // Tambahkan bearer token jika ada di AuthStore dan belum di-set manual
    // M37: selalu baca ULANG dari authStore (token mungkin sudah di-refresh)
    if (this.client.authStore.token && !headers['Authorization']) {
      headers['Authorization'] = `Bearer ${this.client.authStore.token}`;
    }

    // Jika body adalah object biasa (bukan FormData atau string), set Content-Type JSON
    let finalBody: BodyInit | undefined = body as BodyInit | undefined;
    if (body && typeof body === 'object' && !(body instanceof FormData) && !(body instanceof URLSearchParams)) {
      headers['Content-Type'] = 'application/json';
      finalBody = JSON.stringify(body);
    }

    // 3. Eksekusi Request
    let res: Response;
    try {
      res = await fetch(url, {
        ...fetchOpts,
        headers,
        body: finalBody,
      });
    } catch (networkErr) {
      throw new ClientResponseError(
        0,
        (networkErr as Error).message || 'Network request failed',
        null,
        'NETWORK_ERROR'
      );
    }

    // 4. M37: Auto-refresh on 401 → retry ONCE
    if (res.status === 401 && !isRetry) {
      // Skip auto-refresh kalau request INI adalah refresh endpoint
      // (biarkan error asli dari server diteruskan — bukan SESSION_EXPIRED)
      const isRefreshEndpoint = path.includes('/auth/refresh');
      if (!isRefreshEndpoint) {
        const refreshed = await this.tryRefreshToken(path);
        if (refreshed) {
          // Token baru tersimpan → retry original request (dengan token baru)
          return this.requestWithRetry<T>(path, options, true);
        }
        // Refresh gagal / tidak ada refreshToken → throw SESSION_EXPIRED
        throw new ClientResponseError(
          401,
          'Session expired. Please sign in again.',
          null,
          'SESSION_EXPIRED'
        );
      }
      // Refresh endpoint → fall through ke normal error handling di bawah
    }

    // 5. Handle Status Non-2xx
    if (!res.ok) {
      let errorData: unknown = null;
      let errorMessage = `HTTP Error ${res.status}: ${res.statusText}`;
      let errorCode: string | undefined;

      try {
        errorData = await res.json();
        if (errorData && typeof errorData === 'object') {
          const errObj = (errorData as { error?: { message?: string; code?: string } }).error;
          if (errObj?.message) errorMessage = errObj.message;
          if (errObj?.code) errorCode = errObj.code;
        }
      } catch {
        // Response bukan JSON
      }

      throw new ClientResponseError(res.status, errorMessage, errorData, errorCode);
    }

    // 6. Handle Status 204 No Content
    if (res.status === 204) {
      return null as unknown as T;
    }

    // 7. Return JSON data
    try {
      return (await res.json()) as T;
    } catch {
      return null as unknown as T;
    }
  }
}
