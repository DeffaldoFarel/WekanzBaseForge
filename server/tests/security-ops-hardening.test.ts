// ============================================================================
// AUD-8-O1/O2 (FASE 8: Ops/Deploy) — repro & regression
//
// O-1 🟠 CORS 'Access-Control-Allow-Origin: *' TANPA syarat di produksi
//      (komentarnya sendiri bilang "dev only!") + X-API-Key hilang dari
//      Allow-Headers (klien browser ber-API-key diblokir preflight).
// O-2 🔵 tidak ada 'X-Content-Type-Options: nosniff' global untuk respons API.
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import nodeHttp from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initPlatformDb, closePlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { Router } from '../src/core/router.js';
import { corsMiddleware } from '../src/core/serverMiddleware.js';

// ─── Harness (router DENGAN middleware — seperti index.ts produksi) ─────────

const SCRATCH = path.join(os.tmpdir(), 'baseforge-aud8-test');
let server: nodeHttp.Server;
let baseURL = '';

function http(method: string, reqPath: string, origin?: string): Promise<{ status: number; headers: Record<string, string | undefined> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, baseURL);
    const req = nodeHttp.request(url, {
      method,
      headers: origin ? { Origin: origin } : {},
    }, (res) => {
      const h: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(res.headers)) h[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
      res.resume(); // buang body
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: h }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.env.DATA_DIR = SCRATCH;
  process.env.ADMIN_EMAIL = 'admin@test.local';
  process.env.ADMIN_PASSWORD = 'admin-test-pass';

  initPlatformDb();
  const router = new Router();
  router.use(corsMiddleware); // seperti index.ts — middleware CORS global
  router.merge(createAdminRouter()); // /api/health ada di sini
  server = nodeHttp.createServer((q, s) => router.handle(q, s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  delete process.env.CORS_ALLOWED_ORIGINS;
  delete process.env.NODE_ENV;
  closeAllProjectDbs();
  closePlatformDb();
  server.close();
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

test('AUD-8-O1: default di luar production tetap * (workflow dev tidak pecah)', async () => {
  delete process.env.CORS_ALLOWED_ORIGINS;
  delete process.env.NODE_ENV;
  const r = await http('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.headers['access-control-allow-origin'], '*');
});

test('AUD-8-O1: CORS_ALLOWED_ORIGINS → origin terpantulkan saat diizinkan', async () => {
  process.env.CORS_ALLOWED_ORIGINS = 'https://dash.example,https://other.example';
  const r = await http('GET', '/api/health', 'https://dash.example');
  assert.equal(r.status, 200);
  assert.equal(r.headers['access-control-allow-origin'], 'https://dash.example',
    `origin diizinkan harus dipantulkan spesifik (dapat ${r.headers['access-control-allow-origin']})`);
});

test('AUD-8-O1: origin asing TIDAK mendapat Access-Control-Allow-Origin', async () => {
  process.env.CORS_ALLOWED_ORIGINS = 'https://dash.example';
  const r = await http('GET', '/api/health', 'https://evil.example');
  assert.equal(r.status, 200);
  assert.equal(r.headers['access-control-allow-origin'], undefined,
    `origin asing tidak boleh dapat ACAO '*' (dapat ${r.headers['access-control-allow-origin']})`);
});

test('AUD-8-O1: preflight OPTIONS → 204 + X-API-Key di Allow-Headers', async () => {
  process.env.CORS_ALLOWED_ORIGINS = 'https://dash.example';
  const r = await http('OPTIONS', '/api/health', 'https://dash.example');
  assert.equal(r.status, 204);
  const allow = String(r.headers['access-control-allow-headers'] ?? '');
  assert.ok(allow.includes('X-API-Key'), `X-API-Key harus diizinkan preflight (dapat: ${allow})`);
  assert.ok(allow.includes('Authorization'));
});

test('AUD-8-O2: semua respons API membawa nosniff', async () => {
  process.env.CORS_ALLOWED_ORIGINS = 'https://dash.example';
  const r = await http('GET', '/api/health');
  assert.equal(r.headers['x-content-type-options'], 'nosniff',
    `header nosniff global wajib ada (dapat ${r.headers['x-content-type-options']})`);
});

test('AUD-8-O1: production TANPA env CORS → tidak mengirim ACAO sama sekali', async () => {
  delete process.env.CORS_ALLOWED_ORIGINS;
  process.env.NODE_ENV = 'production';
  try {
    const r = await http('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.headers['access-control-allow-origin'], undefined,
      `production tanpa allowlist tidak boleh menjawab '*' (dapat ${r.headers['access-control-allow-origin']})`);
  } finally {
    delete process.env.NODE_ENV;
  }
});

test('AUD-8-O1: production DENGAN allowlist → origin terpantulkan', async () => {
  process.env.CORS_ALLOWED_ORIGINS = 'https://baseforge.wekanz.id';
  process.env.NODE_ENV = 'production';
  try {
    const r = await http('GET', '/api/health', 'https://baseforge.wekanz.id');
    assert.equal(r.headers['access-control-allow-origin'], 'https://baseforge.wekanz.id');
    const r2 = await http('GET', '/api/health', 'https://evil.example');
    assert.equal(r2.headers['access-control-allow-origin'], undefined);
  } finally {
    delete process.env.NODE_ENV;
    delete process.env.CORS_ALLOWED_ORIGINS;
  }
});
