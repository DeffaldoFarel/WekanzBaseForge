// ============================================================================
// M25: HTTP SANDBOX — jaringan terkurasi untuk function ($http.send)
//
// Mengapa modul ini ada: isolate V8 (M18a) SENGAJA tanpa akses jaringan.
// Membuka jaringan = membuka permukaan serangan baru, maka SEMUA request
// melewati 4 lapis gerbang di sini:
//
//   1. ALLOWLIST  — host harus cocok entry httpAllow function
//                   ('*' = semua host PUBLIK; entry literal = opt-in eksplisit,
//                    termasuk host privat seperti 'localhost')
//   2. SSRF GUARD — hostname/IP privat, loopback, link-local (metadata cloud!)
//                   diblokir KECUALI terdaftar literal di allowlist.
//                   DNS di-resolve dulu → semua IP diceki (TOCTOU window
//                   diterima & didokumentasikan untuk v1).
//   3. REDIRECT   — manual follow (maks 3 hop), SETIAP hop di-validasi ulang
//                   (redirect allowed-host → localhost = tetap diblokir).
//   4. BUDGET     — timeout per-request (AbortController), response body
//                   dibatasi (stream → hentikan di cap), request body dibatasi.
//
// Kontrak hasil (serialisasi JSON masuk isolate):
//   { status, headers, body, truncated } + helper json() disuntik shim.
// ============================================================================

import dns from 'node:dns/promises';
import net from 'node:net';

export interface HttpSendOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number; // ms — default 10.000, max 30.000
}

export interface HttpSendResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MB
const MAX_REQUEST_BYTES = 256 * 1024; // 256 KB
const MAX_HEADER_COUNT = 50;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

// ─── 1. Allowlist ─────────────────────────────────────────────────────────────

export function hostAllowed(hostname: string, allowList: string[]): boolean {
  if (allowList.includes('*')) return true;
  const host = hostname.toLowerCase();
  for (const entry of allowList) {
    if (entry === host) return true; // literal match
    if (entry.startsWith('*.')) {
      // '*.github.com' cocok 'api.github.com' tapi TIDAK 'github.com'
      const suffix = entry.slice(1); // '.github.com'
      if (host.endsWith(suffix) && host.length > suffix.length) return true;
    }
  }
  return false;
}

/** Entry literal (tanpa wildcard) = opt-in eksplisit host privat. */
function isExplicitEntry(hostname: string, allowList: string[]): boolean {
  return allowList.includes(hostname.toLowerCase());
}

// ─── 2. SSRF guard ────────────────────────────────────────────────────────────

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true; // this-host, private, loopback
    if (a === 169 && b === 254) return true; // link-local (169.254.169.254 = metadata cloud!)
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    return false;
  }
  // IPv6: loopback, unique-local, link-local
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // fc00::/7
  if (v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb')) return true; // fe80::/10
  // IPv4-mapped (::ffff:10.0.0.1)
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  return false;
}

/**
 * Validasi host terhadap SSRF: hostname privat (localhost) atau IP literal
 * privat ditolak; domain publik di-resolve dan SEMUA IP hasil resolve dicek.
 * Host privat yang terdaftar literal di allowlist diizinkan (opt-in eksplisit).
 */
export async function assertPublicHost(hostname: string, port: number, allowList: string[]): Promise<void> {
  const host = hostname.toLowerCase();

  const block = (reason: string): never => {
    throw new Error(`$http blocked: ${reason} (add the exact host to httpAllow to allow internal access)`);
  };

  // Port metadata cloud yang umum dipakai SSRF
  if (port === 8080 && host === '169.254.169.254') block(`metadata endpoint`);

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    if (isExplicitEntry(host, allowList)) return;
    block(`'${host}' is an internal hostname`);
  }

  if (net.isIP(host)) {
    if (isPrivateIp(host) && !isExplicitEntry(host, allowList)) {
      block(`'${host}' is a private/loopback IP`);
    }
    return; // IP publik literal → lolos
  }

  // Domain: resolve DNS, cek semua IP (private DNS name = SSRF klasik)
  try {
    const records = await dns.lookup(host, { all: true });
    for (const r of records) {
      if (isPrivateIp(r.address)) {
        if (isExplicitEntry(host, allowList)) return; // nama privat di-opt-in eksplisit
        block(`'${host}' resolves to private IP ${r.address}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`$http blocked: DNS lookup failed for '${host}' (${msg})`);
  }
}

// ─── 3+4. Eksekusi dengan redirect terkurasi & budget ────────────────────────

function normalizeHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  let count = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_HEADER_COUNT) break;
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue;
    if (/[\r\n]/.test(k) || /[\r\n]/.test(String(v))) continue; // header injection
    out[k.toLowerCase()] = String(v);
    count++;
  }
  return out;
}

async function fetchWithCap(
  url: string,
  init: RequestInit,
  signal: AbortSignal
): Promise<{ status: number; headers: Record<string, string>; body: string; truncated: boolean; location: string | null }> {
  const res = await fetch(url, { ...init, signal, redirect: 'manual' });
  const headers: Record<string, string> = {};
  for (const [k, v] of res.headers) {
    headers[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  const location = res.headers.get('location');

  if (init.method === 'HEAD' || !res.body) {
    return { status: res.status, headers, body: '', truncated: false, location };
  }

  // Baca stream dengan cap — berhenti DI CAP, bukan baca-then-slice
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      chunks.push(Buffer.from(value.subarray(0, MAX_RESPONSE_BYTES - (received - value.byteLength))));
      truncated = true;
      break; // berhenti membaca — penghematan bandwidth nyata
    }
    chunks.push(Buffer.from(value));
  }
  try { await reader.cancel(); } catch { /* sudah selesai */ }

  return { status: res.status, headers, body: Buffer.concat(chunks).toString('utf-8'), truncated, location };
}

/**
 * Satu-satunya gerbang $http.send — dipanggil functionRunner dengan
 * allowlist function. Semua guard diterapkan di sini, bukan di kode user.
 */
export async function sandboxedHttpSend(
  opts: HttpSendOptions,
  allowList: string[]
): Promise<HttpSendResult> {
  if (allowList.length === 0) {
    throw new Error('$http is not enabled for this function — add hostnames to the httpAllow list');
  }

  // ── Validasi input ──
  if (!opts || typeof opts !== 'object') throw new Error('$http.send expects an options object');
  if (typeof opts.url !== 'string') throw new Error('$http.send: url is required');

  let url: URL;
  try {
    url = new URL(opts.url);
  } catch {
    throw new Error(`$http.send: invalid URL '${opts.url}'`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`$http.send: only http/https are allowed (got '${url.protocol}')`);
  }

  const method = (opts.method ?? 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new Error(`$http.send: method '${method}' is not allowed (use ${[...ALLOWED_METHODS].join('/')})`);
  }

  const headers = normalizeHeaders(opts.headers);
  let body: string | undefined;
  if (opts.body !== undefined && opts.body !== null) {
    if (typeof opts.body !== 'string') throw new Error('$http.send: body must be a string (JSON.stringify objects yourself)');
    if (opts.body.length > MAX_REQUEST_BYTES) throw new Error(`$http.send: body exceeds ${MAX_REQUEST_BYTES / 1024} KB`);
    body = opts.body;
  }

  const timeoutMs = Math.min(Math.max(opts.timeout ?? 10_000, 100), 30_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // ── Loop redirect manual: SETIAP hop divalidasi ulang ──
    let currentUrl = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const hostname = currentUrl.hostname;
      const port = currentUrl.port ? parseInt(currentUrl.port, 10) : currentUrl.protocol === 'https:' ? 443 : 80;

      // Gerbang 1+2 tiap hop
      if (!hostAllowed(hostname, allowList)) {
        throw new Error(`$http blocked: host '${hostname}' is not in the httpAllow list`);
      }
      await assertPublicHost(hostname, port, allowList);

      const res = await fetchWithCap(
        currentUrl.toString(),
        {
          method: hop === 0 ? method : 'GET', // redirect 30x → GET (per fetch spec)
          headers,
          body: hop === 0 && body !== undefined && method !== 'GET' && method !== 'HEAD' ? body : undefined,
        },
        controller.signal
      );

      // Redirect? → validasi hop berikutnya di iterasi berikutnya
      if (res.status >= 300 && res.status < 400 && res.location) {
        const next = new URL(res.location, currentUrl);
        if (hop === MAX_REDIRECTS) {
          throw new Error(`$http blocked: too many redirects (max ${MAX_REDIRECTS})`);
        }
        currentUrl = next;
        continue;
      }

      return { status: res.status, headers: res.headers, body: res.body, truncated: res.truncated };
    }
    throw new Error('$http blocked: redirect loop'); // unreachable guard
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`$http request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
