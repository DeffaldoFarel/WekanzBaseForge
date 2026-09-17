// ============================================================================
// M25: TEST $http SANDBOX — jaringan terkurasi untuk functions
//
// Mock HTTP server lokal (127.0.0.1) berperan "internet palsu":
//   /hello        → JSON sederhana
//   /echo         → POST: balikan body + header yang diterima
//   /slow?ms=N    → delay N ms (test timeout)
//   /big?kb=N     → respons N KB (test cap 1MB)
//   /redirect?to= → 302 ke URL tujuan (test redirect + re-validasi)
//
// Fokus test:
//  1. $http OFF default (httpAllow kosong) → error informatif
//  2. Allowlist: host terdaftar OK, host TIDAK terdaftar → blocked
//  3. Wildcard '*.host' matching
//  4. SSRF: allowlist '*' (internet publik) → 127.0.0.1 tetap BLOCKED;
//     entry literal '127.0.0.1' → diizinkan (opt-in eksplisit)
//  5. GET/POST + headers + body + json() helper
//  6. Timeout per-request
//  7. Response cap 1MB + flag truncated
//  8. Redirect di-follow; redirect ke host tidak diizinkan → blocked
//  9. await di user code bekerja; function sync lama tetap OK
// 10. Wall-clock: function menunggu $http lambat → timeout total function
// 11. Isolasi allowlist antar function
// ============================================================================

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import nodeHttp from 'node:http';

import { runFunctionCode } from '../src/core/functionRunner.js';
import { hostAllowed } from '../src/core/httpSandbox.js';

let mock: nodeHttp.Server;
let mockURL: string;

before(async () => {
  mock = nodeHttp.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const path = url.pathname;

    if (path === '/hello') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'hello from mock', n: 42 }));
      return;
    }

    if (path === '/echo') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            method: req.method,
            body: Buffer.concat(chunks).toString('utf-8'),
            auth: req.headers['authorization'] ?? null,
          })
        );
      });
      return;
    }

    if (path === '/slow') {
      const ms = parseInt(url.searchParams.get('ms') ?? '100', 10);
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('finally');
      }, ms);
      return;
    }

    if (path === '/big') {
      const kb = parseInt(url.searchParams.get('kb') ?? '2048', 10);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.alloc(kb * 1024, 65)); // 'A' * N
      return;
    }

    if (path === '/redirect') {
      const to = url.searchParams.get('to') ?? '/hello';
      res.writeHead(302, { Location: to });
      res.end();
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  const addr = mock.address() as { port: number };
  mockURL = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((r) => mock.close(() => r()));
});

function run(code: string, httpAllow?: string[], timeoutMs = 3000) {
  return runFunctionCode(code, { body: {}, query: {}, timeoutMs, httpAllow });
}

// Lazy: mockURL baru terisi di before() — helper dipanggil di dalam body test
const hello = () => `${mockURL}/hello`;

// ─── 1. Fail-safe default ─────────────────────────────────────────────────────

test('$http OFF by default (httpAllow kosong) → pesan informatif', async () => {
  const r = await run(`return await $http.send({ url: ${JSON.stringify(hello())} });`);
  assert.equal(r.ok, false);
  assert.match(r.error!, /not enabled/);
  assert.match(r.error!, /httpAllow/);
});

// ─── 2+3. Allowlist matching ──────────────────────────────────────────────────

test('unit: hostAllowed — literal, wildcard, dan *', () => {
  assert.ok(hostAllowed('api.stripe.com', ['api.stripe.com']));
  assert.ok(hostAllowed('api.github.com', ['*.github.com']));
  assert.ok(!hostAllowed('github.com', ['*.github.com']), '*.github.com TIDAK boleh cocok github.com');
  assert.ok(hostAllowed('anything.example.com', ['*']));
  assert.ok(!hostAllowed('api.other.com', ['api.stripe.com', '*.github.com']));
  assert.ok(!hostAllowed('api.stripe.com.evil.io', ['api.stripe.com']), 'suffix trick tidak lolos');
});

test('allowlist: host terdaftar → request sukses; host lain → blocked', async () => {
  const ok = await run(`return await $http.send({ url: ${JSON.stringify(hello())} });`, ['127.0.0.1']);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal((ok.result as any).status, 200);
  // json() hanya hidup DI DALAM isolate; host membaca body + JSON.parse
  assert.equal(JSON.parse((ok.result as any).body).message, 'hello from mock');

  const blocked = await run(
    `return await $http.send({ url: ${JSON.stringify(`${mockURL}/hello`)} });`,
    ['api.stripe.com']
  );
  assert.equal(blocked.ok, false);
  assert.match(blocked.error!, /not in the httpAllow list/);
});

// ─── 4. SSRF guard ────────────────────────────────────────────────────────────

test("SSRF: allowlist '*' (internet publik) → loopback tetap BLOCKED", async () => {
  const r = await run(`return await $http.send({ url: ${JSON.stringify(hello())} });`, ['*']);
  assert.equal(r.ok, false);
  assert.match(r.error!, /private\/loopback IP/);
  assert.match(r.error!, /httpAllow/); // petunjuk opt-in
});

test("SSRF: entry literal '127.0.0.1' → opt-in eksplisit, diizinkan", async () => {
  const r = await run(`return await $http.send({ url: ${JSON.stringify(hello())} });`, ['127.0.0.1']);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('SSRF: skema non-http ditolak; method tidak dikenal ditolak', async () => {
  const r1 = await run(`return await $http.send({ url: 'file:///etc/passwd' });`, ['*']);
  assert.equal(r1.ok, false);
  assert.match(r1.error!, /only http\/https/);

  const r2 = await run(
    `return await $http.send({ url: ${JSON.stringify(hello())}, method: 'TRACE' });`,
    ['127.0.0.1']
  );
  assert.equal(r2.ok, false);
  assert.match(r2.error!, /method 'TRACE' is not allowed/);
});

// ─── 5. GET/POST + headers + body + json() ────────────────────────────────────

test('POST + headers + body terkirim; json() helper bekerja', async () => {
  const r = await run(
    `
    const res = await $http.send({
      url: ${JSON.stringify(`${mockURL}/echo`)},
      method: 'POST',
      headers: { 'Authorization': 'Bearer tok-abc', 'Content-Type': 'application/json' },
      body: JSON.stringify({ a: 1, b: 'x' }),
    });
    return { status: res.status, payload: res.json() };
    `,
    ['127.0.0.1']
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((r.result as any).status, 200);
  const payload = (r.result as any).payload;
  assert.equal(payload.method, 'POST');
  assert.equal(payload.auth, 'Bearer tok-abc');
  assert.deepEqual(JSON.parse(payload.body), { a: 1, b: 'x' });
});

// ─── 6. Timeout per-request ───────────────────────────────────────────────────

test('timeout per-request: request lambat (400ms) + timeout 150ms → error timeout', async () => {
  const r = await run(
    `return await $http.send({ url: ${JSON.stringify(`${mockURL}/slow?ms=400`)}, timeout: 150 });`,
    ['127.0.0.1'],
    5000 // function budget longgar — timeout HARUS dari per-request
  );
  assert.equal(r.ok, false);
  assert.match(r.error!, /timed out after 150ms/);
});

// ─── 7. Response cap ──────────────────────────────────────────────────────────

test('response body dibatasi 1MB + flag truncated', async () => {
  const r = await run(
    `const res = await $http.send({ url: ${JSON.stringify(`${mockURL}/big?kb=2048`)} });
     return { length: res.body.length, truncated: res.truncated };`,
    ['127.0.0.1'],
    5000
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  const result = r.result as { length: number; truncated: boolean };
  assert.equal(result.length, 1024 * 1024);
  assert.equal(result.truncated, true);
});

// ─── 8. Redirect ──────────────────────────────────────────────────────────────

test('redirect 302 di-follow ke path yang sama host → OK', async () => {
  const r = await run(
    `const res = await $http.send({ url: ${JSON.stringify(`${mockURL}/redirect?to=/hello`)} });
     return res.json();`,
    ['127.0.0.1']
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((r.result as any).message, 'hello from mock');
});

test('redirect ke host yang TIDAK di-allowlist → blocked (re-validasi tiap hop)', async () => {
  // Host asal diizinkan ('127.0.0.1'), redirect menuju 'evil.example.com'
  const target = encodeURIComponent('http://evil.example.com/steal');
  const r = await run(
    `return await $http.send({ url: ${JSON.stringify(`${mockURL}/redirect?to=${target}`)} });`,
    ['127.0.0.1']
  );
  assert.equal(r.ok, false);
  assert.match(r.error!, /not in the httpAllow list/);
});

// ─── 9. Async & kompatibilitas sync ───────────────────────────────────────────

test('await berurutan (2 request) + return value composite', async () => {
  const r = await run(
    `const a = await $http.send({ url: ${JSON.stringify(hello())} });
     const b = await $http.send({ url: ${JSON.stringify(hello())} });
     return { total: a.json().n + b.json().n, firstStatus: a.status };`,
    ['127.0.0.1']
  );
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((r.result as any).total, 84);
  assert.equal((r.result as any).firstStatus, 200);
});

test('function sync lama (tanpa await) tetap bekerja — kontrak M15a tidak rusak', async () => {
  const r = await run(`return { hi: 'no-await', n: 1 + 1 };`, ['127.0.0.1']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, { hi: 'no-await', n: 2 });
});

test('error di dalam async user code → ok:false dengan pesan', async () => {
  const r = await run(`await Promise.resolve(); throw new Error('kaboom-async');`);
  assert.equal(r.ok, false);
  assert.match(r.error!, /kaboom-async/);
});

// ─── 10. Wall-clock budget total ──────────────────────────────────────────────

test('wall-clock: function menunggu $http lambat → timeout TOTAL function terpicu', async () => {
  const r = await run(
    `return await $http.send({ url: ${JSON.stringify(`${mockURL}/slow?ms=2000`)}, timeout: 1500 });`,
    ['127.0.0.1'],
    300 // function budget 300ms — request 1.5s musti kalah
  );
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.match(r.error!, /3000ms|300ms|timeout/);
});

// ─── 11. Isolasi allowlist antar function ─────────────────────────────────────

test('isolate: function A boleh 127.0.0.1, function B (tanpa allowlist) tidak', async () => {
  const a = await run(`return (await $http.send({ url: ${JSON.stringify(hello())} })).status;`, ['127.0.0.1']);
  const b = await run(`return (await $http.send({ url: ${JSON.stringify(hello())} })).status;`);
  assert.equal(a.ok, true);
  assert.equal((a.result as any), 200);
  assert.equal(b.ok, false);
  assert.match(b.error!, /not enabled/);
});
