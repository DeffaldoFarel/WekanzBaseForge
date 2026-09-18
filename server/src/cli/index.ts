#!/usr/bin/env node
// ============================================================================
// M28: BASEFORGE CLI — kelola platform dari terminal
//
// Entry: `npm run cli` (dev) / `baseforge` (setelah build+link)
//
// Konvensi:
//   baseforge <command> <subcommand> [options]
//   --url <host>     BaseForge server (default http://localhost:5100)
//   --pid <id>       project ID (atau disimpan via `baseforge use <pid>`)
//
// State lokal: ~/.baseforge/cli.json (token + project aktif)
//
// Commands:
//   login <email>              → simpan admin token
//   logout                     → hapus state
//   whoami                     → tampilkan identitas + project aktif
//   use <projectId>            → set project aktif
//   projects [list|create|delete]
//   collections [list|schema]
//   records list [collection] [--filter --page --perPage]
//   records create <collection> <json>
//   records delete <collection> <id>
//   functions [list]
//   users [list] [--page]
//   webhooks [list]
//   help
// ============================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { resetAdminPassword } from '../platform/resetAdminPassword.js';

// ─── Arg parsing (sengaja tanpa library — pelajaran router M00!) ──────────────

const args = process.argv.slice(2);
const command = args[0] ?? 'help';
// Subcommand hanya ada untuk perintah yang memang memakainya (records,
// collections, functions, dst.). Perintah tanpa subcommand seperti
// reset-admin-password harus mulai parsing flag dari args[1], bukan args[2].
const hasSubcommand = ['records', 'collections', 'functions', 'projects', 'users', 'webhooks', 'use', 'login'].includes(command);
const subcommand = hasSubcommand ? (args[1] ?? '') : '';
const flags: Record<string, string> = {};

for (let i = hasSubcommand ? 2 : 1; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
    flags[key] = val;
  }
}

// ─── State lokal ──────────────────────────────────────────────────────────────

const STATE_DIR = join(homedir(), '.baseforge');
const STATE_FILE = join(STATE_DIR, 'cli.json');

interface CliState {
  token: string | null;
  project: string | null;
  url: string;
}

function loadState(): CliState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    }
  } catch { /* korup → mulai baru */ }
  return { token: null, project: null, url: 'http://localhost:5100' };
}

function saveState(state: CliState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const state = loadState();
if (flags.url) {
  state.url = flags.url;
  saveState(state);
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

interface ApiResponse {
  status: number;
  data: any;
}

async function api(method: string, path: string, body?: unknown, token?: string): Promise<ApiResponse> {
  const res = await fetch(state.url + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ?? state.token ? { Authorization: `Bearer ${token ?? state.token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: any = {};
  try { data = await res.json(); } catch { /* body kosong */ }
  return { status: res.status, data };
}

function pid(): string {
  const p = flags.pid ?? state.project;
  if (!p) {
    console.error('Error: no project selected. Run `baseforge use <projectId>` or pass --pid.');
    process.exit(1);
  }
  return p;
}

function requireToken(): string {
  if (!state.token) {
    console.error('Error: not logged in. Run `baseforge login <email>`.');
    process.exit(1);
  }
  return state.token;
}

function printError(data: any, status: number): void {
  const msg = data?.error?.message ?? JSON.stringify(data);
  console.error(`Error (${status}): ${msg}`);
  process.exit(1);
}

// ─── Output helpers (format ringkas ala tabel) ────────────────────────────────

function table(rows: string[][], headers: string[]): void {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length))
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ');
  console.log(line(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  rows.forEach((r) => console.log(line(r)));
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdLogin(): Promise<void> {
  const email = subcommand;
  if (!email) {
    console.error('Usage: baseforge login <email>');
    process.exit(1);
  }
  console.log(`Password: `);
  // Baca password dari stdin (tanpa echo — pakai readline sederhana; echo
  // tidak dimatikan untuk kompatibilitas cross-platform)
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', resolve);
    process.stdin.on('close', resolve);
  });
  const password = Buffer.concat(chunks).toString('utf8').trim();
  if (!password) {
    console.error('Password is required.');
    process.exit(1);
  }

  const res = await api('POST', '/api/admin/auth/login', { email, password }, '');
  if (res.status !== 200) printError(res.data, res.status);
  state.token = res.data.token;
  saveState(state);
  console.log(`Logged in as ${email} (${state.url})`);
}

async function cmdLogout(): Promise<void> {
  state.token = null;
  state.project = null;
  saveState(state);
  console.log('Logged out.');
}

async function cmdWhoami(): Promise<void> {
  if (!state.token) {
    console.log('Not logged in.');
    return;
  }
  const res = await api('GET', '/api/admin/auth/me');
  if (res.status !== 200) {
    console.log('Token expired — login again.');
    return;
  }
  console.log(`Admin: ${res.data.admin?.email}`);
  console.log(`Server: ${state.url}`);
  console.log(`Project: ${state.project ?? '(not selected)'}`);
}

async function cmdUse(): Promise<void> {
  const p = subcommand;
  if (!p) {
    console.error('Usage: baseforge use <projectId>');
    process.exit(1);
  }
  // verifikasi project ada
  const res = await api('GET', `/api/admin/projects/${p}`);
  if (res.status !== 200) printError(res.data, res.status);
  state.project = p;
  saveState(state);
  console.log(`Active project: ${res.data.project?.name} (${p})`);
}

async function cmdProjects(): Promise<void> {
  requireToken();
  if (subcommand === 'create') {
    const name = args[2];
    if (!name) { console.error('Usage: baseforge projects create <name>'); process.exit(1); }
    const res = await api('POST', '/api/admin/projects', { name });
    if (res.status !== 201) printError(res.data, res.status);
    console.log(`Created: ${res.data.project?.name} (${res.data.project?.id})`);
    return;
  }
  if (subcommand === 'delete') {
    const p = args[2];
    if (!p) { console.error('Usage: baseforge projects delete <projectId>'); process.exit(1); }
    const res = await api('DELETE', `/api/admin/projects/${p}`);
    if (res.status !== 200) printError(res.data, res.status);
    console.log(`Deleted: ${p}`);
    return;
  }
  // list (default)
  const res = await api('GET', '/api/admin/projects');
  if (res.status !== 200) printError(res.data, res.status);
  const rows = (res.data.projects as any[]).map((p) => [
    p.id, p.name, new Date(p.created).toLocaleDateString(),
  ]);
  table(rows, ['ID', 'NAME', 'CREATED']);
}

async function cmdCollections(): Promise<void> {
  requireToken();
  const p = pid();
  if (subcommand === 'schema') {
    const name = args[2];
    const res = await api('GET', `/api/admin/projects/${p}/collections/${name ?? ''}/schema`);
    if (res.status !== 200) printError(res.data, res.status);
    console.log(JSON.stringify(res.data, null, 2));
    return;
  }
  // list (default)
  const res = await api('GET', `/api/admin/projects/${p}/collections`);
  if (res.status !== 200) printError(res.data, res.status);
  const rows = (res.data.collections as any[]).map((c) => [
    c.name, c.type, String(c.fields.length), String(c.recordCount ?? 0),
  ]);
  table(rows, ['NAME', 'TYPE', 'FIELDS', 'RECORDS']);
}

async function cmdRecords(): Promise<void> {
  requireToken();
  const p = pid();

  if (subcommand === 'list') {
    const collection = args[2];
    if (!collection) { console.error('Usage: baseforge records list <collection>'); process.exit(1); }
    const params = new URLSearchParams();
    if (flags.filter) params.set('filter', flags.filter);
    if (flags.page) params.set('page', flags.page);
    if (flags.perPage) params.set('perPage', flags.perPage);
    const qs = params.toString() ? `?${params}` : '';
    const res = await api('GET', `/api/p/${p}/collections/${collection}/records${qs}`);
    if (res.status !== 200) printError(res.data, res.status);
    const items = res.data.items as any[];
    items.forEach((item) => console.log(JSON.stringify(item)));
    console.error(`--- ${res.data.totalItems} records (page ${res.data.page}/${res.data.totalPages})`);
    return;
  }

  if (subcommand === 'create') {
    const collection = args[2];
    const json = args[3];
    if (!collection || !json) {
      console.error('Usage: baseforge records create <collection> \'{"key":"value"}\'');
      process.exit(1);
    }
    let data: unknown;
    try { data = JSON.parse(json); } catch {
      console.error('Error: body must be valid JSON');
      process.exit(1);
    }
    const res = await api('POST', `/api/p/${p}/collections/${collection}/records`, data);
    if (res.status !== 201) printError(res.data, res.status);
    console.log(JSON.stringify(res.data.record, null, 2));
    return;
  }

  if (subcommand === 'delete') {
    const collection = args[2];
    const id = args[3];
    if (!collection || !id) {
      console.error('Usage: baseforge records delete <collection> <id>');
      process.exit(1);
    }
    const res = await api('DELETE', `/api/p/${p}/collections/${collection}/records/${id}`);
    if (res.status !== 200) printError(res.data, res.status);
    console.log(`Deleted: ${id}`);
    return;
  }

  console.error('Usage: baseforge records <list|create|delete> ...');
  process.exit(1);
}

async function cmdFunctions(): Promise<void> {
  requireToken();
  const p = pid();
  if (subcommand === 'run') {
    const name = args[2];
    const body = args[3] ?? '{}';
    if (!name) { console.error('Usage: baseforge functions run <name> [json]'); process.exit(1); }
    const res = await api('POST', `/api/admin/projects/${p}/functions/${name}/execute`, { body: JSON.parse(body) });
    if (res.status !== 200) printError(res.data, res.status);
    console.log(JSON.stringify(res.data, null, 2));
    return;
  }
  // list (default)
  const res = await api('GET', `/api/admin/projects/${p}/functions`);
  if (res.status !== 200) printError(res.data, res.status);
  const rows = (res.data.functions as any[]).map((f) => [
    f.name, f.enabled ? 'enabled' : 'disabled', `${f.timeoutMs}ms`,
    f.schedule ?? (f.triggers.length > 0 ? `trigger×${f.triggers.length}` : 'callable'),
  ]);
  table(rows, ['NAME', 'STATUS', 'TIMEOUT', 'TYPE']);
}

async function cmdUsers(): Promise<void> {
  requireToken();
  const p = pid();
  const page = flags.page ?? '1';
  const res = await api('GET', `/api/admin/projects/${p}/auth-users?page=${page}`);
  if (res.status !== 200) printError(res.data, res.status);
  const rows = (res.data.items as any[]).map((u) => [
    u.id, u.email, u.verified ? '✓' : '—', u.mfaEnabled ? '✓' : '—',
  ]);
  table(rows, ['ID', 'EMAIL', 'VERIFIED', 'MFA']);
  console.error(`--- ${res.data.totalItems} users (page ${res.data.page}/${res.data.totalPages})`);
}

async function cmdWebhooks(): Promise<void> {
  requireToken();
  const p = pid();
  const res = await api('GET', `/api/admin/projects/${p}/webhooks`);
  if (res.status !== 200) printError(res.data, res.status);
  const rows = (res.data.webhooks as any[]).map((w) => [
    w.id, w.name, w.enabled ? 'enabled' : 'disabled', w.events.join(', '),
  ]);
  if (rows.length === 0) { console.log('(no webhooks)'); return; }
  table(rows, ['ID', 'NAME', 'STATUS', 'EVENTS']);
}

async function cmdResetAdminPassword(): Promise<void> {
  const email = flags.email;
  if (!email) {
    console.error('Usage: baseforge reset-admin-password --email <email> [--password <baru>]');
    console.error('  Tanpa --password, CLI akan meminta secara interaktif (tidak echo).');
    process.exit(1);
  }

  let password = flags.password;
  if (!password) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    password = await new Promise<string>((resolve) => {
      rl.question('Password baru: ', (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  if (!password) {
    console.error('Password baru tidak boleh kosong.');
    process.exit(1);
  }

  const r = resetAdminPassword(email, password);
  if (!r.ok) {
    console.error(r.error);
    process.exit(1);
  }

  console.log(`Password untuk '${email}' berhasil direset.`);
  console.log('Login ulang di BaseForge Console dengan password baru.');
  process.exit(0);
}

function cmdHelp(): void {
  console.log(`BaseForge CLI — manage your BaaS from the terminal

Usage: baseforge <command> [subcommand] [options]

Commands:
  login <email>               Save admin token (prompt for password)
  logout                      Clear saved state
  whoami                      Show current identity + project
  use <projectId>             Set active project
  projects [list|create|delete]
  collections [list|schema <name>]
  records list <collection> [--filter --page --perPage]
  records create <collection> '<json>'
  records delete <collection> <id>
  functions [list|run <name> [json]]
  users [list] [--page]
  webhooks [list]
  reset-admin-password      Reset password admin platform (offline, butuh akses filesystem)
  help                        Show this help

Options:
  --url <host>    BaseForge server URL (default: http://localhost:5100, saved)
  --pid <id>      Override active project for this command
  --email <email> Admin email (for reset-admin-password)
  --password <pw> New password (for reset-admin-password; omit to prompt interactively)
  --filter, --page, --perPage   Record list options

State: ~/.baseforge/cli.json (token + active project + server URL)`);
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

const commands: Record<string, () => Promise<void> | void> = {
  login: cmdLogin,
  logout: cmdLogout,
  whoami: cmdWhoami,
  use: cmdUse,
  projects: cmdProjects,
  collections: cmdCollections,
  records: cmdRecords,
  functions: cmdFunctions,
  users: cmdUsers,
  webhooks: cmdWebhooks,
  'reset-admin-password': cmdResetAdminPassword,
  help: cmdHelp,
};

const handler = commands[command];
if (!handler) {
  console.error(`Unknown command: '${command}'. Run \`baseforge help\`.`);
  process.exit(1);
}
await handler();
