// ============================================================================
// M00: HTTP ROUTER BUATAN SENDIRI
//
// Kenapa dari nol? Karena Express/Fastify hanyalah pembungkus konsep ini.
// Setelah menulis ini, kamu akan melihat bahwa "framework" itu bukan magic:
// hanyalah pencocokan pola URL + pemanggilan fungsi.
//
// Konsep yang dipelajari:
//  1. URL pattern matching: '/api/projects/:id' → { id: 'abc' }
//  2. Method routing: GET/POST/PATCH/DELETE ke handler berbeda
//  3. Middleware chain: fungsi yang berjalan SEBELUM handler (auth, logging)
//  4. Request/response abstraction: parse body JSON, kirim JSON response
// ============================================================================

import type { IncomingMessage, ServerResponse } from 'node:http';
import { metricsProjectId, trackRequest } from './metrics.js';

// ─── Request & Response wrapper ─────────────────────────────────────────────
// node:http memberikan IncomingMessage mentah. Kita bungkus dengan helper
// yang lebih nyaman — ini persis yang dilakukan Express pada req/res-nya.

export interface ForgeRequest {
  method: string;
  path: string;                          // '/api/projects/abc'
  params: Record<string, string>;        // { id: 'abc' } dari pola ':id'
  query: URLSearchParams;                // ?page=2&sort=-created
  headers: IncomingMessage['headers'];
  body: unknown;                         // hasil JSON.parse (jika ada)
  raw: IncomingMessage;
  // Diisi oleh middleware auth:
  admin?: { email: string };
}

export interface ForgeResponse {
  status(code: number): ForgeResponse;
  json(data: unknown): void;
  raw: ServerResponse;
}

// ─── Route definition ───────────────────────────────────────────────────────

export type Handler = (
  req: ForgeRequest,
  res: ForgeResponse
) => Promise<void> | void;

// Middleware mengembalikan true untuk LANJUT, false untuk BERHENTI
// (misalnya auth gagal → middleware mengirim 401 dan return false)
export type Middleware = (
  req: ForgeRequest,
  res: ForgeResponse
) => Promise<boolean> | boolean;

interface Route {
  method: string;
  pattern: string;      // '/api/projects/:id'
  segments: string[];   // ['api', 'projects', ':id'] — dipecah sekali saat registrasi
  middlewares: Middleware[];
  handler: Handler;
}

// ─── The Router ─────────────────────────────────────────────────────────────

export class Router {
  private routes: Route[] = [];
  private globalMiddlewares: Middleware[] = [];

  // Middleware global berjalan untuk SEMUA route (misalnya logger)
  use(mw: Middleware): void {
    this.globalMiddlewares.push(mw);
  }

  private add(method: string, pattern: string, middlewares: Middleware[], handler: Handler): void {
    this.routes.push({
      method,
      pattern,
      segments: pattern.split('/').filter(Boolean),
      middlewares,
      handler,
    });
  }

  get(pattern: string, ...args: [...Middleware[], Handler]): void {
    this.addRouteArgs('GET', pattern, args);
  }
  post(pattern: string, ...args: [...Middleware[], Handler]): void {
    this.addRouteArgs('POST', pattern, args);
  }
  put(pattern: string, ...args: [...Middleware[], Handler]): void {
    this.addRouteArgs('PUT', pattern, args);
  }
  patch(pattern: string, ...args: [...Middleware[], Handler]): void {
    this.addRouteArgs('PATCH', pattern, args);
  }
  delete(pattern: string, ...args: [...Middleware[], Handler]): void {
    this.addRouteArgs('DELETE', pattern, args);
  }

  private addRouteArgs(method: string, pattern: string, args: (Middleware | Handler)[]): void {
    const handler = args[args.length - 1] as Handler;
    const middlewares = args.slice(0, -1) as Middleware[];
    this.add(method, pattern, middlewares, handler);
  }

  // Menggabungkan routes dari router lain ke router ini.
  // Berguna untuk memecah routes ke banyak file lalu menggabungkannya.
  merge(other: Router): void {
    for (const route of other.getRoutes()) {
      this.routes.push(route);
    }
  }

  getRoutes(): Route[] {
    return this.routes;
  }

  // ─── URL matching ───────────────────────────────────────────────────────
  // Inti dari semua router: mencocokkan path aktual dengan pola.
  //
  //  pola:    ['api', 'projects', ':id']
  //  path:    ['api', 'projects', 'abc123']
  //  hasil:   cocok! params = { id: 'abc123' }
  //
  // Segmen yang diawali ':' adalah "wildcard bernama" — cocok dengan
  // apapun, dan nilainya ditangkap ke params.
  private match(route: Route, pathSegments: string[]): Record<string, string> | null {
    if (route.segments.length !== pathSegments.length) return null;

    const params: Record<string, string> = {};
    for (let i = 0; i < route.segments.length; i++) {
      const patternSeg = route.segments[i];
      const pathSeg = pathSegments[i];

      if (patternSeg.startsWith(':')) {
        // M18e hardening: URL hostile (`%%`, `%e0%80`, `%ff`) membuat
        // decodeURIComponent melempar URIError → 500/crash. Fallback:
        // pakai segmen mentah (handler atas yang memvalidasi isi param).
        try {
          params[patternSeg.slice(1)] = decodeURIComponent(pathSeg);
        } catch {
          params[patternSeg.slice(1)] = pathSeg;
        }
      } else if (patternSeg !== pathSeg) {
        return null; // segmen literal tidak cocok
      }
    }
    return params;
  }

  // ─── Main dispatch — dipanggil oleh http server untuk setiap request ────
  async handle(rawReq: IncomingMessage, rawRes: ServerResponse): Promise<void> {
    const url = new URL(rawReq.url ?? '/', `http://${rawReq.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const method = rawReq.method ?? 'GET';

    const res = makeResponse(rawRes);

    // Baca body (jika ada). Perhatikan: body datang sebagai STREAM —
    // kita harus mengumpulkannya chunk demi chunk. Inilah yang disembunyikan
    // express.json() darimu selama ini!
    //
    // M14: kalau Content-Type = multipart/form-data → simpan Buffer mentah
    // + informasi multipart di req (parser dijalankan oleh handler yang
    // butuh — supaya endpoint JSON tidak membayar biaya parsing).
    let body: unknown = undefined;
    let rawBody: Buffer | undefined;
    const contentTypeHeader = String(rawReq.headers['content-type'] ?? '');
    const isMultipart = contentTypeHeader.startsWith('multipart/form-data');
    if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
      const maxLimit = isMultipart ? 105 * 1024 * 1024 : 10 * 1024 * 1024;
      try {
        rawBody = await readRawBody(rawReq, maxLimit);
      } catch (err: unknown) {
        const isTooLarge = (err as { code?: string })?.code === 'PAYLOAD_TOO_LARGE';
        res.status(isTooLarge ? 413 : 400).json({
          error: {
            code: isTooLarge ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
            message: isTooLarge
              ? `Request body exceeds size limit (${Math.round(maxLimit / 1024 / 1024)}MB)`
              : 'Failed to read request body',
          },
        });
        return;
      }

      if (!isMultipart && rawBody.length > 0) {
        try {
          const text = rawBody.toString('utf-8');
          body = JSON.parse(text);
        } catch {
          // M23-hardening: JSON rusak dulu = 400 rapi, BUKAN throw —
          // throw di sini jadi unhandled rejection & MEMATIKAN server
          // (satu request = satu DoS).
          res.status(400).json({
            error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' },
          });
          return;
        }
      }
    }

    const req: ForgeRequest = {
      method,
      path,
      params: {},
      query: url.searchParams,
      headers: rawReq.headers,
      body,
      raw: rawReq,
    };
    // M14: lampirkan buffer mentah + flag multipart (ekstensi request)
    (req as ForgeRequest & { rawBody?: Buffer; isMultipart?: boolean }).rawBody = rawBody;
    (req as ForgeRequest & { rawBody?: Buffer; isMultipart?: boolean }).isMultipart = isMultipart;

    // M24: instrumentasi metrics (request & bandwidth per project).
    // Cara hitung bytesOut: bungkus write/end dari response mentah —
    // mencakup res.json(), file streaming (M14), SSE (M13), semuanya.
    // Pencatatan terjadi di event 'finish' (setelah response selesai),
    // jadi handler tidak menanggung biaya apa pun.
    let bytesOut = 0;
    const trackChunk = (chunk: unknown): void => {
      if (typeof chunk === 'string') bytesOut += Buffer.byteLength(chunk);
      else if (chunk && typeof (chunk as Buffer).length === 'number') bytesOut += (chunk as Buffer).length;
    };
    const rawResAny = rawRes as unknown as {
      write: (...args: unknown[]) => boolean;
      end: (...args: unknown[]) => unknown;
    };
    const origWrite = rawResAny.write.bind(rawRes);
    const origEnd = rawResAny.end.bind(rawRes);
    rawResAny.write = (...args: unknown[]): boolean => {
      trackChunk(args[0]);
      return origWrite(...args);
    };
    rawResAny.end = (...args: unknown[]): unknown => {
      trackChunk(args[0]);
      return origEnd(...args);
    };
    rawRes.on('finish', () => {
      const pid = metricsProjectId(path);
      if (pid) {
        trackRequest(pid, rawBody?.length ?? 0, bytesOut);
      }
    });

    try {
      // Jalankan middleware global dulu
      for (const mw of this.globalMiddlewares) {
        const proceed = await mw(req, res);
        if (!proceed) return; // middleware menghentikan request
      }

      // Cari route yang cocok
      const pathSegments = path.split('/').filter(Boolean);
      for (const route of this.routes) {
        if (route.method !== method) continue;

        const params = this.match(route, pathSegments);
        if (!params) continue;

        req.params = params;

        // Jalankan middleware khusus route (misalnya requireAuth)
        for (const mw of route.middlewares) {
          const proceed = await mw(req, res);
          if (!proceed) return;
        }

        await route.handler(req, res);
        return;
      }

      // Tidak ada route cocok → 404
      res.status(404).json({ error: { code: 'NOT_FOUND', message: `${method} ${path} not found` } });
    } catch (err) {
      // Error boundary: handler atau middleware yang melempar error tidak boleh mematikan server
      console.error('[router] Uncaught error in dispatch:', err);
      if (!rawRes.headersSent) {
        res.status(500).json({
          error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Unknown error' },
        });
      }
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeResponse(rawRes: ServerResponse): ForgeResponse {
  const res: ForgeResponse = {
    raw: rawRes,
    status(code: number) {
      rawRes.statusCode = code;
      return res;
    },
    json(data: unknown) {
      rawRes.setHeader('Content-Type', 'application/json');
      rawRes.end(JSON.stringify(data));
    },
  };
  return res;
}

// Membaca stream body sampai habis sebagai BUFFER MENTAH dengan perlindungan batas ukuran (anti DoS/OOM).
// Aha! moment: request body TIDAK tersedia sekaligus — ia mengalir
// sebagai potongan-potongan (chunk) lewat jaringan.
// M14: JSON parsing dipindah ke caller (handle) supaya multipart
// tidak ikut ter-parse sebagai JSON.
function readRawBody(rawReq: IncomingMessage, maxBytes = 10 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const contentLength = parseInt(String(rawReq.headers['content-length'] ?? '0'), 10);
    if (contentLength > maxBytes) {
      const err = new Error('Request payload exceeds size limit');
      (err as { code?: string }).code = 'PAYLOAD_TOO_LARGE';
      reject(err);
      return;
    }

    const chunks: Buffer[] = [];
    let bytesRead = 0;

    const onData = (chunk: Buffer) => {
      bytesRead += chunk.length;
      if (bytesRead > maxBytes) {
        rawReq.off('data', onData);
        rawReq.destroy();
        const err = new Error('Request payload exceeds size limit');
        (err as { code?: string }).code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        return;
      }
      chunks.push(chunk);
    };

    rawReq.on('data', onData);
    rawReq.on('end', () => resolve(Buffer.concat(chunks)));
    rawReq.on('error', reject);
  });
}

// ─── ID generator (gaya PocketBase: 15 karakter random) ────────────────────
// Kenapa bukan UUID? Lebih pendek, URL-safe, dan tetap unik secara praktis.
// Alphabet menghindari karakter ambigu.
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function generateId(length = 15): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let id = '';
  for (let i = 0; i < length; i++) {
    id += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  }
  return id;
}

// ─── Token generator untuk sesi admin (M00 sederhana) ───────────────────────
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
