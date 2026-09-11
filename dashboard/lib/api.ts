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
