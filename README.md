# WekanzBaseForge 🛠️

> **Project belajar: membangun complete backend dari bawah — SQL database, auth, functions, storage, dan dashboard admin — untuk memahami cara kerjanya.**

⚠️ **Status: Learning playground, production-hardened core.** Bagian security-critical
(function sandbox, JWT, multipart, rate limiting) sudah memakai library teruji
sejak M18; Wekanz production tetap memakai PocketBase + WBS (WekanzBackendService).

---

## 🎯 Visi

Seperti Firebase Console: satu BaseForge bisa menampung **banyak project**, dan setiap project bisa mengaktifkan **layanan** yang dibutuhkannya:

```
BaseForge (1 instalasi)
 └── 📁 Projects
      ├── Project "wekanz"    → database ✅ auth ✅ storage ✅
      ├── Project "bookmark"  → database ✅ functions ✅
      └── Project "blog"      → database ✅ saja
```

**Prinsip arsitektur (meniru PocketBase):**
- Setiap project = **1 file SQLite terpisah** (`data/projects/<id>/data.db`)
- Isolasi total antar project; backup/hapus/pindah = copy/hapus file
- Dashboard = client murni dari Admin API (semua bisa via API)

**Dua jenis user (jangan tertukar!):**
| Jenis | Contoh | Login di |
|-------|--------|----------|
| **Admin** | developer pengelola BaseForge | Dashboard BaseForge |
| **End user** | pengguna aplikasi (misal user Wekanz) | Auth service per project |

## 🧰 Tech Stack

| Komponen | Pilihan | Alasan |
|----------|---------|--------|
| Bahasa | TypeScript (Node.js >= 22.5) | Fokus ke konsep, bukan belajar bahasa |
| Mesin database | Built-in `node:sqlite` | Engine C SQLite teruji 25 thn tanpa native addon eksternal |
| HTTP server | `node:http` → router buatan sendiri | Belajar arsitektur internal web server |
| Dashboard | Next.js 15 + React 19 + Tailwind | Console multi-project ala Firebase |
| Hashing (M08) | `scrypt` via `node:crypto` | OpenSSL teraudit, tahan GPU brute force |
| JWT (M09, M18b) | `jose` | WebCrypto-standard, alg whitelist enforcement |
| Multipart (M14, M18c) | `@fastify/busboy` | Streaming, memory-safe untuk upload file |
| Functions (M15, M18a) | `isolated-vm` | Isolate V8 sungguhan, memory cap & async timeout |
| Rate Limiter (M18d) | `ioredis` + Lua (fallback memory) | Atomic fixed-window, persistent, multi-instance ready |
| Test | `node:test` + `tsx` | Test runner bawaan Node, 502 tests |

## 🚀 Quick Start

### 📋 Prasyarat
* **Node.js >= 22.5.0** (wajib, karena BaseForge memakai built-in `node:sqlite`)
* **npm >= 10**

### 1. Clone & Install
```bash
git clone https://github.com/DeffaldoFarel/WekanzBaseForge.git
cd WekanzBaseForge

# Install dependencies untuk server dan dashboard sekaligus (via npm workspaces)
npm install
```

### 2. Jalankan Service

Buka 2 terminal (atau jalankan di background):

**Terminal 1 — Core Server (Backend API):**
```bash
npm run dev:server
# → Berjalan di http://localhost:5100
# → Health check: http://localhost:5100/api/health
```

**Terminal 2 — Admin Dashboard (Web UI):**
```bash
npm run dev:dashboard
# → Dashboard berjalan di http://localhost:7701
```

### 3. Login Dashboard
Buka browser ke **http://localhost:7701**:
* **Email:** `admin@baseforge.local`
* **Password:** `admin123`

*(Kredensial di atas adalah nilai default development. Database lokal dan direktori `data/` akan dibuat otomatis saat pertama kali server dinyalakan).*

### 4. Menjalankan Test Suite
```bash
npm test
# Menjalankan 502 unit & integration tests (semua suite hijau)
```

## 📚 Dokumentasi Lengkap

Untuk panduan mendalam tentang penggunaan BaseForge sebagai BaaS (Backend-as-a-Service) pada aplikasi Anda, silakan baca dokumentasi resmi di folder `docs/`:

* 📖 [**Portal Dokumentasi Utama**](docs/README.md)
* 🚀 [**Panduan Memulai & Konfigurasi (.env)**](docs/getting-started.md)
* 📦 [**Client SDK TypeScript (`@wekanz/baseforge`)**](packages/client/README.md)
* 📡 [**REST API Reference (Auth, Records CRUD, Query Filter, Files, & Thumbnails)**](docs/api-reference.md)
* 🔒 [**API Rules & Keamanan Row-Level (RLS)**](docs/api-rules.md)
* ⚡ [**Serverless Functions, Database Triggers, & Scheduler Cron**](docs/functions.md)
* 📡 [**Realtime Subscriptions (Server-Sent Events)**](docs/realtime.md)
* 🖥️ [**Panduan Deployment Produksi (Linux Systemd, Caddy HTTPS, & Redis)**](docs/deployment.md)
* 🧠 [**Jurnal Belajar Arsitektur (Milestone M00 – M39)**](docs/learnings/README.md)
* 🥊 [**Perbandingan BaaS + Roadmap M40–M57 (vs PocketBase, Supabase, Appwrite)**](COMPARISON.md)

## 🗺️ Roadmap (per milestone)

### 🛠️ Tambahan Platform
- [x] M00 — Shell: platform.db, admin login, project registry API, dashboard ✅
- [x] M24 — Usage metrics: request & bandwidth stats per project ✅
- [x] M26 — Per-project API keys ✅ — server-to-server access (Bearer bf_ /
      X-API-Key), scope read/write, bypass API Rules (service-level ala
      Supabase service_role), hash SHA-256 at-rest, key penuh tampil sekali,
      rate limit 300 req/menit per key, usage tracking real-time (buffer+flush),
      revoke instan, UI di project overview
- [x] M28 — Webhooks + CLI ✅ — webhooks outbound HMAC-SHA256 + retry
      exponential backoff + delivery log (100 terakhir), event matching
      wildcard `*`/`col.*`; CLI admin (login/projects/records/functions/
      users/webhooks)
- [x] M32 — Scheduled backup ✅ — VACUUM INTO per project via scheduler,
      retensi 1–30 backup, metadata .json bersebelahan, download admin +
      path-traversal guard
- [x] M33 — Monitoring/alerting ✅ — threshold rules (request rate,
      bandwidth, error rate, disk usage), alert state firing/resolved +
      cooldown, notifikasi webhook Slack-format, force-check manual, OFF
      by default

### 📦 SQL Database
- [x] M01 — KV store sederhana ✅
- [x] M02 — SQLite + raw queries (prepared statements) ✅
- [x] M03 — Meta-tables: schema-as-data (inti strategi PocketBase!) ✅
- [x] M04 — Query parser (filter string → SQL, lexer/parser/AST) ✅
- [x] M05 — Record API + REST endpoints generik ✅
- [x] M06 — Indexing & EXPLAIN QUERY PLAN ✅
- [x] M07 — Transactions, ACID & WAL ✅
- [x] M12 — Relations & expand (JOIN dinamis, N+1) ✅ *(REST dibuka di M19)*
- [x] M05u 🖥️ — Dashboard: schema builder + data browser ✅
- [x] M29 — Vector search ✅ — field type vector, cosine/L2 similarity,
      top-k ranking + threshold, pre-filter ekspresi M04; brute-force scan
      (cukup untuk < 50K vectors × 1536 dims, ~50–200ms)

### 🔬 Deepening Database (production-grade)
- [x] D1 — Unique constraint ✅
- [x] D2 — Multi-relation ✅ *(REST dibuka di M19)*
- [x] D3 — Cascade delete (referential integrity) ✅
- [x] D4 — Table rebuild (schema evolution) ✅
- [x] D5 — Migration history ✅
- [x] D6 — Nested expand ✅ *(REST dibuka di M19)*
- [x] D7 — Aggregates (count/sum/avg/min/max, GROUP BY) ✅ *(REST dibuka di M19)*
- [x] M19 — Wire the orphans: REST agregasi + expand ✅
- **M20 — Parity check vs Wekanz Dashboard** ✅ 21 koleksi / 162 atribut diuji; 10/10 query produksi lulus; 3 blocker migrasi ditemukan
- **M21 — Unblock migration** ✅ camelCase diizinkan, rules tersimpan lewat PUT, duplikat → 400; skema asli 21/21 tanpa rename
- **M22 — Redesign sistem desain (lengkap: fondasi + rombak halaman + hapus class tangan)** ✅ 10 komponen shadcn baru (select, checkbox, label, textarea, skeleton, separator, alert-dialog, table, dropdown-menu, tooltip); 22+ file dirombak (9 halaman + 11 komponen studio + 2 modal + 1 editor + 5 komponen shared + FieldOptionsEditor 14 tipe); 365 baris class tangan dihapus dari globals.css (441 → 71 baris); `tsc` 0 error; semua halaman terverifikasi berfungsi

  > **Catatan audit:** `aggregates.ts` dan `relations.ts` sudah lengkap & teruji
  > sejak D7/M12, tetapi **tidak diimpor satu pun route** — fitur hijau di test
  > namun tidak terjangkau klien. M19 membuka pintunya:
  > `GET .../collections/:name/aggregate` (admin + publik, listRule ditegakkan)
  > dan `?expand=` yang benar-benar terpasang di `listRecords`/`getRecord`.
  > Dashboard mendapat tab **Aggregations** (query builder + live request
  > preview + bar chart per grup) di Database Studio.

### 📦 Batch: Melengkapi fitur database (~90% PocketBase)
- [x] B1 — Field types: select, autodate, url ✅
- [x] B2 — Backup & restore (VACUUM INTO) ✅
- [x] B3 — Duplikasi collection + batch API ✅

### 🧩 M16: Menutup gap SQL Database ✅ — GAP DITUTUP!
- [x] M16a — View collections (SQL view read-only + rules + filter M04) ✅
- [x] M16b — Field types baru: editor, geoPoint, password (hash-only write) ✅
- [x] M16c — Import/Export JSON (create/replace/merge upsert by id) ✅

### 🚀 M17: 100% SQL Database parity ✅ — SQL DATABASE 100%!
- [x] M17a — Any-match operator (?=, ?!=, ?~, ?>, dst via json_each) ✅
- [x] M17b — FTS5 full-text search (?search=, trigger-synced, +rules) ✅

### 🛡️ M18: Production Hardening ✅ — security-critical swap ke library teruji
- [x] M18a — Function sandbox: node:vm → **isolated-vm** (isolate V8 nyata, memory limit/isolate, async timeout, host invisible) ✅
- [x] M18b — JWT: hand-rolled → **jose** (alg whitelist HS256, standard-compliant, OAuth2-ready) ✅
- [x] M18c — Multipart: parser manual → **@fastify/busboy** (streaming, battle-tested) ✅
- [x] M18d — Rate limiter: in-memory → **ioredis + Lua atomic** (fallback memory otomatis, persistent & shared antar instance) ✅
- [x] M18e — Hardening router & FTS (fuzz-test menangkap URIError bug nyata!, sanitizer diperkuat, rate limit khusus ?search=) ✅

> Prinsip M18: single-gate module membuat swap tanpa mengubah satu pun route
> handler; `scrypt node:crypto`, `node:sqlite`, SSE, cron parser TIDAK diganti
> (sudah production-grade). 472 test hijau.

### 🔐 Auth (per project) — ✅ FASE SELESAI (email/password + OAuth2 + email service)
- [x] M08 — Password hashing (scrypt) ✅
- [x] M09 — JWT + sessions + refresh tokens ✅
- [x] M09u — Auth API endpoints (register/login/refresh/me/logout + rate limit) ✅
- [x] M11 — API rules (row-level security) ✅ — FASE AUTH TUNTAS!
- [x] M10 — OAuth2 (Google & GitHub) ✅ — authorization code flow, account
      linking anti-takeover (email unverified → tolak), state satu-kali-pakai
      (TTL 10 mnt), client secret terenkripsi AES-256-GCM, `redirect_to` +
      allow-list origins, token dikirim via URL fragment ala PocketBase
- [x] M23 — Email service + verifikasi email + reset password ✅ — SMTP via
      nodemailer (config runtime Admin API / env) dengan DEV OUTBOX fallback
      (email tersimpan di DB + link bisa diambil dashboard), token aksi
      sekali-pakai (verify 24j / reset 1j), anti user-enumeration, reset =
      revoke semua sesi, halaman HTML self-contained + `redirect_to` ala M10
- [x] M27 — MFA/TOTP (RFC 6238) ✅ — TOTP dari nol via node:crypto (divalidasi
      vektor resmi RFC), enrollment pending→confirm, login 2-faktor
      (mfaToken 5 menit), 10 recovery codes sekali-pakai (hash at-rest),
      challenge rate-limit 5/15mnt (anti brute-force 6-digit), admin
      mfa-reset, timing-safe compare, window ±1
- [x] M31 — OAuth2 multi-provider ✅ — 6 provider penuh (Google, GitHub,
      Microsoft, Discord, GitLab, Facebook) + Apple stub (ES256 menyusul);
      pola data-driven `OAUTH_PROVIDER_DEFS`: nambah provider = nambah entry
- [x] M10u 🖥️ — Dashboard: user management + rules editor ✅

### ⚡ Functions (per project)
- [x] M15a — Callable functions (node:vm sandbox + timeout + CRUD + execute) ✅
- [x] M15b — Database triggers (create/update/delete + previous + fail-safe) ✅
- [x] M15c — Scheduler (cron 5-field parser + anti double-fire + sandbox) ✅
- [x] M15u 🖥️ — Dashboard: function editor + run panel + badges ✅ — FASE FUNCTIONS TUNTAS!
- [x] M25 — `$http.send` di sandbox ✅ — jaringan terkurasi untuk functions:
      allowlist per-function (`*` = host publik; literal = opt-in internal),
      SSRF guard (private/loopback/metadata IP diblok), redirect manual
      re-validated, timeout per-request, response cap 1MB, runner async
      (await) + wall-clock timeout ganda. 390 test.
- [x] M39 — Cron timezone IANA ✅ — `cronMatchesInTimezone` via
      `Intl.DateTimeFormat` (ICU bawaan Node — DST-aware, zero dependency,
      bukan offset hard-coded), field `timezone` per-function di store +
      API create/PATCH dengan validasi 2 lapis, default UTC deterministik
      (cron = kontrak eksplisit, tidak tergantung TZ mesin)

### 📁 Storage (per project)
- [x] M14a — Upload/serving per project ✅ (multipart dari nol + field file + serving aman)
- [x] M14u 🖥️ — Dashboard: file browser (upload modal + thumbnail + link) ✅
- [x] M14b — Thumbnails ala PocketBase (?thumb=WxH, lazy + cache, Sharp) ✅
- [x] M30 — S3/R2 storage backend ✅ — AWS SigV4 dari nol via node:crypto
      (ZERO dependency baru), path-style addressing, StorageAdapter
      lokal/S3, thumbnail tetap cache lokal, mock S3 server untuk test
- [x] M35 — Bucket storage decoupled ✅ — 5 endpoint (upload multipart →
      fileId, serve public + Cache-Control, list milik sendiri, delete
      owner/admin), determinate fileId = overwrite (idempoten migrasi ala
      Appwrite), metadata `uploadedBy`, SDK `getBucketUrl()`

### 📡 Tambahan
- [x] M13 — Realtime subscriptions (SSE ala PocketBase) ✅
- [x] M24 — Usage metrics: request & bandwidth stats per project ✅ — buffer
      in-memory + flush batch 30 detik (anti write amplification single-writer),
      instrumentasi router (write/end wrap), atribusi dari path (public/admin/files),
      endpoint stats 14 hari + total, kartu & bar chart di dashboard overview

### 🔌 Kesiapan backend WekanzDashboard — gap audit (M34–M39) ✅ FASE TUNTAS
- [x] M34 — Custom document ID ✅ — `data.id` opsional saat create
      (`[a-zA-Z0-9_-]{1,64}`), fail-fast duplikat → 409 DOCUMENT_ID_TAKEN,
      rantai resolusi `customId ?? preGeneratedId ?? generateId()`, SDK
      `createWithId()` — kompatibel migrasi Appwrite/PocketBase
- [x] M36 — SSE auto-reconnect di SDK ✅ — exponential backoff 1s→30s cap,
      re-sync semua subscription aktif ke clientId baru, hook `onReconnect`
      (re-fetch initial data), guard `manuallyClosed` (unsubscribe ≠ drop)
- [x] M37 — 401 auto-refresh di SDK ✅ — singleton refresh lock (N request
      401 bersamaan = 1 POST refresh), retry original request, refresh
      endpoint excluded (anti infinite loop), gagal → SESSION_EXPIRED
- [x] M38 — Delete event full payload ✅ — snapshot sebelum DELETE dikirim
      konsisten ke realtime + webhook + trigger (fallback `{id}`)

### 🗺️ Rencana ke depan (M40–M57)

> 18 milestone berikutnya (quick wins auth → paritas inti → ops & DX → proyek
> besar) kini punya **satu rumah saja: [COMPARISON.md](COMPARISON.md) §Roadmap
> M40–M57** — dikelola di sana agar tidak ada dua sumber roadmap yang saling
> bohong. Selesainya Tahap 1 (M40–M44) → cakupan kompetitif 47/60; semua
> tuntas → 60/60. Nomor bergeser dari rencana lama karena **M34–M39 telah
> terpakai (dan tuntas) untuk gelombang audit kesiapan WekanzDashboard**
> di section 🔌 di atas.


## 📁 Struktur

```
WekanzBaseForge/
├── server/                 ← BaseForge core (API + engine)
│   ├── src/
│   │   ├── core/           ← engine: db, schema, records, query
│   │   ├── platform/       ← multi-project: registry, admin auth
│   │   ├── api/
│   │   │   ├── admin/      ← /api/admin/* (untuk dashboard)
│   │   │   └── client/     ← /api/projects/:id/* (untuk aplikasi end user)
│   │   └── index.ts
│   └── package.json
├── dashboard/              ← Next.js admin UI
│   └── app/
│       ├── login/
│       ├── projects/       ← daftar project (seperti Firebase home)
│       └── projects/[id]/  ← detail project (per layanan)
├── packages/
│   └── client/             ← Official TypeScript Client SDK (@wekanz/baseforge)
│       ├── src/
│       └── README.md
├── data/                   ← semua data (seperti pb_data)
│   ├── platform.db         ← admin accounts + project registry
│   └── projects/<id>/
│       ├── data.db         ← SQLite per project
│       └── files/          ← storage per project
├── docs/                   ← Dokumentasi resmi BaaS & panduan deployment
│   └── learnings/          ← jurnal "aha!" per milestone
└── README.md
```

## 🔗 Relasi dengan Project Lain

| Project | Peran |
|---------|-------|
| WekanzBackendService (WBS) | Production compute — **tidak tersentuh** |
| PocketBase | Production database + auth — **tidak tergantikan** |
| **WekanzBaseForge** | Lab belajar — berdiri sendiri |

## 🧭 Prinsip Belajar

1. **Belajar > cepat selesai** — setiap komponen ditulis dengan pemahaman
2. **Bangun di atas fondasi teruji** (SQLite), bukan dari nol
3. **Tidak ada beban production** — bebas rusak, refactor, lambat
4. **Dokumentasikan setiap "aha!"** di `docs/learnings/`

---

*Dimulai 2026 — wahana memahami backend secara mendalam.*
