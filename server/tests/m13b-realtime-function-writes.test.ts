// ============================================================================
// M13b: TEST REALTIME dari TULISAN FUNCTION ($db)
//
// GAP (ditemukan 2026-10-19 di WekanzDashboard): realtimeHub.publish hanya
// dipanggil di API layer untuk tulisan CLIENT. Tulisan $db dari function
// (trigger/callable/cron) tidak pernah di-broadcast — field turunan
// backend (habits.streak, agregat investasi) tidak pernah terlihat realtime
// oleh subscriber SSE; UI harus refresh untuk melihat nilai baru.
//
// FIX: dbSandbox memanggil ctx.onRealtimeWrite pada SEMUA depth (gerbang
// anti-rekursi M41 hanya menekan TRIGGER — SSE tidak mengeksekusi kode,
// tidak mungkin loop). Closure publisher di-inject oleh triggerExecutor /
// functionRoutes / scheduler dengan projectId.
//
// PROOF di test ini:
// 1. Tulisan $db dari function TER-TRIGGER → PB_UPDATE sampai ke subscriber
//    TANPA refetch (jalur persis produksi: public route → trigger → $db).
// 2. Anti-loop tetap utuh: trigger habits juga terdaftar, tapi function
//    TIDAK jalan dua kali (fn_runs tepat 1).
// 3. Rules tetap dievaluasi SAAT PUBLISH untuk tulisan function —
//    anonymous tidak menerima event dari collection admin-only.
// 4. Delete via $db dari function callable → PB_DELETE dengan snapshot
//    penuh (pola M38).
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import nodeHttp from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { initPlatformDb, closePlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs } from '../src/core/projectDbManager.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';
import { createProjectAuthRouter } from '../src/api/authRoutes.js';
import { createPublicRouter } from '../src/api/publicRoutes.js';
import { createRealtimeRouter } from '../src/api/realtimeRoutes.js';
import { createFunctionRouter } from '../src/api/functionRoutes.js';
import { Router } from '../src/core/router.js';

// ─── State ───────────────────────────────────────────────────────────────────

let server: nodeHttp.Server;
let baseURL = '';
const TEST_DATA_DIR = path.resolve('../data/m13b-test');

let pid: string;
let adminToken: string;
let userAToken: string;
let userAId: string;
let habitId: string;

// ─── Setup + teardown ────────────────────────────────────────────────────────

before(async () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  process.env.DATA_DIR = TEST_DATA_DIR;
  process.env.ADMIN_EMAIL = 'admin@test.local';
  process.env.ADMIN_PASSWORD = 'admin-test-pass';
  process.env.STORAGE_DIR = path.join(TEST_DATA_DIR, 'storage');

  initPlatformDb();

  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());
  router.merge(createProjectAuthRouter());
  router.merge(createPublicRouter());
  router.merge(createRealtimeRouter());
  router.merge(createFunctionRouter());

  server = nodeHttp.createServer((req, res) => {
    router.handle(req, res);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      baseURL = `http://localhost:${addr.port}`;
      resolve();
    });
  });

  const login = await http('POST', '/api/admin/auth/login', { email: 'admin@test.local', password: 'admin-test-pass' });
  adminToken = login.data.token;

  const proj = await http('POST', '/api/admin/projects', { name: 'm13b' }, adminToken);
  pid = proj.data.project.id;

  // Collections — meniru skema habit WekanzDashboard
  await http('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'habits',
    fields: [
      { name: 'name', type: 'text', required: true },
      { name: 'userId', type: 'text' },
      { name: 'streak', type: 'number' },
    ],
  }, adminToken);
  await http('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'habit_logs',
    fields: [
      { name: 'habitId', type: 'text', required: true },
      { name: 'date', type: 'text' },
      { name: 'value', type: 'number' },
      { name: 'userId', type: 'text' },
    ],
  }, adminToken);
  await http('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'fn_runs',
    fields: [
      { name: 'userId', type: 'text' },
      { name: 'tag', type: 'text' },
    ],
  }, adminToken);

  // Own-data rules — end user hanya melihat & membuat miliknya
  for (const col of ['habits', 'habit_logs']) {
    await http('PATCH', `/api/admin/projects/${pid}/collections/${col}/rules`, {
      listRule: 'userId = @request.auth.id',
      createRule: 'userId = @request.auth.id',
    }, adminToken);
  }

  // Function penghitung streak — menulis fn_runs + habits.streak via $db.
  // Trigger HABITS sengaja ikut didaftarkan: kalau gerbang anti-rekursi
  // M41 bocor, update habits dari function ini akan men-trigger dirinya
  // sendiri → fn_runs meledak (assertion #2 menangkapnya).
  await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'streak_updater',
    code: [
      "await $db.collection('fn_runs').create({ userId: String(req.record.userId || 'anon'), tag: 'run' });",
      "await $db.collection('habits').update(String(req.record.habitId), { streak: 5 });",
      'return { ok: true };',
    ].join('\n'),
    dbAccess: true,
    enabled: true,
    timeoutMs: 10000,
    triggers: [
      { collection: 'habit_logs', actions: ['create'] },
      { collection: 'habits', actions: ['create', 'update', 'delete'] },
    ],
  }, adminToken);

  // Function callable penghapus log — untuk uji jalur delete + callable
  await http('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'log_deleter',
    code: "await $db.collection('habit_logs').delete(String(req.body.logId)); return { deleted: true };",
    dbAccess: true,
    enabled: true,
    timeoutMs: 10000,
  }, adminToken);

  // End user (persis produksi: client publik yang menulis habit_logs)
  const reg = await http('POST', `/api/p/${pid}/auth/register`, { email: 'a@m13b.test', password: 'passwordA123' });
  userAToken = reg.data.accessToken;
  userAId = reg.data.user.id;

  // Habit milik user A
  const habit = await http('POST', `/api/p/${pid}/collections/habits/records`, {
    name: 'Morning Run', userId: userAId, streak: 0,
  }, userAToken);
  assert.equal(habit.status, 201, 'habit create harus sukses');
  habitId = habit.data.record.id;
});

after(async () => {
  closeAllProjectDbs();
  // Windows: rmSync gagal EPERM selama handle platform.db masih terbuka.
  closePlatformDb();
  server.close();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ─── HTTP helper ─────────────────────────────────────────────────────────────

async function http(method: string, reqPath: string, body?: unknown, token?: string): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(reqPath, baseURL);
    const req = nodeHttp.request(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let data: any = null;
        try { data = JSON.parse(text); } catch { /* stream */ }
        resolve({ status: res.statusCode ?? 0, data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── SSE client helper ───────────────────────────────────────────────────────

interface SseEvent {
  event: string;
  data: any;
}

function openSse(reqPath: string, token?: string): { events: SseEvent[]; req: nodeHttp.ClientRequest } {
  const events: SseEvent[] = [];
  const url = new URL(reqPath, baseURL);
  const req = nodeHttp.request(url, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  req.end();
  req.on('response', (res) => {
    let buffer = '';
    res.setEncoding('utf-8');
    res.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const evMatch = frame.match(/event: (.+)/);
        const dataMatch = frame.match(/data: (.+)/);
        if (evMatch) {
          let data: any = null;
          try { data = JSON.parse(dataMatch?.[1] ?? 'null'); } catch { data = dataMatch?.[1] ?? null; }
          events.push({ event: evMatch[1].trim(), data });
        }
      }
    });
  });

  return { events, req };
}

async function subscribe(token: string | undefined, collection: string): Promise<{ events: SseEvent[]; req: nodeHttp.ClientRequest }> {
  const sse = openSse(`/api/p/${pid}/realtime`, token);
  await new Promise((r) => setTimeout(r, 300));
  const clientId = sse.events[0]?.data?.clientId;
  assert.ok(clientId, 'PB_CONNECT harus datang dulu');
  const sub = await http('POST', `/api/p/${pid}/realtime/subscribe`, { clientId, collection }, token);
  assert.equal(sub.status, 200, `subscribe ${collection} harus sukses`);
  await new Promise((r) => setTimeout(r, 200));
  return sse;
}

async function waitFor(cond: () => boolean, ms = 10000, step = 100): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return cond();
}

function eventsOf(sse: { events: SseEvent[] }, name: string, collection: string): SseEvent[] {
  return sse.events.filter(
    (e) => e.event === name && e.data?.collection === collection,
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('M13b FIX: tulisan $db function ter-trigger sampai ke subscriber SSE tanpa refetch', async () => {
  // Subscriber ADMIN (auth undefined → lolos semua rules) pada habits + fn_runs
  const adminSse = await subscribe(adminToken, 'habits');
  const adminRuns = await subscribe(adminToken, 'fn_runs');

  // Jalur persis produksi: END USER menulis habit_logs lewat public route
  const log = await http('POST', `/api/p/${pid}/collections/habit_logs/records`, {
    habitId, date: '2026-10-19', value: 1, userId: userAId,
  }, userAToken);
  assert.equal(log.status, 201, 'habit_logs create harus sukses');

  // Inti perbaikan: PB_UPDATE habits (streak dari FUNCTION) harus datang.
  const gotUpdate = await waitFor(() =>
    eventsOf(adminSse, 'PB_UPDATE', 'habits').some((e) => e.data?.record?.streak === 5),
  );
  assert.ok(gotUpdate, 'PB_UPDATE habits.streak=5 dari tulisan $db function harus diterima SSE');

  // Marker eksekusi function — tepat 1 (anti-loop M41 tetap utuh).
  const gotRun = await waitFor(() => eventsOf(adminRuns, 'PB_CREATE', 'fn_runs').length >= 1);
  assert.ok(gotRun, 'function harus jalan minimal sekali (fn_runs dibuat)');
  await new Promise((r) => setTimeout(r, 1200)); // jendela stabilisasi anti-loop
  const runCount = eventsOf(adminRuns, 'PB_CREATE', 'fn_runs').length;
  assert.equal(runCount, 1, `anti-loop: function harus jalan TEPAT 1x (got ${runCount}) — update habits tidak boleh men-trigger ulang`);

  adminSse.req.destroy();
  adminRuns.req.destroy();
});

test('M13b RULES: anonymous tidak menerima realtime dari tulisan function pada collection admin-only', async () => {
  // fn_runs → admin-only (listRule null). Anonymous subscribe, admin subscribe.
  await http('PATCH', `/api/admin/projects/${pid}/collections/fn_runs/rules`, { listRule: null }, adminToken);

  const anonSse = await subscribe(undefined, 'fn_runs');
  const adminRuns = await subscribe(adminToken, 'fn_runs');

  // Tulisan habit_logs men-trigger function → fn_runs dibuat function.
  const log = await http('POST', `/api/p/${pid}/collections/habit_logs/records`, {
    habitId, date: '2026-10-20', value: 1, userId: userAId,
  }, userAToken);
  assert.equal(log.status, 201);

  const adminGotIt = await waitFor(() => eventsOf(adminRuns, 'PB_CREATE', 'fn_runs').length >= 1);
  assert.ok(adminGotIt, 'admin subscriber harus menerima event fn_runs dari tulisan function');
  await new Promise((r) => setTimeout(r, 800));

  assert.equal(
    eventsOf(anonSse, 'PB_CREATE', 'fn_runs').length, 0,
    'RULES saat publish tetap berlaku untuk tulisan function — anonymous diblok',
  );

  anonSse.req.destroy();
  adminRuns.req.destroy();
});

test('M13b DELETE: $db delete dari function callable → PB_DELETE dengan snapshot penuh', async () => {
  const adminLogs = await subscribe(adminToken, 'habit_logs');

  const log = await http('POST', `/api/p/${pid}/collections/habit_logs/records`, {
    habitId, date: '2026-10-21', value: 1, userId: userAId,
  }, userAToken);
  assert.equal(log.status, 201);
  const logId = log.data.record.id;

  // echo realtime dari tulisan CLIENT (bukan bagian fix — sanity saja)
  await waitFor(() => eventsOf(adminLogs, 'PB_CREATE', 'habit_logs').some((e) => e.data?.record?.id === logId));

  // Callable admin: function menghapus log via $db
  const exec = await http('POST', `/api/admin/projects/${pid}/functions/log_deleter/execute`, {
    body: { logId },
  }, adminToken);
  assert.equal(exec.status, 200, `execute harus sukses: ${JSON.stringify(exec.data)}`);

  const gotDelete = await waitFor(() =>
    eventsOf(adminLogs, 'PB_DELETE', 'habit_logs').some((e) => e.data?.record?.id === logId),
  );
  assert.ok(gotDelete, 'PB_DELETE habit_logs dari tulisan $db function harus diterima');

  const del = eventsOf(adminLogs, 'PB_DELETE', 'habit_logs').find((e) => e.data?.record?.id === logId);
  assert.equal(del?.data?.record?.habitId, habitId, 'payload delete harus snapshot PENUH (pola M38)');

  adminLogs.req.destroy();
});
