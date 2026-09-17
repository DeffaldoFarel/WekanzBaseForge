import type { AuthStore, AuthUser } from './types.js';

type Listener = (token: string, user: AuthUser | null) => void;

/**
 * In-Memory AuthStore (Default untuk Node.js / Server-Side Rendering)
 */
export class MemoryAuthStore implements AuthStore {
  protected _token = '';
  protected _refreshToken = '';
  protected _user: AuthUser | null = null;
  protected listeners: Set<Listener> = new Set();

  get token(): string {
    return this._token;
  }

  get refreshToken(): string {
    return this._refreshToken;
  }

  get user(): AuthUser | null {
    return this._user;
  }

  get isValid(): boolean {
    return !!this._token && !!this._user;
  }

  save(token: string, refreshToken: string, user: AuthUser | null): void {
    this._token = token;
    this._refreshToken = refreshToken;
    this._user = user;
    this.notify();
  }

  clear(): void {
    this._token = '';
    this._refreshToken = '';
    this._user = null;
    this.notify();
  }

  onChange(callback: Listener): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  protected notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this._token, this._user);
      } catch (err) {
        console.error('AuthStore listener error:', err);
      }
    }
  }
}

/**
 * LocalStorage AuthStore (Untuk Browser / Client-Side Persistence)
 */
export class LocalStorageAuthStore extends MemoryAuthStore {
  protected storageKey: string;

  constructor(storageKey = 'baseforge_auth') {
    super();
    this.storageKey = storageKey;
    this.load();
  }

  protected load(): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      const raw = window.localStorage.getItem(this.storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        this._token = parsed.token ?? '';
        this._refreshToken = parsed.refreshToken ?? '';
        this._user = parsed.user ?? null;
      }
    } catch {
      // Abaikan jika data corrupted
    }
  }

  override save(token: string, refreshToken: string, user: AuthUser | null): void {
    super.save(token, refreshToken, user);
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.setItem(
          this.storageKey,
          JSON.stringify({ token, refreshToken, user })
        );
      } catch {
        // Storage quota or disabled
      }
    }
  }

  override clear(): void {
    super.clear();
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.removeItem(this.storageKey);
      } catch {
        // Storage disabled
      }
    }
  }
}

/**
 * Auto-detect the best AuthStore for the current runtime
 */
export function createDefaultAuthStore(): AuthStore {
  if (typeof window !== 'undefined' && window.localStorage) {
    return new LocalStorageAuthStore();
  }
  return new MemoryAuthStore();
}
