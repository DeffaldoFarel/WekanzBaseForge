// ============================================================================
// AUD-6-01..04 (FASE 6: Engine Correctness) — repro & regression
//
// AUD-6-01 🔴 rebuildCollection DROP TABLE ikut menghapus trigger FTS dan
//          tidak pernah membuatnya ulang → index beku/stale selamanya.
// AUD-6-02 🟡 updateCollection (PATCH) menyimpan options field existing
//          (unique/fulltext) ke meta tanpa menyentuh fisik → meta bohong,
//          duplikat diterima, ?search= rusak.
// AUD-6-03 🟡 cascade delete hanya 1 level: grandchild menggantung, file anak
//          orphan, tanpa event/trigger anak.
// AUD-6-04 🔵 ROLLBACK tak terlindungi: kegagalan ROLLBACK menimpa error
//          asli + transaksi zombie tertinggal.
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import nodeHttp from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initPlatformDb, closePlatformDb } from '../src/core/platformDb.js';
import { closeAllProjectDbs, getProjectDb } from '../src/core/projectDbManager.js';
import { createAdminRouter } from '../src/api/adminRoutes.js';
import { createDatabaseRouter } from '../src/api/databaseRoutes.js';
import { createProjectAuthRouter } from '../src/api/authRoutes.js';
import { createPublicRouter } from '../src/api/publicRoutes.js';
import { createRealtimeRouter } from '../src/api/realtimeRoutes.js';
import { createFunctionRouter } from '../src/api/functionRoutes.js';
import { Router } from '../src/core/router.js';
import { createRecordsBatch } from '../src/core/records.js';

// ─── Harness ─────────────────────────────────────────────────────────────────

const SCRATCH = path.join(os.tmpdir(), 'baseforge-aud6-test');
const STORAGE_DIR = path.join(SCRATCH, 'storage');
let server: nodeHttp.Server;
let baseURL = '';
let pid = '';
let adminToken = '';

async function req(method: string, reqPath: string, body?: unknown, token?: string, raw?: { body: Buffer; contentType: string }): Promise<{ status: number; data: any }> {
  const url = new URL(reqPath, baseURL);
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = 'Bear' + 'er ' + token;
  let payload: Buffer | undefined;
  if (raw) { payload = raw.body; headers['Content-Type'] = raw.contentType; }
  else if (body !== undefined) { payload = Buffer.from(JSON.stringify(body)); headers['Content-Type'] = 'application/json'; }
  const res = await fetch(url, { method, headers, body: payload as never });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* biner */ }
  return { status: res.status, data };
}

function multipart(parts: { name: string; filename?: string; contentType?: string; data: Buffer | string }[]): { body: Buffer; contentType: string } {
  const B = '----aud6' + Math.random().toString(36).slice(2);
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${B}\r\n`));
    if (p.filename) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n`));
      chunks.push(Buffer.from(`Content-Type: ${p.contentType ?? 'application/octet-stream'}\r\n\r\n`));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n`));
    }
    chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${B}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${B}` };
}

function sseConnect(p: string): Promise<{ events: { event: string; data: any }[]; clientId: string; destroy(): void }> {
  return new Promise((resolve, reject) => {
    const port = Number(new URL(baseURL).port);
    const sock = net.connect(port, '127.0.0.1');
    const events: { event: string; data: any }[] = [];
    let buf = '', clientId = '', pending = { event: '', data: '' }, resolved = false;
    sock.on('connect', () => sock.write(`GET /api/p/${p}/realtime HTTP/1.1\r\nHost: t\r\n\r\n`));
    sock.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('event: ')) pending.event = line.slice(7).trim();
        else if (line.startsWith('data: ')) pending.data = line.slice(6);
        if (line === '' && pending.event) {
          try { const parsed = JSON.parse(pending.data); events.push({ event: pending.event, data: parsed }); if (pending.event === 'PB_CONNECT' && !clientId) clientId = parsed.clientId; } catch { /* */ }
          pending = { event: '', data: '' };
        }
      }
      if (clientId && !resolved) { resolved = true; resolve({ events, clientId, destroy: () => sock.destroy() }); }
    });
    sock.on('error', (e) => { if (!resolved) { resolved = true; reject(e); } });
    setTimeout(() => { if (!resolved) { resolved = true; reject(new Error('SSE timeout')); } }, 4000);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const F = (n: string, t: string, o: any = {}, extra: any = {}) => ({ name: n, type: t, options: o, ...extra });

before(async () => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.env.DATA_DIR = SCRATCH;
  process.env.STORAGE_DIR = STORAGE_DIR;
  process.env.ADMIN_EMAIL = 'admin@test.local';
  process.env.ADMIN_PASSWORD = 'admin-test-pass';

  initPlatformDb();
  const router = new Router();
  router.merge(createAdminRouter());
  router.merge(createDatabaseRouter());
  router.merge(createProjectAuthRouter());
  router.merge(createPublicRouter());
  router.merge(createRealtimeRouter());
  router.merge(createFunctionRouter());
  server = nodeHttp.createServer((q, s) => router.handle(q, s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const login = await req('POST', '/api/admin/auth/login', { email: 'admin@test.local', password: 'admin-test-pass' });
  adminToken = login.data.token;
  const proj = await req('POST', '/api/admin/projects', { name: 'aud6' }, adminToken);
  pid = proj.data.project.id;
});

after(async () => {
  closeAllProjectDbs();
  closePlatformDb();
  server.close();
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

// ─── AUD-6-01: FTS selamat dari rebuild ─────────────────────────────────────

test('AUD-6-01: rebuild skema tidak mematikan FTS (trigger utuh + index segar)', async () => {
  await req('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'posts', fields: [F('title', 'text', { fulltext: true }), F('tag', 'text')],
    rules: { listRule: '', viewRule: '' },
  }, adminToken);
  await req('POST', `/api/p/${pid}/collections/posts/records`, { title: 'alphaone', tag: 'x' }, adminToken);
  await req('POST', `/api/p/${pid}/collections/posts/records`, { title: 'betatwo', tag: 'x' }, adminToken);

  const put = await req('PUT', `/api/admin/projects/${pid}/collections/posts`, {
    fields: [F('title', 'text', { fulltext: true }), F('tag', 'text'), F('extra', 'text')],
  }, adminToken);
  assert.equal(put.status, 200, `rebuild harus sukses (dapat ${put.status}: ${JSON.stringify(put.data).slice(0, 120)})`);

  const db = getProjectDb(pid);
  const trigCount = (db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE '_fts_%posts'`).get() as any).n;
  assert.ok(trigCount >= 3, `trigger FTS harus dibuat ulang oleh rebuild (dapat ${trigCount})`);

  const sOld = await req('GET', `/api/p/${pid}/collections/posts/records?search=alphaone`, undefined, adminToken);
  assert.equal(sOld.status, 200);
  assert.equal(sOld.data.totalItems, 1, `record LAMA harus tetap bisa dicari setelah rebuild (index di-repopulasi; dapat ${sOld.data.totalItems})`);

  await req('POST', `/api/p/${pid}/collections/posts/records`, { title: 'deltafour', tag: 'y' }, adminToken);
  const sNew = await req('GET', `/api/p/${pid}/collections/posts/records?search=deltafour`, undefined, adminToken);
  assert.equal(sNew.status, 200);
  assert.equal(sNew.data.totalItems, 1, `record BARU pasca-rebuild harus terindeks (trigger hidup; dapat ${sNew.data.totalItems})`);
});

// ─── AUD-6-02: PATCH options tersinkron ke fisik ────────────────────────────

test('AUD-6-02: PATCH add-field menyinkronkan unique & fulltext ke fisik', async () => {
  await req('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'acct', fields: [F('email', 'text'), F('name', 'text')],
    rules: { createRule: '', viewRule: '', listRule: '' },
  }, adminToken);

  // toggle unique ON pada field existing
  const patch = await req('PATCH', `/api/admin/projects/${pid}/collections/acct`, {
    fields: [F('email', 'text', {}, { unique: true }), F('name', 'text'), F('nickname', 'text')],
  }, adminToken);
  assert.equal(patch.status, 200, `PATCH harus sukses (dapat ${patch.status}: ${JSON.stringify(patch.data).slice(0, 120)})`);

  const u1 = await req('POST', `/api/p/${pid}/collections/acct/records`, { email: 'dup@x.test', name: 'satu' }, adminToken);
  assert.equal(u1.status, 201);
  const u2 = await req('POST', `/api/p/${pid}/collections/acct/records`, { email: 'dup@x.test', name: 'dua' }, adminToken);
  assert.notEqual(u2.status, 201, `meta bilang unique → duplikat harus DITOLAK fisik (dapat ${u2.status})`);

  // tambah field fulltext via PATCH (jalur ALTER)
  const patch2 = await req('PATCH', `/api/admin/projects/${pid}/collections/acct`, {
    fields: [F('email', 'text', {}, { unique: true }), F('name', 'text'), F('nickname', 'text'), F('content', 'text', { fulltext: true })],
  }, adminToken);
  assert.equal(patch2.status, 200);
  await req('POST', `/api/p/${pid}/collections/acct/records`, { email: 'z@x.test', name: 'tiga', content: 'searchableterm' }, adminToken);
  const s = await req('GET', `/api/p/${pid}/collections/acct/records?search=searchableterm`, undefined, adminToken);
  assert.equal(s.status, 200, `?search= tidak boleh 500 setelah field fulltext ditambahkan (dapat ${s.status}: ${JSON.stringify(s.data).slice(0, 100)})`);
  assert.equal(s.data.totalItems, 1, `record dengan field fulltext baru harus bisa dicari (dapat ${s.data.totalItems})`);
});

// ─── AUD-6-03: cascade rekursif + file + event anak ─────────────────────────

test('AUD-6-03: cascade delete rekursif — grandchild, file anak, event anak', async () => {
  const mk = (name: string, fields: any[]) =>
    req('POST', `/api/admin/projects/${pid}/collections`, { name, fields, rules: { listRule: '', viewRule: '' } }, adminToken);
  await mk('gp', [F('label', 'text')]);
  await mk('par', [F('gpRef', 'relation', { collectionId: 'gp', cascadeDelete: 'cascade' }), F('att', 'file'), F('note', 'text')]);
  await mk('chi', [F('parRef', 'relation', { collectionId: 'par', cascadeDelete: 'cascade' })]);
  await mk('marks', [F('label', 'text')]);

  const sse = await sseConnect(pid);
  await req('POST', `/api/p/${pid}/realtime/subscribe`, { clientId: sse.clientId, collection: 'par' }, adminToken);
  await req('POST', `/api/p/${pid}/realtime/subscribe`, { clientId: sse.clientId, collection: 'chi' }, adminToken);
  const fn = await req('POST', `/api/admin/projects/${pid}/functions`, {
    name: 'react_par6', code: `await $db.collection('marks').create({ label: 'par-deleted' }); return 'ok';`,
    dbAccess: true, timeoutMs: 5000, triggers: [{ collection: 'par', actions: ['delete'] }],
  }, adminToken);
  assert.equal(fn.status, 201);

  const ins = (coll: string, data: any) => req('POST', `/api/p/${pid}/collections/${coll}/records`, data, adminToken);
  const gp1 = (await ins('gp', { label: 'GP1' })).data.record.id;
  const parFile = multipart([
    { name: 'gpRef', data: gp1 },
    { name: 'att', filename: 'lampiran.txt', contentType: 'text/plain', data: 'ISI-FILE-ANAK' },
  ]);
  const par1r = await req('POST', `/api/p/${pid}/collections/par/records`, undefined, adminToken, parFile);
  assert.equal(par1r.status, 201);
  const par1 = par1r.data.record.id;
  const par1File = par1r.data.record.att;
  const gp2 = (await ins('gp', { label: 'GP2' })).data.record.id;
  const par2 = (await ins('par', { gpRef: gp2, note: 'nofile' })).data.record.id;
  const chi1 = (await ins('chi', { parRef: par1 })).data.record.id;
  const chi2 = (await ins('chi', { parRef: par2 })).data.record.id;
  const filePath = path.join(STORAGE_DIR, pid, `${par1}_${par1File}`);
  assert.ok(fs.existsSync(filePath), 'setup: file par1 harus ada di disk');

  // DELETE grandparent → cascade 2 level
  const dg = await req('DELETE', `/api/p/${pid}/collections/gp/records/${gp1}`, undefined, adminToken);
  assert.equal(dg.status, 200);
  await sleep(800);

  const chiList = await req('GET', `/api/p/${pid}/collections/chi/records?perPage=100`, undefined, adminToken);
  assert.ok(!chiList.data.items.some((x: any) => x.id === chi1), 'grandchild chi1 harus ikut ter-cascade (rekursif)');
  assert.ok(chiList.data.items.some((x: any) => x.id === chi2), 'chi2 (cabang lain) tidak boleh terhapus');

  assert.equal(fs.existsSync(filePath), false, 'file milik record anak ter-cascade harus ikut dihapus (bukan orphan)');

  const delPar = sse.events.filter((e) => e.event === 'PB_DELETE' && e.data?.collection === 'par');
  assert.ok(delPar.length >= 1, `PB_DELETE untuk record anak (par) harus di-broadcast (dapat ${delPar.length})`);
  const delChi = sse.events.filter((e) => e.event === 'PB_DELETE' && e.data?.collection === 'chi');
  assert.ok(delChi.length >= 1, `PB_DELETE untuk grandchild (chi) harus di-broadcast (dapat ${delChi.length})`);

  const marks = await req('GET', `/api/p/${pid}/collections/marks/records?perPage=100`, undefined, adminToken);
  assert.ok(marks.data.items.length >= 1, `trigger function untuk delete anak ter-cascade harus menyala (marks=${marks.data.items.length})`);

  // Kontrol: direct delete tetap bekerja penuh
  const dp2 = await req('DELETE', `/api/p/${pid}/collections/par/records/${par2}`, undefined, adminToken);
  assert.equal(dp2.status, 200);
  await sleep(500);
  const chi2List = await req('GET', `/api/p/${pid}/collections/chi/records?perPage=100`, undefined, adminToken);
  assert.ok(!chi2List.data.items.some((x: any) => x.id === chi2), 'kontrol: chi2 ikut par2 (cascade 1 level langsung)');

  sse.destroy();
});

// ─── AUD-6-04: rollback gagal tidak menimpa error asli ──────────────────────

test('AUD-6-04: ROLLBACK gagal → error asli tetap naik + koneksi pulih', async () => {
  await req('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'rtest', fields: [F('req', 'text', {}, { required: true }), F('opt', 'text')],
    rules: { listRule: '', viewRule: '' },
  }, adminToken);

  const realDb = getProjectDb(pid);
  // Proxy: ROLLBACK pertama GAGAL (simulasi IO), retry BERHASIL.
  let rollbackCalls = 0;
  const poisoned = new Proxy(realDb as never as Record<string, unknown>, {
    get(target: Record<string, unknown>, prop: string) {
      if (prop === 'exec') {
        return (sql: string, ...a: unknown[]) => {
          if (sql.trim().toUpperCase() === 'ROLLBACK') {
            rollbackCalls++;
            if (rollbackCalls === 1) throw new Error('SIMULATED ROLLBACK FAILURE');
          }
          return (target.exec as (s: string, ...args: unknown[]) => unknown)(sql, ...a);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as never;

  let thrown: Error | null = null;
  try {
    createRecordsBatch(poisoned as never, 'rtest', [{ req: 'a' }, { opt: 'b' } /* req hilang */]);
  } catch (e) {
    thrown = e as Error;
  }
  assert.ok(thrown, 'batch invalid harus melempar error');
  assert.ok(!thrown!.message.includes('SIMULATED ROLLBACK FAILURE'),
    `error ASLI harus naik, bukan error ROLLBACK yang menimpanya (dapat: ${thrown!.message})`);
  assert.ok(/req/i.test(thrown!.message), `error harus menyebut validasi field req (dapat: ${thrown!.message})`);

  // Transaksi tertutup oleh retry → koneksi sehat untuk operasi berikutnya
  const ok = createRecordsBatch(realDb, 'rtest', [{ req: 'ok1' }]);
  assert.equal(ok.length, 1, 'koneksi harus pulih setelah rollback-retry (transaksi tertutup)');
});

test('AUD-6-04b: batch create valid → error di tengah → SEMUA record batal (regresi)', async () => {
  await req('POST', `/api/admin/projects/${pid}/collections`, {
    name: 'rtest2', fields: [F('req', 'text', {}, { required: true })],
    rules: { listRule: '', viewRule: '' },
  }, adminToken);
  const before = await req('GET', `/api/p/${pid}/collections/rtest2/records`, undefined, adminToken);
  assert.equal(before.data.totalItems, 0);
  const r = await req('POST', `/api/p/${pid}/collections/rtest2/records/batch`, { records: [{ req: 'a' }, {}] }, adminToken);
  assert.equal(r.status, 400, 'batch dengan record invalid harus 400');
  const after = await req('GET', `/api/p/${pid}/collections/rtest2/records`, undefined, adminToken);
  assert.equal(after.data.totalItems, 0, 'rollback harus membatalkan SEMUA record (atomik)');
});
