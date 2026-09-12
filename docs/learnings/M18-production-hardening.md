# M18 — Production Hardening: Swap Library Security-Critical

> Filosofi: "walaupun belajar, aku tetap ingin baseforge di level produksi."
> node:vm bukan mekanisme keamanan; JWT buatan sendiri belum punya alg whitelist;
> parser Buffer manual tidak streaming. M18 mengganti 4 komponen ini dengan
> library teruji, TANPA mengubah satu pun route handler secara logika (dividen
> arsitektur single-gate).

## Hasil Akhir

| Komponen | Sebelum | Sesudah | Alasan |
|---|---|---|---|
| Function sandbox | `node:vm` (V8 context BERBAGAI heap host) | **isolated-vm** (isolate V8 sungguhan) | Context escape node:vm terbukti publik; isolated-vm = memory limit per isolate + tidak berbagi heap |
| JWT | Hand-rolled HMAC-SHA256 (M09) | **jose** | Alg whitelist enforcement (anti alg:none/confusion), standard-compliant, jalan jalan ke OAuth2 (M10) |
| Multipart | Parser Buffer manual (M14a) | **@fastify/busboy** | Battle-tested (dipakai Fastify), edge cases (header folding, boundary dalam konten) ditangani |
| Rate limiter | In-memory Map (M09u) | **ioredis + Lua atomic** (fallback memory otomatis) | Persistent antar restart, SHARED antar multi-instance (WBS queue siap) |

**TIDAK diganti** (sudah production-grade): scrypt `node:crypto` (OpenSSL
teraudit), `node:sqlite` (engine C battle-tested), SSE realtime (150 baris,
fully tested), cron parser (70 baris, 13 test), import/export JSON (format
milik sendiri).

## M18a — isolated-vm (`functionRunner.ts`)

### Perubahan kunci
- `runFunctionCode` **async** sekarang (isolated-vm async API). Semua caller
  (functionRoutes, scheduler, triggerExecutor) hanya menambah `await` — nol
  perubahan logika.
- **Memory limit per isolate**: default 32MB (`memoryLimitMB` option). Function
  `while(true) push()` → isolate OOM sendiri, host TIDAK terpengaruh.
- **Async timeout**: isolated-vm `release()` benar-benar mematikan promise
  sync+async (node:vm timeout sinkron tidak menahan async loop).
- **Host invisible**: `typeof process` → 'undefined', `typeof require` →
  'undefined' (kebocoran referensi node:vm teratasi).
- Pola transfer: host → isolate via `new ivm.ExternalCopy(opts).copyInto()`,
  result balik via `JSON.stringify` DI DALAM isolate → `ExternalCopy` → parse
  di host. Referensi `req` di-inject via `ivm.Reference` agar function bisa
  MEMBACA (jalan via `applySync` on reference).

### Jebakan yang ditemukan
1. **`jail.setSync('req', {...})` gagal** — object host tidak transferable;
   harus `ExternalCopy` atau `Reference`.
2. **`__stringify` Reference dipanggil langsung gagal** ("is not a function")
   — fungsi isolate-side dipanggil via `ref.applySync()`, bukan invoke langsung.
3. Test sync → async: semua `runFunctionCode` di test perlu `await`.

## M18b — jose (`jwt.ts`)

### Perubahan kunci
- `SignJWT` + `jwtVerify` dari `jose` (WebCrypto-based, zero-dependency).
- **Alg whitelist eksplisit**: `algorithms: ['HS256']` di verify — token
  `alg:none` / alg confusion otomatis ditolak.
- Kontrak payload TETAP: `{sub, email?, name?}` + `exp`. `issuer`/`audience`
  diset `'baseforge'`.
- SECRET dari `process.env.AUTH_SECRET ?? fallback dev` (sama seperti M09).
- `verifyToken` & `signToken` **async** → caller di-update: authRoutes
  (login/register/refresh/me), publicRoutes (resolveEndUserCtx ×5 handler),
  functionRoutes (resolveUserAuth), storageRoutes, realtimeRoutes.
- Refresh tokens (M09 tokens.ts) TIDAK berubah — masih tabel `_auth_tokens`
  hashed; jose hanya untuk access token (stateless JWT).

### Jebakan yang ditemukan
- **`await verifyToken(x).valid` = BUG** — `.valid` diakses pada Promise →
  undefined. Harus `(await verifyToken(x)).valid`. Python regex replace
  menghasilkan pola ini di test M09 → harus dibenahi manual.

## M18c — @fastify/busboy (`multipart.ts`)

### Perubahan kunci
- `parseMultipart` async (Promise). `multipartToRecordData` & router handler
  cuma nambah `await`.
- Streaming: busboy baca part-per-part dari `Readable.from(body)` — satu file
  di-buffer sekali di handler (untuk disimpan disk), BUKAN seluruh body
  di-buffer dua kali.
- `sanitizeFilename` kini menerima `string | undefined | null` (guard).

### Jebakan yang ditemukan (PENTING!)
1. **Signature event `file` @fastify/busboy v3 BERBEDA dari busboy klasik**:
   `(fieldname, stream, filename, transferEncoding, mimeType)` — filename =
   argumen ke-3 STRING, bukan `info.filename` object! Salah baca → filename
   `undefined` → tersimpan sebagai "file" (guard sanitizeFilename menyelamatkan).
2. **TIDAK ADA event `close`** di v3 (yang klasik ada). Selesai = `finish`
   (semua part selesai ditulis) + semua file stream `end`. Parser menunggu
   keduanya via counter `pendingFiles` + flag `finished`.
3. **`stream.truncated`** boolean di file stream (bukan event `limit` saja)
   menandakan fileSize limit tercapai → reject.
4. **Bug tersembunyi migration `viewQuery`**: PRAGMA table_info mengembalikan
   nama kolom lowercase SQLite (`viewquery`), pengecekan `c.name === 'viewquery'`
   GAGAL mencocokkan kolom `viewQuery` yang sudah ada → ALTER TABLE duplikat →
   400 "duplicate column name: viewQuery". Fix: `c.name.toLowerCase() ===
   'viewquery'`. (Lesson: SQLite case-insensitive untuk identifier; selalu
   bandingkan lowercase.)

## M18d — ioredis rate limiter (`auth/rateLimiter.ts`)

### Perubahan kunci
- **Redis fixed-window ATOMIK via Lua script** (`INCR` + `EXPIRE` + `TTL` dalam
  satu script) — anti race condition multi-instance.
- **Graceful degradation**: `REDIS_URL` tidak diset / Redis down → otomatis
  fallback ke memory Map (kode M09u asli utuh). Server TETAP hidup tanpa Redis.
- `reconnecting` + `retryStrategy` capped 5s; error Redis TIDAK crash server.
- `resetAllRateLimits` pakai `SCAN` (bukan `KEYS` — KEYS blok produksi).
- `checkRateLimit` & `secondsUntilReset` **async** → authRoutes menambah `await`.
- Prefix key `rl:` agar scan/reset terisolasi dari data Redis lain (WBS queue).

### Jebakan yang ditemukan (PENTING!)
1. **Jebakan ESM hoisting**: `process.env.REDIS_URL = ...` di file test TIDAK
   terbaca oleh module yang membaca env saat import — ESM mengangkat import
   statis DI ATAS assignment. Fix: env dibaca LAZY via `ensureRedis()` saat
   call pertama (init-once flag).
2. **Jebakan race koneksi**: ioredis `ready` event ASYNC (~15-20ms), request
   pertama sering datang sebelum ready → selamanya memory fallback. Fix:
   `waitForRedisReady(maxMs=2000)` — poll tiap 20ms, timeout → fallback.
   Setelah fix: probe E2E menunjukkan key `rl:login:::ffff:127.0.0.1` = 12,
   TTL 52s di Redis nyata, dan 429 tepat di call ke-11 (limit 10).
3. **Dua server 5100**: server lama (start sebelum M18d) masih jalan tanpa
   `REDIS_URL` → probe 429 datang dari memory fallback server lama. Lesson:
   saat verifikasi env-dependent, kill server lama dulu & cek `CommandLine`
   proses yang listen di port.
4. IPv6 mapping: Node bind `[::]:5100` → remoteAddress `::ffff:127.0.0.1`
   (bukan `127.0.0.1`) — key Redis ikut format ini. Normal, bukan bug.

### Verifikasi E2E M18d (server :5100 + Redis :16379)
1. `REDIS_URL=... tsx src/index.ts` → health OK
2. 12x login password salah → `401 ×10, 429 ×2` (limit 10/menit)
3. Redis berisi `rl:login:::ffff:127.0.0.1` = 12, TTL 52s (backend Redis nyata!)
4. Tanpa `REDIS_URL` → fallback memory bekerja (5 call, limit 3 → pola sama)
5. 279/279 test tetap hijau

## Verifikasi E2E M18a-c (HTTP nyata, server :5100)

1. **isolated-vm**: create function `sapa` → execute `{"nama":"Farel"}` →
   `{"result":{"pesan":"Hai Farel"},"logs":["[log] [\"dipanggil\",\"Farel\"]"]}`
2. **jose**: register budi@m18.id → login → accessToken **3 bagian** → /auth/me
   identitas benar
3. **busboy**: upload `m18test.txt` (multipart POST) → record.doc =
   `m18test.txt` (nama asli, bukan "file"!) → serve via `/api/files/...` →
   **BYTES IDENTIK** (cmp)
4. **279/279 test lulus** (31 suite, dijalankan per-suite; `npm test` penuh
   hang karena test SSE menahan event loop — bukan kegagalan).

## Sukses Criteria (dari rencana)

- ✅ Semua 279 test tetap hijau setelah tiap swap
- ✅ Tidak ada route handler yang berubah logikanya (hanya `async`/`await`)
- ✅ Single-gate terjaga: `runFunctionCode`, `signToken`/`verifyToken`,
  `multipartToRecordData` — API kontrak sama

## Dependensi Baru (server)

```
isolated-vm     — isolate V8 (native module, prebuilt tersedia)
jose            — JWT/OAuth standard (WebCrypto, zero-dep)
@fastify/busboy — multipart parser (dipakai Fastify production)
ioredis         — Redis client (opsional runtime; hanya aktif jika REDIS_URL diset)
```

## Arah berikutnya

- Audit & hardening router/FTS (fuzz-test URL encoding, rate limit khusus search).
- M10: OAuth2 (jose siap verifikasi id_token Google).
- VPS tencentvps1: install Redis (rate limiter + WBS queue, satu install dua
  kebutuhan) — set `REDIS_URL` di PM2 env.
