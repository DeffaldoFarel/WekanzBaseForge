// ============================================================================
// AUD-5-01 (FASE 5: Realtime & SSE) — backpressure SSE — repro & regression
//
// 🔴 send()/ping mengabaikan return res.write() → buffer tumbuh tanpa batas
//    untuk subscriber yang tidak membaca (probe lama: 805 KB dari 100 event
//    kecil). Fix: plafon antrean tulis (default 5 MB, env
//    MAX_SSE_BUFFERED_BYTES) — melewati plafon = koneksi DIPUTUS.
//
// File terpisah dari security-realtime-hardening karena durasinya (flood
// 14 MB): file lama mepet budget 15 detik per-file karena test retry
// webhook (AUD-5-02) yang memang lambat secara semantik.
//
// LINTAS PLATFORM (pelajaran deploy VPS 2026-10-20): besaran buffer kernel
// menentukan kapan writableLength mulai membesar — Windows sndbuf ~64 KB
// (cepat jenuh), Linux autotune bisa menelan ~10 MB (sndbuf 4 MB + rcvbuf
// 6 MB). Test lama (threshold default 5 MB, flood 6 MB) hijau di Windows
// tapi merah di Linux: subscriber paused TIDAK pernah melampaui 5 MB.
// Kini threshold di-set env kecil (512 KB) dan flood 14 MB ter-chunk:
//   - threshold HARUS > transien satu event (~136 KB = 200 KB − sndbuf)
//     supaya pembaca sehat tidak terputus oleh satu burst;
//   - flood HARUS > buffer kernel terbesar + threshold supaya subscriber
//     paused pasti terputus di platform mana pun.
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import nodeHttp from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initPlatformDb, closePlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';
import { createProjectAuthRouter } from '../src/api/authRoutes.js';
import { createPublicRouter } from '../src/api/publicRoutes.js';
import { createRealtimeRouter } from '../src/api/realtimeRoutes.js';
import { Router } from '../src/core/router.js';
import { realtimeHub } from '../src/core/realtime.js';

// ─── Harness ─────────────────────────────────────────────────────────────────

const SCRATCH = path.join(os.tmpdir(), 'baseforge-aud5bp-test');
let server: nodeHttp.Server;
let baseURL = '';
let pid = '';
let adminToken = '';

async function req(method: string, reqPath: string, body?: unknown, token?: string): Promise<{ status: number; data: any }> {
  const url = new URL(reqPath, baseURL);
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = 'Bear' + 'er ' + token;
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* stream */ }
  return { status: res.status, data };
}

interface SseConn {
  sock: net.Socket;
  events: { event: string; data: any }[];
  clientId: string;
  destroy(): void;
}

function sseConnect(p: string): Promise<SseConn> {
  return new Promise((resolve, reject) => {
    const port = Number(new URL(baseURL).port);
    const sock = net.connect(port, '127.0.0.1');
    const events: { event: string; data: any }[] = [];
    let buf = '';
    let clientId = '';
    let pending = { event: '', data: '' };
    let resolved = false;
    sock.on('connect', () => {
      sock.write(`GET /api/p/${p}/realtime HTTP/1.1\r\nHost: t\r\nAccept: text/event-stream\r\n\r\n`);
    });
    sock.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('event: ')) pending.event = line.slice(7).trim();
        else if (line.startsWith('data: ')) pending.data = line.slice(6);
        if (line === '' && pending.event) {
          try {
            const parsed = JSON.parse(pending.data);
            events.push({ event: pending.event, data: parsed });
            if (pending.event === 'PB_CONNECT' && !clientId) clientId = parsed.clientId;
          } catch { /* keepalive */ }
          pending = { event: '', data: '' };
        }
      }
      if (clientId && !resolved) {
        resolved = true;
        resolve({ sock, events, clientId, destroy: () => sock.destroy() });
      }
    });
    sock.on('error', (e) => { if (!resolved) { resolved = true; reject(e); } });
    setTimeout(() => { if (!resolved) { resolved = true; reject(new Error('SSE connect timeout')); } }, 4000);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.env.DATA_DIR = SCRATCH;
  process.env.ADMIN_EMAIL = 'admin@test.local';
  process.env.ADMIN_PASSWORD = 'admin-test-pass';

  initPlatformDb();
  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());
  router.merge(createProjectAuthRouter());
  router.merge(createPublicRouter());
  router.merge(createRealtimeRouter());
  server = nodeHttp.createServer((q, s) => router.handle(q, s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const login = await req('POST', '/api/admin/auth/login', { email: 'admin@test.local', password: 'admin-test-pass' });
  adminToken = login.data.token;
  const p1 = await req('POST', '/api/admin/projects', { name: 'aud5bp' }, adminToken);
  pid = p1.data.project.id;

  await req('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'docs',
    fields: [{ name: 'body', type: 'text' }],
    rules: { createRule: '', updateRule: '', viewRule: '', listRule: '' },
  }, adminToken);
});

after(async () => {
  delete process.env.MAX_SSE_BUFFERED_BYTES;
  closeAllProjectDbs();
  closePlatformDb();
  server.close();
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

// ─── AUD-5-01: backpressure — subscriber lambat diputus ─────────────────────

test('AUD-5-01: subscriber yang tidak membaca diputus sebelum buffer membesar', async () => {
  // Threshold via env → deterministik lintas platform. Harus DI ATAS transien
  // satu event (~136KB: event 200KB − sndbuf kernel 64KB) supaya pembaca
  // sehat tak pernah terputus oleh satu burst, tapi DI BAWAH akumulasi
  // subscriber paused di Linux (~3-4MB setelah buffer kernel ~10MB jenuh).
  // Produksi pakai default 5 MB; test pakai 512 KB.
  process.env.MAX_SSE_BUFFERED_BYTES = String(512 * 1024);
  try {
    const paused = await sseConnect(pid);
    await req('POST', `/api/p/${pid}/realtime/subscribe`, { clientId: paused.clientId, collection: 'docs' }, adminToken);
    paused.sock.pause(); // berhenti membaca — meniru client lambat/malicious

    const reader = await sseConnect(pid);
    await req('POST', `/api/p/${pid}/realtime/subscribe`, { clientId: reader.clientId, collection: 'docs' }, adminToken);

    // Flood TER-CHUNK: 70 × 200KB (14MB), jeda 25ms. Jeda memberi pembaca
    // aktif waktu drain antar chunk (200KB di localhost = mikro-detik →
    // selamat), sementara subscriber paused menumpuk terus — buffer kernel
    // Linux (autotune ~10MB) jenuh sekitar chunk 53, sisanya masuk antrean
    // userspace → melampaui 512KB → destroy di jalur send().
    const blob = 'X'.repeat(200_000);
    for (let i = 0; i < 70; i++) {
      await req('POST', `/api/p/${pid}/collections/docs/records`, { body: blob }, adminToken);
      await sleep(25);
    }

    // Subscriber paused harus DIPUTUS (dihapus dari hub) — bukan menumpuk buffer
    const start = Date.now();
    let clientsNow = realtimeHub.statsForProject(pid).clients;
    while (clientsNow > 1 && Date.now() - start < 6000) {
      await sleep(100);
      clientsNow = realtimeHub.statsForProject(pid).clients;
    }
    assert.equal(clientsNow, 1, `subscriber lambat harus diputus (clients=${clientsNow}, buffer unbounded tanpa fix)`);

    // Pembaca aktif tetap hidup dan menerima event
    assert.ok(reader.events.filter((e) => e.event === 'PB_CREATE').length >= 50, 'pembaca aktif menerima event (kontrol)');
    reader.destroy(); paused.destroy();
  } finally {
    delete process.env.MAX_SSE_BUFFERED_BYTES; // kembalikan default 5 MB untuk test lain
  }
});
