// API client untuk BaseForge Admin API
// M00: token disimpan di localStorage (session proper di M09)

const API_URL = process.env.NEXT_PUBLIC_BASEFORGE_API || 'http://localhost:5100';

export interface Project {
  id: string;
  name: string;
  created: string;
  updated: string;
  services: {
    database: boolean;
    auth: boolean;
    storage: boolean;
    functions: boolean;
  };
  // apiKey belum diimplementasikan — akan datang di milestone API keys
  apiKey?: string;
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('bf_token');
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem('bf_token', token);
  else localStorage.removeItem('bf_token');
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message ?? `Request failed: ${res.status}`);
  }
  return data as T;
}

export async function login(email: string, password: string): Promise<string> {
  const data = await request<{ token: string }>('/api/admin/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  setToken(data.token);
  return data.token;
}

export async function listProjects(): Promise<Project[]> {
  const data = await request<{ projects: Project[] }>('/api/admin/projects');
  return data.projects;
}

export async function createProject(name: string): Promise<Project> {
  const data = await request<{ project: Project }>('/api/admin/projects', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  return data.project;
}

export async function getProject(id: string): Promise<Project> {
  const data = await request<{ project: Project }>(`/api/admin/projects/${id}`);
  return data.project;
}

export async function updateServices(
  id: string,
  services: Partial<Project['services']>
): Promise<Project> {
  const data = await request<{ project: Project }>(
    `/api/admin/projects/${id}`,
    { method: 'PATCH', body: JSON.stringify({ services }) }
  );
  return data.project;
}

export async function deleteProject(id: string): Promise<void> {
  await request(`/api/admin/projects/${id}`, { method: 'DELETE' });
}

export function logout(): void {
  setToken(null);
}

// ════════════════════════════════════════════════════════════════════════════
// M05u: DATABASE API (collections + records)
// ════════════════════════════════════════════════════════════════════════════

export interface FieldDef {
  name: string;
  type: string;
  required?: boolean;
  unique?: boolean;
  options?: {
    collectionId?: string;
    maxSelect?: number;
    cascadeDelete?: string;
    values?: string[]; // untuk type 'select'
    onCreate?: boolean; // untuk type 'autodate'
    onUpdate?: boolean;
  };
}

export interface CollectionInfo {
  name: string;
  fields: FieldDef[];
  indexes: { name: string; fields: string[] }[];
  recordCount?: number;
  created: string;
}

export interface ListResult {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: Record<string, unknown>[];
}

export async function listCollections(projectId: string): Promise<CollectionInfo[]> {
  const data = await request<{ collections: CollectionInfo[] }>(
    `/api/admin/projects/${projectId}/collections`
  );
  return data.collections;
}

export async function createCollection(
  projectId: string,
  def: { name: string; fields: FieldDef[] }
): Promise<CollectionInfo> {
  const data = await request<{ collection: CollectionInfo }>(
    `/api/admin/projects/${projectId}/collections`,
    { method: 'POST', body: JSON.stringify(def) }
  );
  return data.collection;
}

export async function deleteCollection(projectId: string, name: string): Promise<void> {
  await request(`/api/admin/projects/${projectId}/collections/${name}`, { method: 'DELETE' });
}

export async function listRecords(
  projectId: string,
  collection: string,
  opts: { filter?: string; sort?: string; page?: number; perPage?: number } = {}
): Promise<ListResult> {
  const params = new URLSearchParams();
  if (opts.filter) params.set('filter', opts.filter);
  if (opts.sort) params.set('sort', opts.sort);
  if (opts.page) params.set('page', String(opts.page));
  if (opts.perPage) params.set('perPage', String(opts.perPage));
  const qs = params.toString();
  return request<ListResult>(
    `/api/admin/projects/${projectId}/collections/${collection}/records${qs ? '?' + qs : ''}`
  );
}

export async function createRecord(
  projectId: string,
  collection: string,
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await request<{ record: Record<string, unknown> }>(
    `/api/admin/projects/${projectId}/collections/${collection}/records`,
    { method: 'POST', body: JSON.stringify(data) }
  );
  return res.record;
}

export async function updateRecord(
  projectId: string,
  collection: string,
  id: string,
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await request<{ record: Record<string, unknown> }>(
    `/api/admin/projects/${projectId}/collections/${collection}/records/${id}`,
    { method: 'PATCH', body: JSON.stringify(data) }
  );
  return res.record;
}

export async function deleteRecord(
  projectId: string,
  collection: string,
  id: string
): Promise<void> {
  await request(`/api/admin/projects/${projectId}/collections/${collection}/records/${id}`, {
    method: 'DELETE',
  });
}

// ════════════════════════════════════════════════════════════════════════════
// M10u: AUTH USERS + RULES API (dashboard mengelola end users & keamanan)
// ════════════════════════════════════════════════════════════════════════════

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  verified: boolean;
  created: string;
  updated: string;
  // password_hash TIDAK PERNAH dikirim server — lihat users.ts
}

export interface AuthUsersResult {
  items: AuthUser[];
  totalItems: number;
  totalPages: number;
  page: number;
  perPage: number;
}

export async function listAuthUsers(
  projectId: string,
  page = 1
): Promise<AuthUsersResult> {
  return request<AuthUsersResult>(
    `/api/admin/projects/${projectId}/auth-users?page=${page}&perPage=50`
  );
}

export async function createAuthUser(
  projectId: string,
  data: { email: string; password: string; name?: string }
): Promise<AuthUser> {
  const res = await request<{ user: AuthUser }>(
    `/api/admin/projects/${projectId}/auth-users`,
    { method: 'POST', body: JSON.stringify(data) }
  );
  return res.user;
}

export async function changeAuthUserPassword(
  projectId: string,
  userId: string,
  password: string
): Promise<void> {
  await request(`/api/admin/projects/${projectId}/auth-users/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify({ password }),
  });
}

export async function deleteAuthUser(projectId: string, userId: string): Promise<void> {
  await request(`/api/admin/projects/${projectId}/auth-users/${userId}`, {
    method: 'DELETE',
  });
}

export interface CollectionRules {
  listRule: string | null;
  viewRule: string | null;
  createRule: string | null;
  updateRule: string | null;
  deleteRule: string | null;
}

export async function getRules(projectId: string, collection: string): Promise<CollectionRules> {
  const res = await request<{ rules: CollectionRules }>(
    `/api/admin/projects/${projectId}/collections/${collection}/rules`
  );
  return res.rules;
}

export async function updateRules(
  projectId: string,
  collection: string,
  rules: Partial<CollectionRules>
): Promise<CollectionRules> {
  const res = await request<{ rules: CollectionRules }>(
    `/api/admin/projects/${projectId}/collections/${collection}/rules`,
    { method: 'PATCH', body: JSON.stringify(rules) }
  );
  return res.rules;
}
