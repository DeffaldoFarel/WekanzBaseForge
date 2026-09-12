// ============================================================================
// @wekanz/baseforge — Core Type Definitions
// ============================================================================

export interface AuthUser {
  id: string;
  email: string;
  name?: string | null;
  verified: boolean;
  created: string;
}

export interface AuthResponse {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: BodyInit | Record<string, unknown> | null;
  params?: Record<string, unknown>;
}

export interface RecordModel {
  id: string;
  created: string;
  updated: string;
  expand?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ListResult<T = RecordModel> {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: T[];
}

export interface ListOptions {
  page?: number;
  perPage?: number;
  sort?: string;
  filter?: string;
  search?: string;
  expand?: string;
  headers?: Record<string, string>;
}

export interface GetOneOptions {
  expand?: string;
  headers?: Record<string, string>;
}

export interface FileOptions {
  thumb?: string; // Format PocketBase: '100x100', '300x0', '0x200', '200x200f'
}

export interface ClientOptions {
  baseUrl?: string;
  projectId?: string;
  authStore?: AuthStore;
}

export interface RealtimeEvent<T = RecordModel> {
  action: 'create' | 'update' | 'delete';
  record: T;
}

export type RealtimeListener<T = RecordModel> = (e: RealtimeEvent<T>) => void;

// ─── Custom Error Class ──────────────────────────────────────────────────────

export class ClientResponseError extends Error {
  status: number;
  data: unknown;
  code?: string;

  constructor(status: number, message: string, data?: unknown, code?: string) {
    super(message);
    this.name = 'ClientResponseError';
    this.status = status;
    this.data = data;
    this.code = code;
  }
}

// ─── Auth Store Interface ────────────────────────────────────────────────────

export interface AuthStore {
  token: string;
  refreshToken: string;
  user: AuthUser | null;
  readonly isValid: boolean;
  save(token: string, refreshToken: string, user: AuthUser): void;
  clear(): void;
  onChange(callback: (token: string, user: AuthUser | null) => void): () => void;
}
