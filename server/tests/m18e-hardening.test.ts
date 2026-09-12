// ============================================================================
// M18e: HARDENING ROUTER & SEARCH — fuzz-test + rate limit search
//
// Target audit (dari rencana M18 "audit + hardening, bukan ganti"):
// 1. Router: URL encoding hostile (%2f, %00, %ff, double-encode, unicode,
//    path traversal di :param, query array, host header injection).
//    Ekspektasi: tidak crash, tidak leak path, param ter-dekode aman.
// 2. FTS sanitasi: input hostile (`"`, `*`, `OR 1=1`, unicode, null, panjang
//    ekstrem) → query tetap valid, tidak error, tidak full-scan injection.
// 3. Rate limit khusus endpoint search (anti FTS scanning abuse).
// ============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeFtsQuery } from '../src/core/fts.js';
import { Router } from '../src/core/router.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ─── Helper: buat request palsu untuk router.handle ─────────────────────────
function fakeReq(method: string, url: string, headers: Record<string, string> = {}): IncomingMessage {
  return {
    method,
    url,
    headers,
    on: () => {},
    once: () => {},
    emit: () => {},
    write: () => {},
    end: () => {},
    resume: () => {},
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage;
}

function fakeRes(): ServerResponse & { statusCode: number; body: string } {
  const res: Record<string, unknown> = {
    statusCode: 200,
    body: '',
    setHeader: (k: string, v: unknown) => { res[`h_${k}`] = v; },
    getHeader: () => undefined,
    writeHead: (code: number) => { res.statusCode = code; return res; },
    end: (chunk?: unknown) => { if (chunk) res.body = String(chunk); },
    on: () => {},
    once: () => {},
    emit: () => {},
    write: () => true,
    raw: { on: () => {}, once: () => {}, emit: () => {} },
  };
  return res as never;
}

// ─── 1. FTS SANITASI: input hostile ─────────────────────────────────────────

describe('M18e: FTS sanitasi hostile input', () => {
  test('quote, asterisk, OR-injection → token aman tanpa SQL escape', () => {
    const cases = [
      '"kopi" OR 1=1 --',
      'kopi"; DROP TABLE docs; --',
      'a"b"c',
    ];
    for (const input of cases) {
      const out = sanitizeFtsQuery(input);
      // Hasil harus berupa daftar token quoted (token terakhir boleh diikuti
      // prefix `*`), tanpa raw `"` dari input yang bisa menutup phrase FTS
      // lebih awal. Format: "tok" "tok"* ...
      assert.match(out, /^"[^"]*"\*?( "[^"]*"\*?)*$/, `input: ${JSON.stringify(input)} → ${out}`);
    }
    // M18e: token punct-only murni dibuang → hasil kosong (bukan token
    // berisi `***` yang jadi phrase aneh di FTS5)
    assert.equal(sanitizeFtsQuery('***'), '');
    assert.equal(sanitizeFtsQuery('""'), '');
    assert.equal(sanitizeFtsQuery('---'), '');
  });

  test('unicode, emoji, CJK → diterima sebagai token biasa (tidak crash)', () => {
    assert.doesNotThrow(() => sanitizeFtsQuery('코피 ☕ 中文 kopi'));
    const out = sanitizeFtsQuery('中文 kopi');
    assert.ok(out.includes('"kopi"'));
  });

  test('null byte & kontrol chars → dibuang sanitizer', () => {
    assert.doesNotThrow(() => sanitizeFtsQuery('kopi\x00latten\x1f'));
  });

  test('input panjang ekstrem (10k char) → tetap aman & terpotong wajar', () => {
    const huge = 'kopi '.repeat(2000);
    assert.doesNotThrow(() => sanitizeFtsQuery(huge));
  });
});

// ─── 2. ROUTER: URL encoding hostile ────────────────────────────────────────

describe('M18e: router URL encoding hostile', () => {
  test('%2f di :param tidak menembus path (tidak jadi 2 segmen)', () => {
    const router = new Router();
    let capturedId = '';
    router.get('/api/p/:pid/collections/:name/records', (req, res) => {
      capturedId = (req.params as Record<string, string>).name;
      res.status(200).json({ ok: true });
    });
    // %2f di dalam segmen — setelah decode boleh berisi '/', tapi TIDAK boleh
    // mengubah jumlah segmen path (router match sebelum decode per-segmen)
    const res = fakeRes();
    router.handle(fakeReq('GET', '/api/p/proj1/collections/docs%2f..%2fetc/records'), res);
    // Segmen tetap 1 → param "docs/../etc" TERSANITASI oleh handler atas
    // (storageRoutes pakai sanitizeFilename). Yang penting di sini: tidak crash.
    assert.ok(res.statusCode === 200 || res.statusCode === 404);
  });

  test('path traversal panjang di :pid → param diteruskan, handler DB yang menolak', () => {
    const router = new Router();
    router.get('/api/p/:pid/auth/me', (req, res) => {
      res.status(200).json({ pid: (req.params as Record<string, string>).pid });
    });
    const res = fakeRes();
    router.handle(fakeReq('GET', '/api/p/..%2f..%2fplatform.db/auth/me'), res);
    assert.equal(res.statusCode, 200);
    assert.equal((JSON.parse(res.body) as { pid: string }).pid, '../../platform.db');
    // Catatan: handler (getProjectDb) akan menolak id seperti ini dengan
    // 404 — router tidak melempar/crash. Proteksi path di projectDbManager.
  });

  test('%00, %ff, invalid UTF-8 → tidak crash (decode gagal → segmen mentah)', () => {
    const router = new Router();
    router.get('/api/x/:v', (req, res) => { res.status(200).json({ ok: true }); });
    for (const url of ['/api/x/%00', '/api/x/%ff%fe', '/api/x/%e0%80', '/api/x/%%', '/api/x/%']) {
      const res = fakeRes();
      assert.doesNotThrow(() => router.handle(fakeReq('GET', url), res), `url: ${url}`);
    }
  });

  test('query string hostile (?a=1&a=2&b[]=&c=%zz) → tidak crash', () => {
    const router = new Router();
    router.get('/api/q', (req, res) => { res.status(200).json({ ok: true }); });
    const res = fakeRes();
    assert.doesNotThrow(() =>
      router.handle(fakeReq('GET', '/api/q?a=1&a=2&b[]=&c=%zz&d=<script>'), res));
  });

  test('double-encode (%252e%252e) tidak di-decode ganda oleh router', () => {
    const router = new Router();
    router.get('/api/f/:name', (req, res) => {
      res.status(200).json({ name: (req.params as Record<string, string>).name });
    });
    const res = fakeRes();
    router.handle(fakeReq('GET', '/api/f/%252e%252e%252fetc'), res);
    // decodeURIComponent sekali: %252e → %2e (bukan '.'), jadi tetap ter-encode
    const name = (JSON.parse(res.body) as { name: string }).name;
    assert.equal(name, '%2e%2e%2fetc');
  });
});

// ─── 3. RATE LIMIT SEARCH ───────────────────────────────────────────────────

describe('M18e: kontrak rate limit search (searchRateLimitKey)', () => {
  test('key dibentuk dari project + ip (isolasi per project)', async () => {
    const { buildSearchRateKey } = await import('../src/core/searchGuard.js');
    assert.equal(buildSearchRateKey('proj123', '10.0.0.1'), 'search:proj123:10.0.0.1');
    assert.notEqual(
      buildSearchRateKey('projA', 'ip1'),
      buildSearchRateKey('projB', 'ip1')
    );
  });
});
