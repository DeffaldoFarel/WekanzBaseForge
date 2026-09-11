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
        params[patternSeg.slice(1)] = decodeURIComponent(pathSeg);
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

    // Baca body JSON (jika ada). Perhatikan: body datang sebagai STREAM —
    // kita harus mengumpulkannya chunk demi chunk. Inilah yang disembunyikan
    // express.json() darimu selama ini!
    let body: unknown = undefined;
    if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
      body = await readJsonBody(rawReq);
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

      try {
        await route.handler(req, res);
      } catch (err) {
        // Error boundary: satu handler gagal tidak boleh mematikan server
        console.error('[router] Handler error:', err);
        if (!rawRes.headersSent) {
          res.status(500).json({
            error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Unknown error' },
          });
        }
      }
      return;
    }

    // Tidak ada route cocok → 404
    res.status(404).json({ error: { code: 'NOT_FOUND', message: `${method} ${path} not found` } });
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

// Membaca stream body sampai habis, lalu parse JSON.
// Aha! moment: request body TIDAK tersedia sekaligus — ia mengalir
// sebagai potongan-potongan (chunk) lewat jaringan.
function readJsonBody(rawReq: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    rawReq.on('data', (chunk: Buffer) => chunks.push(chunk));
    rawReq.on('end', () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
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
