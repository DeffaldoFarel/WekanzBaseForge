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
    // text
    min?: number;
    max?: number;
    pattern?: string;
    fulltext?: boolean;
    // number
    noDecimal?: boolean;
    // select
    values?: string[];
    maxSelect?: number;
    // relation
    collectionId?: string;
    cascadeDelete?: string;
    // file
    mimeTypes?: string[];
    maxSize?: number;
    thumbs?: string[];
    protected?: boolean;
    mime?: string;
    // email & url
    onlyDomains?: string[];
    exceptDomains?: string[];
    // password
    cost?: number;
    // autodate
    onCreate?: boolean;
    onUpdate?: boolean;
  };
}

export interface CollectionInfo {
  name: string;
  type?: 'base' | 'view';
  viewQuery?: string | null;
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

export async function updateCollection(
  projectId: string,
  name: string,
  def: { fields: FieldDef[] }
): Promise<CollectionInfo> {
  const data = await request<{ collection: CollectionInfo }>(
    `/api/admin/projects/${projectId}/collections/${name}`,
    { method: 'PATCH', body: JSON.stringify(def) }
  );
  return data.collection;
}

export async function rebuildCollectionSchema(
  projectId: string,
  name: string,
  def: { fields: FieldDef[] }
): Promise<CollectionInfo> {
  const data = await request<{ collection: CollectionInfo }>(
    `/api/admin/projects/${projectId}/collections/${name}`,
    { method: 'PUT', body: JSON.stringify(def) }
  );
  return data.collection;
}

export async function duplicateCollection(
  projectId: string,
  name: string,
  newName: string,
  withData = false
): Promise<CollectionInfo> {
  const data = await request<{ collection: CollectionInfo }>(
    `/api/admin/projects/${projectId}/collections/${name}/duplicate`,
    { method: 'POST', body: JSON.stringify({ newName, withData }) }
  );
  return data.collection;
}

export async function exportCollection(projectId: string, name: string): Promise<string> {
  const token = getToken();
  const res = await fetch(`${API_URL}/api/admin/projects/${projectId}/collections/${name}/export`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error('Failed to export collection');
  return res.text();
}

export async function importCollection(
  projectId: string,
  data: string | object,
  mode: 'create' | 'replace' | 'merge' = 'create'
): Promise<{ success: boolean; collection: string; recordCount: number }> {
  return request<{ success: boolean; collection: string; recordCount: number }>(
    `/api/admin/projects/${projectId}/collections/import`,
    { method: 'POST', body: JSON.stringify({ data, mode }) }
  );
}

export async function deleteCollection(projectId: string, name: string): Promise<void> {
  await request(`/api/admin/projects/${projectId}/collections/${name}`, { method: 'DELETE' });
}

export async function listRecords(
  projectId: string,
  collection: string,
  opts: { filter?: string; sort?: string; page?: number; perPage?: number; search?: string; expand?: string } = {}
): Promise<ListResult> {
  const params = new URLSearchParams();
  if (opts.filter) params.set('filter', opts.filter);
  if (opts.sort) params.set('sort', opts.sort);
  if (opts.search) params.set('search', opts.search);
  if (opts.expand) params.set('expand', opts.expand);
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

// ════════════════════════════════════════════════════════════════════════════
// M14u: FILE UPLOAD API (multipart via FormData) + URL helper
// ════════════════════════════════════════════════════════════════════════════

export interface UploadResult {
  record: Record<string, unknown>;
}

// Upload record dengan file (multipart). fields berisi pasangan nama→nilai
// untuk field teks; files berisi pasangan fieldName→File (dari <input type=file>).
// Untuk multi-file (maxSelect>1), kumpulkan sebagai array di satu key.
export async function createRecordWithFiles(
  projectId: string,
  collection: string,
  fields: Record<string, unknown>,
  files: Record<string, File | File[]>
): Promise<Record<string, unknown>> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  for (const [fieldName, f] of Object.entries(files)) {
    if (Array.isArray(f)) {
      for (const one of f) fd.append(fieldName, one);
    } else {
      fd.append(fieldName, f);
    }
  }

  const token = getToken();
  const res = await fetch(`${API_URL}/api/p/${projectId}/collections/${collection}/records`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd, // JANGAN set Content-Type — browser yang isi boundary!
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? `Upload gagal: ${res.status}`);
  return (data as UploadResult).record;
}

export async function updateRecordWithFiles(
  projectId: string,
  collection: string,
  id: string,
  fields: Record<string, unknown>,
  files: Record<string, File | File[]>
): Promise<Record<string, unknown>> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  for (const [fieldName, f] of Object.entries(files)) {
    if (Array.isArray(f)) {
      for (const one of f) fd.append(fieldName, one);
    } else {
      fd.append(fieldName, f);
    }
  }

  const token = getToken();
  const res = await fetch(`${API_URL}/api/p/${projectId}/collections/${collection}/records/${id}`, {
    method: 'PATCH',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? `Update gagal: ${res.status}`);
  return (data as UploadResult).record;
}

// URL untuk mengakses file yang sudah tersimpan
export function fileUrl(
  projectId: string,
  collection: string,
  recordId: string,
  filename: string
): string {
  return `${API_URL}/api/files/${projectId}/${collection}/${recordId}/${encodeURIComponent(filename)}`;
}

// ════════════════════════════════════════════════════════════════════════════
// M15u: FUNCTIONS API (CRUD + execute)
// ════════════════════════════════════════════════════════════════════════════

export interface FunctionTrigger {
  collection: string;
  actions: string[];
}

export interface StoredFunction {
  id: string;
  name: string;
  code: string;
  enabled: boolean;
  timeoutMs: number;
  triggers: FunctionTrigger[];
  schedule: string | null;
  created: string;
  updated: string;
}

export async function listFunctions(projectId: string): Promise<StoredFunction[]> {
  const res = await request<{ functions: StoredFunction[] }>(
    `/api/admin/projects/${projectId}/functions`
  );
  return res.functions;
}

export async function createFunction(
  projectId: string,
  def: { name: string; code: string; enabled?: boolean; timeoutMs?: number; triggers?: FunctionTrigger[]; schedule?: string | null }
): Promise<StoredFunction> {
  const res = await request<{ function: StoredFunction }>(
    `/api/admin/projects/${projectId}/functions`,
    { method: 'POST', body: JSON.stringify(def) }
  );
  return res.function;
}

export async function updateFunction(
  projectId: string,
  name: string,
  updates: { code?: string; enabled?: boolean; timeoutMs?: number; triggers?: FunctionTrigger[]; schedule?: string | null }
): Promise<StoredFunction> {
  const res = await request<{ function: StoredFunction }>(
    `/api/admin/projects/${projectId}/functions/${name}`,
    { method: 'PATCH', body: JSON.stringify(updates) }
  );
  return res.function;
}

export async function deleteFunction(projectId: string, name: string): Promise<void> {
  await request(`/api/admin/projects/${projectId}/functions/${name}`, { method: 'DELETE' });
}

export interface FunctionExecResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  logs: string[];
  durationMs: number;
  timedOut?: boolean;
}

export async function executeFunction(
  projectId: string,
  name: string,
  body?: unknown
): Promise<FunctionExecResult> {
  return request<FunctionExecResult>(
    `/api/admin/projects/${projectId}/functions/${name}/execute`,
    { method: 'POST', body: JSON.stringify({ body: body ?? {} }) }
  );
}

export async function listCollectionsForFunctions(
  projectId: string
): Promise<{ name: string }[]> {
  const cols = await listCollections(projectId);
  return cols.map((c) => ({ name: c.name }));
}
