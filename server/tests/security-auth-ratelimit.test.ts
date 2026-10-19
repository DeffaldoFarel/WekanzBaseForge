// ============================================================================
// SECURITY: rate limiting auth — temuan audit FASE 1 (2026-10)
//
// AUD-1-01 — clientIp() memercayai X-Forwarded-For mentah (entri PERTAMA):
//   client bisa mengirim header XFF sendiri → rate limit per-IP netral total
//   (login/register/mail/oauth/mfa-enroll semua bypass). Probe lama: 25 login
//   dengan IP palsu yang berputar → 429=0. Kini: default proxy TIDAK
//   dipercaya (pakai socket.remoteAddress); TRUST_PROXY=true → hop TERAKHIR
//   XFF yang dihitung (nilai yang ditambahkan proxy tepercaya kita).
//
// AUD-1-02 — POST /api/admin/auth/login tanpa rate limit sama sekali:
//   probe lama: 30 brute force → 429=0. Kini: per-IP (10/15 menit) DAN
//   per-email (10/15 menit) — defense in depth terhadap rotasi IP.
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import nodeHttp from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { initPlatformDb, closePlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createProjectAuthRouter } from '../src/api/authRoutes.js';
import { resetAllRateLimits, closeRateLimiter } from '../src/auth/rateLimiter.js';
import { Router } from '../src/core/router.js';

let server: nodeHttp.Server;
let baseURL = '';
const TEST_DATA_DIR = path.resolve('../data/sec-auth-rl-test');

let pid: string;
let adminToken: string;

async function http(method: string, reqPath: string, body?: unknown, token?: string, extraHeaders?: Record<string, string>): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, baseURL);
    const req = nodeHttp.request(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(extraHeaders ?? {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let data: any = null;
        try { data = JSON.parse(text); } catch { data = null; }
        resolve({ status: res.statusCode ?? 0, data });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

before(async () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  process.env.DATA_DIR = TEST_DATA_DIR;
  process.env.ADMIN_EMAIL = 'admin@test.local';
  process.env.ADMIN_PASSWORD = 'admin-test-pass';
  process.env.STORAGE_DIR = path.join(TEST_DATA_DIR, 'storage');
  delete process.env.TRUST_PROXY; // default: proxy tidak dipercaya

  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createProjectAuthRouter());

  server = nodeHttp.createServer((req, res) => { router.handle(req, res); });
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      baseURL = `http://localhost:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });

  const login = await http('POST', '/api/admin/auth/login', { email: 'admin@test.local', password: 'admin-test-pass' });
  adminToken = login.data.token;

  const proj = await http('POST', '/api/admin/projects', { name: 'sec-auth-rl' }, adminToken);
  pid = proj.data.project.id;

  const reg = await http('POST', `/api/p/${pid}/auth/register`, { email: 'victim@rl.test', password: 'victim-pass-123' });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
});

after(async () => {
  delete process.env.TRUST_PROXY;
  await closeRateLimiter();
  closeAllProjectDbs();
  closePlatformDb();
  server.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test('AUD-1-01: spoofing X-Forwarded-For tidak lagi mem-bypass rate limit login (default)', async () => {
  await resetAllRateLimits();
  let s401 = 0, s429 = 0;
  for (let i = 0; i < 15; i++) {
    const r = await http('POST', `/api/p/${pid}/auth/login`,
      { email: 'victim@rl.test', password: 'totally-wrong' }, undefined,
      { 'x-forwarded-for': `10.66.${i}.${(i * 7) % 250}` });
    if (r.status === 401) s401++; else if (r.status === 429) s429++;
  }
  // Sebelum fix: 401=15, 429=0 (bypass total). Sesudah fix: XFF diabaikan →
  // semua hitung dari IP socket yang sama → limit 10/menit berlaku.
  assert.ok(s429 > 0, `spoof XFF harus tetap kena rate limit (401=${s401}, 429=${s429})`);
  assert.equal(s401, 10, '10 percobaan pertama diizinkan (limit 10/menit)');
});

test('AUD-1-01: TRUST_PROXY=true → hop TERAKHIR XFF yang dihitung (bukan entri pertama)', async () => {
  process.env.TRUST_PROXY = 'true';
  await resetAllRateLimits();
  let s401 = 0, s429 = 0;
  // Entri pertama berputar (spoof), entri terakhir tetap 9.9.9.9 (ditambah proxy)
  for (let i = 0; i < 12; i++) {
    const r = await http('POST', `/api/p/${pid}/auth/login`,
      { email: 'victim@rl.test', password: 'totally-wrong' }, undefined,
      { 'x-forwarded-for': `spoofed-${i}.example, 9.9.9.9` });
    if (r.status === 401) s401++; else if (r.status === 429) s429++;
  }
  assert.ok(s429 > 0, `spoof entri pertama tidak boleh lolos saat proxy dipercaya (401=${s401}, 429=${s429})`);
  assert.equal(s401, 10);
  delete process.env.TRUST_PROXY;
});

test('AUD-1-02: admin login kena rate limit setelah 10 percobaan gagal', async () => {
  await resetAllRateLimits();
  let a401 = 0, a429 = 0;
  for (let i = 0; i < 12; i++) {
    const r = await http('POST', '/api/admin/auth/login', { email: 'admin@test.local', password: `brute-${i}` });
    if (r.status === 401) a401++; else if (r.status === 429) a429++;
  }
  assert.equal(a401, 10, `10 gagal pertama = 401 (dapat ${a401})`);
  assert.ok(a429 >= 2, `percobaan 11-12 harus 429 (dapat ${a429}) — sebelumnya TIDAK ADA limit`);

  // Kredensial BENAR pun ditolak selama limit aktif (bucket per-IP)
  const correct = await http('POST', '/api/admin/auth/login', { email: 'admin@test.local', password: 'admin-test-pass' });
  assert.equal(correct.status, 429, 'login benar harus tetap 429 selama window aktif');
});

test('AUD-1-02: bucket per-email — IP berbeda-beda tetap kena limit email yang sama', async () => {
  // Bucket email 'admin@test.local' sudah penuh dari test sebelumnya.
  // Sekarang datang dari IP socket "berbeda" (XFF-last unik, TRUST_PROXY on).
  process.env.TRUST_PROXY = 'true';
  const r = await http('POST', '/api/admin/auth/login',
    { email: 'admin@test.local', password: 'admin-test-pass' }, undefined,
    { 'x-forwarded-for': '8.8.8.8' });
  assert.equal(r.status, 429, 'per-email bucket harus tetap memblok meski IP berbeda');
  delete process.env.TRUST_PROXY;
});
