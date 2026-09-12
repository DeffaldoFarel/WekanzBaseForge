import type { BaseForge } from '../client.js';
import { ClientResponseError, type RequestOptions } from '../types.js';

export abstract class BaseService {
  protected client: BaseForge;

  constructor(client: BaseForge) {
    this.client = client;
  }

  /**
   * Helper request HTTP terpusat dengan penanganan auth & error
   */
  protected async request<T = unknown>(
    path: string,
    options: RequestOptions = {}
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

    // 4. Handle Status Non-2xx
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

    // 5. Handle Status 204 No Content
    if (res.status === 204) {
      return null as unknown as T;
    }

    // 6. Return JSON data
    try {
      return (await res.json()) as T;
    } catch {
      return null as unknown as T;
    }
  }
}
