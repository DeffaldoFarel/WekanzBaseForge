// API client untuk BaseForge Admin API
// M00: token disimpan di localStorage (session proper di M09)

const API_URL = process.env.NEXT_PUBLIC_BASEFORGE_API || 'http://localhost:5100';

/** Base URL API publik — dipakai untuk contoh curl di UI (usage snippets). */
export const PUBLIC_API_URL = API_URL;

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

export async function getAdminSetupState(): Promise<{ needsSetup: boolean; hasAdmin: boolean }> {
  return request<{ needsSetup: boolean; hasAdmin: boolean }>('/api/admin/setup-state');
}

/** Ganti password admin yang sedang login. Mencabut semua sesi lain (kecuali token saat ini). */
export async function changeAdminPassword(
  currentPassword: string,
  newPassword: string
): Promise<{ success: boolean }> {
  return request<{ success: boolean }>('/api/admin/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export async function setupInitialAdmin(
  email: string,
  password: string
): Promise<{ token: string; admin: { id: string; email: string } }> {
  const data = await request<{ token: string; admin: { id: string; email: string } }>(
    '/api/admin/auth/setup',
    {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }
  );
  setToken(data.token);
  return data;
}

const projectNameCache = new Map<string, string>();

function loadProjectNameCache(): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = sessionStorage.getItem('bf_proj_names');
    if (raw) {
      const parsed = JSON.parse(raw);
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') projectNameCache.set(k, v);
      }
    }
  } catch {}
}

function saveProjectNameCache(): void {
  if (typeof window === 'undefined') return;
  try {
    const obj = Object.fromEntries(projectNameCache.entries());
    sessionStorage.setItem('bf_proj_names', JSON.stringify(obj));
  } catch {}
}

export function getCachedProjectName(id: string): string | undefined {
  if (projectNameCache.size === 0) {
    loadProjectNameCache();
  }
  return projectNameCache.get(id);
}

export async function fetchProjectName(id: string): Promise<string> {
  const cached = getCachedProjectName(id);
  if (cached) return cached;
  try {
    const project = await getProject(id);
    if (project?.name) {
      projectNameCache.set(id, project.name);
      saveProjectNameCache();
      return project.name;
    }
  } catch {}
  return id;
}

export async function listProjects(): Promise<Project[]> {
  const data = await request<{ projects: Project[] }>('/api/admin/projects');
  for (const p of data.projects) {
    projectNameCache.set(p.id, p.name);
  }
  saveProjectNameCache();
  return data.projects;
}

export async function createProject(name: string): Promise<Project> {
  const data = await request<{ project: Project }>('/api/admin/projects', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  if (data.project?.name) {
    projectNameCache.set(data.project.id, data.project.name);
    saveProjectNameCache();
  }
  return data.project;
}

export async function getProject(id: string): Promise<Project> {
  const data = await request<{ project: Project }>(`/api/admin/projects/${id}`);
  if (data.project?.name) {
    projectNameCache.set(id, data.project.name);
    saveProjectNameCache();
  }
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
  projectNameCache.delete(id);
  saveProjectNameCache();
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
    // vector (M29)
    dimensions?: number;
  };
}

export interface IndexDef {
  name: string;
  fields: string[];
  unique?: boolean;
}

export interface CollectionInfo {
  name: string;
  type?: 'base' | 'view' | 'auth';
  viewQuery?: string | null;
  fields: FieldDef[];
  indexes: IndexDef[];
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
  def: {
    name: string;
    type?: 'base' | 'view' | 'auth';
    viewQuery?: string;
    fields?: FieldDef[];
    indexes?: IndexDef[];
    rules?: Partial<CollectionRules>;
  }
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
  def: { fields: FieldDef[]; indexes?: IndexDef[] }
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

// ── M19: Aggregations ────────────────────────────────────────────────────
// Server-side computation. The whole point is NOT transferring rows to the
// browser just to reduce them here — SUM over 100k rows returns ~20 bytes.

export type AggregateFunction = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface AggregateGroup {
  group: string | number | null;
  value: number | null;
}

// Server returns ONLY the payload — `{ value }` for scalars, `{ groups }` when
// grouping. It does NOT echo back `function`/`field`, so the caller must keep
// track of what it asked for. Typing those as present crashes the UI.
export interface AggregateResult {
  value?: number | null;
  groups?: AggregateGroup[];
}

export async function aggregateRecords(
  projectId: string,
  collection: string,
  opts: {
    function: AggregateFunction;
    field?: string;
    filter?: string;
    groupBy?: string;
  }
): Promise<AggregateResult> {
  const params = new URLSearchParams();
  params.set('function', opts.function);
  if (opts.field) params.set('field', opts.field);
  if (opts.filter) params.set('filter', opts.filter);
  if (opts.groupBy) params.set('groupBy', opts.groupBy);
  return request<AggregateResult>(
    `/api/admin/projects/${projectId}/collections/${collection}/aggregate?${params.toString()}`
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
  disabled: boolean;
  mfaEnabled?: boolean;
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
  page = 1,
  search?: string
): Promise<AuthUsersResult> {
  const params = new URLSearchParams({ page: String(page), perPage: '50' });
  if (search) params.set('search', search);
  return request<AuthUsersResult>(
    `/api/admin/projects/${projectId}/auth-users?${params.toString()}`
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

// ─── Ops-16: custom profile field ──────────────────────────────────────────

export interface AuthFieldDefinition {
  name: string;
  type: string;
  required: boolean;
  /** false = hanya admin yang boleh mengubah (padanan app_metadata Supabase) */
  userEditable: boolean;
  options?: Record<string, unknown>;
  created: string;
}

export async function listAuthFields(projectId: string): Promise<AuthFieldDefinition[]> {
  const res = await request<{ fields: AuthFieldDefinition[] }>(
    `/api/admin/projects/${projectId}/auth-fields`
  );
  return res.fields;
}

export async function createAuthField(
  projectId: string,
  def: {
    name: string;
    type: string;
    required?: boolean;
    userEditable?: boolean;
    options?: Record<string, unknown>;
  }
): Promise<AuthFieldDefinition> {
  const res = await request<{ field: AuthFieldDefinition }>(
    `/api/admin/projects/${projectId}/auth-fields`,
    { method: 'POST', body: JSON.stringify(def) }
  );
  return res.field;
}

export async function deleteAuthField(projectId: string, name: string): Promise<void> {
  await request(`/api/admin/projects/${projectId}/auth-fields/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
}

// M47: verify / disable auth user
export async function setAuthUserVerified(
  projectId: string,
  userId: string,
  verified: boolean
): Promise<{ success: boolean; verified: boolean }> {
  return request<{ success: boolean; verified: boolean }>(
    `/api/admin/projects/${projectId}/auth-users/${userId}/verify`,
    { method: 'POST', body: JSON.stringify({ verified }) }
  );
}

export async function setAuthUserDisabled(
  projectId: string,
  userId: string,
  disabled: boolean
): Promise<{ success: boolean; disabled: boolean }> {
  return request<{ success: boolean; disabled: boolean }>(
    `/api/admin/projects/${projectId}/auth-users/${userId}/disable`,
    { method: 'POST', body: JSON.stringify({ disabled }) }
  );
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

/**
 * M35: URL file bucket (decoupled) — GET /api/files/:pid/bucket/:fileId.
 * File bucket dipakai saat URL publik file tidak boleh bergantung pada record.
 */
export function bucketFileUrl(projectId: string, fileId: string): string {
  return `${API_URL}/api/files/${projectId}/bucket/${encodeURIComponent(fileId)}`;
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
  httpAllow: string[];
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
  def: { name: string; code: string; enabled?: boolean; timeoutMs?: number; triggers?: FunctionTrigger[]; schedule?: string | null; httpAllow?: string[] }
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
  updates: { code?: string; enabled?: boolean; timeoutMs?: number; triggers?: FunctionTrigger[]; schedule?: string | null; httpAllow?: string[] }
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

// ─── STORAGE EXPLORER API ───────────────────────────────────────────────────

export interface StoredFileInfo {
  name: string;
  recordId: string;
  storedName: string;
  size: number;
  mtime: string;
  mime: string;
  isImage: boolean;
  collectionName: string | null;
  isOrphaned: boolean;
  /** M35: file bucket (decoupled) — URL-nya /api/files/:pid/bucket/:recordId. */
  isBucket?: boolean;
}

export interface StorageStats {
  totalFiles: number;
  totalSize: number;
  orphanedCount: number;
}

export async function listStorageFiles(
  projectId: string
): Promise<{ files: StoredFileInfo[]; stats: StorageStats }> {
  return request<{ files: StoredFileInfo[]; stats: StorageStats }>(
    `/api/admin/projects/${projectId}/storage/files`
  );
}

export async function deleteStorageFile(
  projectId: string,
  recordId: string,
  filename: string
): Promise<{ success: boolean; message: string }> {
  return request<{ success: boolean; message: string }>(
    `/api/admin/projects/${projectId}/storage/files/${encodeURIComponent(recordId)}/${encodeURIComponent(filename)}`,
    { method: 'DELETE' }
  );
}

/**
 * M35: hapus file bucket (decoupled) via endpoint admin
 * DELETE /api/admin/projects/:pid/storage/bucket/:fileId — juga membersihkan
 * metadata _bucket_files (beda dengan deleteStorageFile yang hanya unlink file).
 */
export async function deleteBucketFile(projectId: string, fileId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(
    `/api/admin/projects/${projectId}/storage/bucket/${encodeURIComponent(fileId)}`,
    { method: 'DELETE' }
  );
}

export async function cleanOrphanedStorageFiles(
  projectId: string
): Promise<{ success: boolean; cleaned: number }> {
  return request<{ success: boolean; cleaned: number }>(
    `/api/admin/projects/${projectId}/storage/clean-orphans`,
    { method: 'POST' }
  );
}

// ════════════════════════════════════════════════════════════════════════════
// M10: OAUTH2 PROVIDERS API (konfigurasi per project)
// ════════════════════════════════════════════════════════════════════════════

export interface OAuthProviderInfo {
  provider: string;
  clientId: string;
  enabled: boolean;
  callbackUrl: string | null;
  allowedOrigins: string[];
}

export async function listOAuthProviders(projectId: string): Promise<OAuthProviderInfo[]> {
  const res = await request<{ providers: OAuthProviderInfo[] }>(
    `/api/admin/projects/${projectId}/auth/providers`
  );
  return res.providers;
}

export async function upsertOAuthProvider(
  projectId: string,
  provider: string,
  config: {
    clientId: string;
    clientSecret?: string;
    enabled?: boolean;
    callbackUrl?: string;
    allowedOrigins?: string[] | string;
  }
): Promise<OAuthProviderInfo> {
  const res = await request<{ provider: OAuthProviderInfo }>(
    `/api/admin/projects/${projectId}/auth/providers/${provider}`,
    { method: 'PUT', body: JSON.stringify(config) }
  );
  return res.provider;
}

export async function deleteOAuthProvider(
  projectId: string,
  provider: string
): Promise<void> {
  await request(`/api/admin/projects/${projectId}/auth/providers/${provider}`, {
    method: 'DELETE',
  });
}

/** URL authorize untuk end-user app (untuk tombol "Sign in with Google"). */
export function oauthAuthorizeUrl(
  projectId: string,
  provider: string,
  redirectTo?: string
): string {
  const params = redirectTo ? `?redirect_to=${encodeURIComponent(redirectTo)}` : '';
  return `${API_URL}/api/p/${projectId}/auth/oauth/${provider}/authorize${params}`;
}

// ════════════════════════════════════════════════════════════════════════════
// M23: MAIL SETTINGS (platform-level SMTP) + DEV OUTBOX
// ════════════════════════════════════════════════════════════════════════════

export interface MailConfigInfo {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  from: string;
  hasPassword: boolean;
}

export interface MailSettingsInfo {
  config: MailConfigInfo | null;
  mode: 'smtp' | 'outbox';
}

export interface OutboxMessage {
  id: string;
  to: string;
  subject: string;
  text: string;
  html: string | null;
  created: string;
}

export async function getMailSettings(): Promise<MailSettingsInfo> {
  return request<MailSettingsInfo>('/api/admin/settings/mail');
}

export async function updateMailSettings(config: {
  host: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  from?: string;
}): Promise<MailSettingsInfo> {
  return request<MailSettingsInfo>('/api/admin/settings/mail', {
    method: 'PUT',
    body: JSON.stringify(config),
  });
}

export async function clearMailSettings(): Promise<{ mode: 'smtp' | 'outbox' }> {
  return request<{ mode: 'smtp' | 'outbox' }>('/api/admin/settings/mail', {
    method: 'DELETE',
  });
}

export async function sendTestEmail(to: string): Promise<{ ok: boolean; mode: string; messageId: string }> {
  return request<{ ok: boolean; mode: string; messageId: string }>(
    '/api/admin/settings/mail/test',
    { method: 'POST', body: JSON.stringify({ to }) }
  );
}

export async function listMailOutbox(limit = 20): Promise<OutboxMessage[]> {
  const res = await request<{ messages: OutboxMessage[] }>(
    `/api/admin/settings/mail/outbox?limit=${limit}`
  );
  return res.messages;
}

export async function clearMailOutbox(): Promise<void> {
  await request('/api/admin/settings/mail/outbox', { method: 'DELETE' });
}

// ════════════════════════════════════════════════════════════════════════════
// M24: PROJECT USAGE STATS (request & bandwidth)
// ════════════════════════════════════════════════════════════════════════════

export interface DayStats {
  date: string;
  requests: number;
  bytesIn: number;
  bytesOut: number;
}

export interface ProjectStats {
  today: DayStats;
  days: DayStats[];
  totals: { requests: number; bytesIn: number; bytesOut: number };
}

export async function getProjectStats(projectId: string): Promise<ProjectStats> {
  return request<ProjectStats>(`/api/admin/projects/${projectId}/stats`);
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (!bytes || bytes < 0) return "—";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)) + " " + sizes[i];
}

// ════════════════════════════════════════════════════════════════════════════
// M26: PER-PROJECT API KEYS (server-to-server access)
// ════════════════════════════════════════════════════════════════════════════

export type ApiKeyScope = "read" | "write";

export interface ProjectApiKey {
  id: string;
  name: string;
  scope: ApiKeyScope;
  hint: string;
  created: string;
  lastUsed: string | null;
  requests: number;
}

export async function createProjectApiKey(
  projectId: string,
  def: { name?: string; scope: ApiKeyScope }
): Promise<{ apiKey: ProjectApiKey; key: string }> {
  const res = await request<{ apiKey: ProjectApiKey; key: string }>(
    `/api/admin/projects/${projectId}/api-keys`,
    { method: 'POST', body: JSON.stringify(def) }
  );
  return res;
}

export async function listProjectApiKeys(projectId: string): Promise<ProjectApiKey[]> {
  const res = await request<{ keys: ProjectApiKey[] }>(
    `/api/admin/projects/${projectId}/api-keys`
  );
  return res.keys;
}

export async function revokeProjectApiKey(projectId: string, keyId: string): Promise<void> {
  await request(`/api/admin/projects/${projectId}/api-keys/${keyId}`, {
    method: 'DELETE',
  });
}
