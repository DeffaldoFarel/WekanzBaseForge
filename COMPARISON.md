# 🥊 Perbandingan Komprehensif BaaS Open-Source: BaseForge vs PocketBase vs Supabase vs Appwrite

> Analisis teknis, perbandingan fitur per modul, dan evaluasi operasional *self-hosted* — diperbarui pada commit **`1e386f3` (2026-09-20)** setelah BaseForge menyelesaikan **M00–M47 + Ops-1…Ops-16**. Gelombang sejak revisi sebelumnya (M39): M41 `$db`, M42 `$env`, M43 `$lib`, M44 function limits, M46 riwayat eksekusi function, M47 halaman Auth Users, Ops-1/2/3 ketahanan operasional (busy_timeout, batch transaksional, restore terdokumentasi), Ops-4 rules nested, Ops-6 kontrak realtime (bulk sync + auth SSE late-binding + fail-safe delete), Ops-9…Ops-13 konsolidasi ke SATU auth surface, Ops-14 dashboard, **Ops-15 penegakan `disabled`**, **Ops-16 custom profile field tervalidasi**.
>
> **Angka terverifikasi 2026-09-20:** `npm test` = **656/656 tests hijau** (74 file test); **137 route HTTP** terdaftar; **6 dependency produksi** (`@fastify/busboy`, `ioredis`, `isolated-vm`, `jose`, `nodemailer`, `sharp`); RAM idle **~105 MB** di Linux production (tencentvps1, 3 project aktif). Pesaing dibandingkan pada **versi open-source / self-hosted terbaru per 2026-09-20**: PocketBase **v0.39.11** (stable; v0.40 masih pre-release), Supabase self-hosted **0.7.1** (Postgres 17 + Envoy), Appwrite **2.0** (self-hosted sejak 7 Sep 2026: PostgreSQL default, Console IV, ClickHouse untuk executions).
>
> **Cara membaca dokumen ini dengan jujur:** setiap ✅ BaseForge dijaga oleh test suite kita sendiri dan diverifikasi ulang via `grep`/HTTP nyata (lihat §6) — BUKAN audit independen. Kolom pesaing berasal dari dokumentasi/changelog resmi mereka, bukan dari menjalankan produknya. Angka cakupan (§5) menghitung fitur yang *dipetakan*, bukan kedalaman implementasi.

---

## 📌 1. Ringkasan Eksekutif

| Karakteristik | WekanzBaseForge | PocketBase | Supabase (Self-Hosted) | Appwrite (Self-Hosted) |
|---|---|---|---|---|
| **Bahasa / Bentuk** | TypeScript · 1 proses Node.js | Go · **1 binary tunggal** | Microservices (~12 container) | Microservices (~15+ container, kini **+ ClickHouse**) |
| **Database** | SQLite multi-file (1 project = 1 file) | SQLite tunggal | **PostgreSQL 17** (default sejak Jun 2026) | **PostgreSQL default** (sejak 2.0; MariaDB & MongoDB didukung) |
| **RAM Idle** | **~105 MB** (Linux prod, terukur) / ~181 MB (Windows dev `tsx`) | **~30–80 MB** 🔥 | ~3–4.5 GB | ~2.5–3 GB (+ ClickHouse) |
| **VPS Min.** | 512 MB ($3/bln) | 256 MB ($2/bln) | 4–8 GB ($20–40/bln) | 4 GB ($15–25/bln) |
| **Konsol Admin** | Next.js terpisah (docs viewer, metrics, monitoring) | Admin UI **ter-embed** di binary | Studio (container tersendiri) | Console 2.0 (rebuild total) |
| **Fondasi Auth** | Password + **6 OAuth penuh + 1 stub** (Google, GitHub, Microsoft, Discord, GitLab, Facebook; Apple stub) + MFA/TOTP + email verify/reset + API keys + **disable ditegakkan (Ops-15)** + **custom profile field tervalidasi dgn pemisahan user/admin-editable (Ops-16)** | Password + **17 OAuth** + MFA/OTP + verify/reset + impersonate + auth collection custom field | Password + 20+ OAuth + MFA + SAML SSO + kunci `sb_` asimetris + `user_metadata`/`app_metadata` (JSON bebas) | Password + 30+ OAuth + MFA + SMS OTP + impersonate + `prefs`/`labels` (JSON bebas) |
| **Vector/AI** | ✅ Field type vector + cosine/L2 (brute-force) | ❌ | ✅ pgvector (native C) | ✅ VectorsDB (HNSW + embedding model bawaan — **Cloud GA; self-host OFF by default**, butuh engine MongoDB/PG ekstra) |
| **Webhooks** | ✅ HMAC-SHA256 + retry | ❌ (via hooks) | ⚠️ pg_net (rumit) | ✅ |
| **CLI** | ✅ login/projects/records/functions/users/webhooks | ✅ (serve, migrate, superuser) | ✅ | ✅ |
| **Sudut Unik** | Konsol multi-project + metrics + monitoring + vector + $http + webhooks + S3 zero-dep + CLI + dev outbox — **semua dalam 1 proses Node < 200 MB** | Binary super-ringan + auto-HTTPS + LiteFS | Postgres murni + pgvector + 20 OAuth + SAML | Push/SMS/Messaging + 13 runtimes + Sites + VectorsDB |

---

## ⚔️ 2. Matriks Fitur Lengkap (dengan status ✅/❌ BaseForge)

> ✅ = BaseForge PUNYA · ❌ = BaseForge BELUM PUNYA · ⚠️ = Ada tapi terbatas

### A. Database & Kueri

| Fitur | BaseForge | PocketBase | Supabase | Appwrite | Status BF |
|---|---|---|---|---|---|
| CRUD + filter/sort/paginasi | ✅ | ✅ | ✅ | ✅ | **✅** |
| Query parser (lexer/AST) | ✅ | ✅ | PostgREST | ✅ | **✅** |
| Relasi & nested expand | ✅ | ✅ | ✅ | ✅ | **✅** |
| Agregasi (SUM/AVG/GROUP BY) | ✅ | ✅ | ✅ | ❌ | **✅** |
| Full-text search (FTS5) | ✅ | ✅ | ✅ | ⚠️ | **✅** |
| SQL Views (read-only) | ✅ | ❌ | ✅ | ❌ | **✅** |
| Any-match operator `?=` | ✅ | ✅ | ✅ | ❌ | **✅** |
| Schema evolution (Table Rebuild) | ✅ | ✅ | ✅ | ✅ | **✅** |
| Import/Export JSON | ✅ | ✅ | ✅ | ✅ | **✅** |
| **Vector search (embedding)** | ✅ M29 | ❌ | ✅ pgvector | ✅ VectorsDB (Cloud; self-host opt-in) | **✅** |
| Schemaless/document DB | ❌ | ⚠️ (JSON field) | ✅ JSONB | ✅ DocumentsDB (opt-in) | **❌** |
| Multi-tenancy bawaan (1 project = 1 file) | ✅ | ⚠️ | ⚠️ | ✅ | **✅** |
| Backup manual (VACUUM INTO) | ✅ | ✅ | ✅ | ✅ | **✅** |
| **Scheduled backup otomatis + retensi** | ✅ M32 | ✅ CLI | ✅ | ✅ Console | **✅** |
| Batch API transaksional — **create-many** (1 transaksi, rules per record, maks 100) | ✅ Ops-2 | ❌ | ✅ | ❌ | **✅** |
| Batch **mixed-op** (create+update+delete dalam 1 request) | ❌ | ❌ | ✅ | ❌ | **❌** |
| Import CSV | ❌ | ✅ | ✅ | ✅ | **❌** |
| GraphQL API | ❌ | ❌ | ✅ (opt-in sejak 2026) | ✅ | **❌** |
| Multi-node / replikasi HA | ❌ | ✅ LiteFS | ✅ | ✅ | **❌** |
| Stored procedures / RPC | ❌ | ❌ | ✅ | ⚠️ (operators) | **❌** |
| Generated/virtual fields | ❌ | ✅ | ✅ | ❌ | **❌** |
| Geo query lanjutan (radius, bbox) | ❌ | ❌ | ✅ PostGIS | ❌ | **❌** |

### B. Autentikasi & Akun

| Fitur | BaseForge | PocketBase | Supabase | Appwrite | Status BF |
|---|---|---|---|---|---|
| Email + password (scrypt) | ✅ | ✅ | ✅ | ✅ | **✅** |
| JWT + refresh token + revoke | ✅ | ✅ | ✅ | ✅ | **✅** |
| **OAuth2 provider** | ✅ ×7 | ✅ **17+** | ✅ **20+** | ✅ **30+** | **⚠️ (6 penuh + Apple stub)** |
| Account linking anti-takeover | ✅ | ✅ | ✅ | ✅ | **✅** |
| **Email verification** | ✅ M23 | ✅ | ✅ | ✅ | **✅** |
| **Password reset (revoke semua sesi)** | ✅ M23 | ✅ | ✅ | ✅ | **✅** |
| **MFA / TOTP (RFC 6238)** | ✅ M27 | ✅ | ✅ | ✅ | **✅** |
| Recovery codes (10, sekali pakai) | ✅ M27 | ❌ | ✅ | ✅ | **✅** |
| Admin MFA reset | ✅ M27 | ✅ | ✅ | ✅ | **✅** |
| Row-Level Security (API Rules) | ✅ | ✅ | ✅ | ⚠️ | **✅** |
| Rate limiting (Redis+Lua) | ✅ | ✅ | ✅ | ✅ | **✅** |
| **API Keys per project** | ✅ M26 | ⚠️ | ✅ (kunci `sb_` asimetris) | ✅ | **✅** |
| **Disable akun ditegakkan di SEMUA jalur** (login/refresh/OAuth/MFA + revoke sesi) | ✅ Ops-15 | ✅ | ✅ | ✅ (ban) | **✅** |
| **Custom profile field — tervalidasi & kolom SQL asli** (indexable, dipakai di API rules) | ✅ Ops-16 | ✅ (auth collection) | ⚠️ JSON bebas tanpa validasi | ⚠️ `prefs` JSON bebas | **✅ 🔥** |
| **Pemisahan field user-editable vs admin-only** (padanan `app_metadata`) | ✅ Ops-16 | ❌ | ✅ | ✅ (`prefs` vs `labels`) | **✅** |
| Magic link / passwordless | ❌ | ✅ | ✅ | ✅ | **❌** |
| Anonymous auth | ❌ | ✅ | ✅ | ✅ | **❌** |
| Phone/SMS OTP | ❌ | ❌ | ⚠️ (via konfigurasi) | ✅ | **❌** |
| SAML / SSO enterprise | ❌ | ❌ | ✅ | ✅ | **❌** |
| Impersonate user (admin debug) | ❌ | ✅ | ❌ | ✅ | **❌** |
| Session list per-user (revoke individual) | ❌ | ✅ | ✅ | ✅ | **❌** |
| Email policies (block disposable/free domain) | ❌ | ❌ | ❌ | ✅ 2.2 | **❌** |

### C. Email Service

| Fitur | BaseForge | PocketBase | Supabase | Appwrite | Status BF |
|---|---|---|---|---|---|
| SMTP terintegrasi (nodemailer) | ✅ M23 | ✅ | ⚠️ env | ✅ | **✅** |
| Konfigurasi runtime via dashboard | ✅ M23 | ✅ | ❌ | ✅ | **✅** |
| **Dev Outbox (tanpa SMTP)** | ✅ M23 | ❌ | ❌ | ❌ | **✅ 🔥** |
| Send test email | ✅ M23 | ✅ | ❌ | ✅ | **✅** |

### D. Functions & Automasi

| Fitur | BaseForge | PocketBase | Supabase | Appwrite | Status BF |
|---|---|---|---|---|---|
| Runtime | JS di **isolated-vm** | JS hooks di Goja | Deno (Edge) | **13+ bahasa** | **✅ (JS)** |
| Cold start | < 5 ms | < 5 ms | ~10–30 ms | ~100–500 ms | **✅** |
| Memory limit per isolate | ✅ **16–256 MB per-function** (M44) | ❌ | ✅ | ✅ | **✅** |
| Timeout per-function (plafon) | ✅ ≤120 s (M44) | ⚠️ | ✅ | ✅ | **✅** |
| **`$db` binding in-process** (tanpa HTTP/kredensial) | ✅ M41 | ✅ | ✅ | ❌ | **✅** |
| **Secrets per function terenkripsi** (`$env`, AES-256-GCM) | ✅ M42 | ⚠️ | ✅ | ✅ | **✅** |
| **Shared modules** (`$lib`, TS di-strip) | ✅ M43 | ⚠️ | ✅ | ✅ | **✅** |
| **Trigger membawa before-state** | ✅ M15b | ✅ | ✅ | ❌ | **✅ 🔥** |
| DB triggers (CRUD events) | ✅ | ✅ | ✅ | ✅ | **✅** |
| Cron scheduler (5-field) | ✅ | ✅ | ✅ | ✅ | **✅** |
| **`$http` network access (terkurasi)** | ✅ M25 | ✅ | ✅ | ✅ | **✅** |
| Allowlist host (security) | ✅ M25 | ❌ | ❌ | ❌ | **✅** |
| SSRF guard (anti metadata) | ✅ M25 | ❌ | ❌ | ❌ | **✅** |
| **Multi-bahasa** (Python, Go, Rust…) | ❌ | ❌ | ⚠️ | ✅ (Rust sejak 1.9) | **❌** |
| npm packages dalam function | ❌ | ❌ | ✅ | ✅ | **❌** |
| Riwayat eksekusi + log persisten | ✅ M46 (`_function_logs`, retensi 200/function) | ⚠️ (app logs) | ✅ | ✅ (ClickHouse sejak 2.0) | **✅** |

### E. Storage & Files

| Fitur | BaseForge | PocketBase | Supabase | Appwrite | Status BF |
|---|---|---|---|---|---|
| Local disk per project | ✅ | ✅ | ✅ | ✅ | **✅** |
| **S3/R2 backend (zero-dep SigV4)** | ✅ M30 | ⚠️ ext | ✅ (RustFS opt) | ✅ | **✅** |
| Thumbnail on-the-fly (`?thumb=`) | ✅ | ✅ | ✅ | ✅ | **✅** |
| Streaming multipart (memory-safe) | ✅ | ✅ | ✅ | ✅ | **✅** |
| Protected files (auth-gated) | ✅ | ✅ | ✅ | ✅ | **✅** |
| File token (signed URL expiring) | ❌ | ✅ | ✅ | ✅ | **❌** |
| Chunked/parallel upload | ❌ | ❌ | ✅ | ✅ | **❌** |
| Virus scan (ClamAV) | ❌ | ❌ | ❌ | ✅ | **❌** |
| Transformasi gambar lanjut (crop/rotate/blur) | ❌ | ❌ | ✅ | ✅ (AutoGravity 2026) | **❌** |

### F. Realtime

| Fitur | BaseForge | PocketBase | Supabase | Appwrite | Status BF |
|---|---|---|---|---|---|
| SSE per-collection | ✅ | ✅ | ✅ (WebSocket) | ✅ WebSocket | **✅** |
| Filter per-subscription (row-level) | ✅ | ✅ | ✅ | ✅ | **✅** |
| WebSocket dua arah | ❌ | ❌ | ✅ | ✅ | **❌** |
| Presence (siapa online) | ❌ | ❌ | ✅ | ✅ (Presences API 1.9) | **❌** |
| Broadcast ephemeral | ❌ | ❌ | ✅ (binary 2026) | ❌ | **❌** |
| Subscribe topik 1 record (`col/<recordId>`) | ✅ Ops-6 | ✅ | ✅ | ✅ | **✅** |
| Bulk sync subscription (`POST /realtime`, semantik REPLACE) | ✅ Ops-6 | ✅ | ✅ | ✅ | **✅** |
| Auth SSE late-binding (token via `?token=`/POST, 401 keras) | ✅ Ops-6 | ✅ | ✅ | ✅ | **✅** |

### G. Observability & Developer Experience

| Fitur | BaseForge | PocketBase | Supabase | Appwrite | Status BF |
|---|---|---|---|---|---|
| **Usage metrics per project** (req+bandwidth, 14 hari) | ✅ M24 | ❌ | ⚠️ | ❌ | **✅ 🔥** |
| **Monitoring/alerting + notifikasi webhook** (threshold, firing/resolved) | ✅ M33 | ❌ | ⚠️ (via Loki) | ⚠️ | **✅ 🔥** |
| **Docs viewer in-product** (`/docs`) | ✅ | ❌ | ❌ | ❌ | **✅ 🔥** |
| **CLI** (login/projects/records/functions/users/webhooks) | ✅ M28 | ✅ | ✅ | ✅ | **✅** |
| SDK TypeScript (zero-dep) | ✅ | ✅ | ✅ | ✅ | **✅** |
| SDK mobile (Flutter/Swift/Kotlin) | ❌ | ✅ | ✅ | ✅ | **❌** |
| Test suite | **656 test integrasi HTTP** (74 file, terverifikasi 2026-09-20) | mature | besar | besar | **✅** |
| Halaman admin Auth Users (list/verify/disable/MFA reset) | ✅ M47 | ✅ | ✅ | ✅ | **✅** |
| Audit log (siapa/apa/kapan) | ❌ | ❌ | ✅ | ✅ | **❌** |
| Log streaming (Vector/Loki) | ❌ | ❌ | ✅ | ✅ | **❌** |

### H. Integrasi (Webhooks + API)

| Fitur | BaseForge | PocketBase | Supabase | Appwrite | Status BF |
|---|---|---|---|---|---|
| **Webhooks outbound (on CRUD)** | ✅ M28 | ❌ | ⚠️ | ✅ | **✅** |
| HMAC-SHA256 signature | ✅ M28 | ❌ | ❌ | ⚠️ | **✅** |
| Retry dengan exponential backoff | ✅ M28 | ❌ | ❌ | ✅ | **✅** |
| Delivery log (100 terakhir) | ✅ M28 | ❌ | ❌ | ✅ | **✅** |
| Event matching (wildcard `*`, `col.*`) | ✅ M28 | ❌ | ❌ | ✅ | **✅** |
| Push notification (FCM/APNS) | ❌ | ❌ | ❌ | ✅ | **❌** |
| Messaging (email/SMS/push via provider) | ⚠️ (email saja, M23) | ❌ | ❌ | ✅ | **⚠️** |
| Teams/roles granular | ❌ | ❌ | ❌ | ✅ | **❌** |

### I. Operasional

| Fitur | BaseForge | PocketBase | Supabase | Appwrite | Status BF |
|---|---|---|---|---|---|
| **Auto HTTPS (Let's Encrypt bawaan)** | ❌ (pakai Caddy) | ✅ 🔥 | ❌ | ❌ | **❌** |
| Single binary/proses | ✅ | ✅ | ❌ | ❌ | **✅** |
| Tanpa Docker wajib | ✅ | ✅ | ❌ | ❌ | **✅** |
| Restore terdokumentasi + test backup-bisa-dibuka | ✅ Ops-3 | ✅ | ✅ | ✅ | **✅** |
| `busy_timeout` lintas proses (SQLite) | ✅ Ops-1 (5 s) | ✅ | n/a | n/a | **✅** |
| Migrasi framework (file-based, VCS) | ❌ | ✅ | ✅ | ✅ | **❌** |
| Soft delete + trash bin | ❌ | ❌ | ✅ | ❌ | **❌** |

---

## 📊 3. Scorecard — Fitur yang SUDAH vs BELUM

### ✅ BaseForge SUDAH PUNYA (53 fitur inti)

| # | Fitur | Milestone |
|---|---|---|
| 1 | SQL CRUD + filter/sort/paginasi (parser AST) | M04-M05 |
| 2 | Relasi & nested expand | M12/D6 |
| 3 | Agregasi server-side (SUM/AVG/GROUP BY) | D7/M19 |
| 4 | Full-text search (FTS5) | M17b |
| 5 | SQL Views (read-only) | M16a |
| 6 | Any-match operator `?=` | M17a |
| 7 | Schema evolution (Table Rebuild) | D4 |
| 8 | Unique constraints | D1 |
| 9 | Multi-relation | D2 |
| 10 | Cascade delete | D3 |
| 11 | Import/Export JSON | M16c |
| 12 | Backup manual (VACUUM INTO) | B2 |
| 13 | Multi-tenancy (1 project = 1 file SQLite) | M00 |
| 14 | **Vector search (cosine/L2, pre-filter)** | **M29** |
| 15 | Email + password (scrypt) | M08 |
| 16 | JWT + refresh token + revoke | M09 |
| 17 | **OAuth2 ×7** (Google, GitHub, Microsoft, Discord, GitLab, Facebook; Apple stub) | **M10+M31** |
| 18 | Account linking anti-takeover | M10 |
| 19 | **Email verification** | **M23** |
| 20 | **Password reset (revoke semua sesi)** | **M23** |
| 21 | **MFA/TOTP (RFC 6238, divalidasi vektor resmi)** | **M27** |
| 22 | Recovery codes (10, sekali pakai) | M27 |
| 23 | Admin MFA reset | M27 |
| 24 | Row-Level Security (API Rules AST) | M11 |
| 25 | Rate limiting (Redis+Lua / memory) | M18d |
| 26 | **API Keys per project (read/write scope)** | **M26** |
| 27 | SMTP email (nodemailer + dashboard config) | M23 |
| 28 | **Dev Outbox (tanpa SMTP)** | **M23** |
| 29 | Functions (isolated-vm, V8 isolate) | M15a/M18a |
| 30 | DB triggers (CRUD events) | M15b |
| 31 | Cron scheduler | M15c |
| 32 | **`$http.send` (network terkurati, SSRF guard)** | **M25** |
| 33 | Storage lokal + thumbnail (Sharp) | M14 |
| 34 | **S3/R2 backend (SigV4 zero-dep, path-style)** | **M30** |
| 35 | Realtime SSE per-collection + filter per-subscription | M13 |
| 36 | **Usage metrics (req+bandwidth, 14 hari)** | **M24** |
| 37 | **Webhooks (HMAC + retry + delivery log)** | **M28** |
| 38 | **CLI (login/projects/records/functions/users/webhooks)** | **M28** |
| 39 | **Scheduled backup + retensi otomatis** | **M32** |
| 40 | **Monitoring/alerting (threshold rules + webhook notifikasi)** | **M33** |
| 41 | SDK TypeScript + Docs viewer in-product | M00/M24 |
| 42 | Query lintas collection — join dinamis + N+1 solver | M12 |
| 43 | **`$db` binding in-process untuk functions** (opt-in, anti-rekursi, budget 200 panggilan) | **M41** |
| 44 | **Secrets per function** (`$env`, AES-256-GCM at-rest, nilai tak pernah keluar API) | **M42** |
| 45 | **Shared modules** (`$lib`, factory CJS, TS di-strip) | **M43** |
| 46 | **Function limits per-function** (memory 16–256 MB, timeout ≤120 s) | **M44** |
| 47 | **Riwayat eksekusi function + log persisten** | **M46** |
| 48 | **Halaman admin Auth Users** | **M47** |
| 49 | **Batch create transaksional untuk end user** (rules per record) | **Ops-2** |
| 50 | **Realtime: bulk sync + topik per-record + auth SSE late-binding + fail-safe delete** | **Ops-6** |
| 51 | **Satu auth surface** (`/auth/refresh` mengembalikan `user`; auth-collection login dihapus) | **Ops-9…13** |
| 52 | **Disable akun ditegakkan** (gerbang tunggal `issueTokens`, revoke sesi, 403 tanpa oracle) | **Ops-15** |
| 53 | **Custom profile field tervalidasi** (kolom SQL, `required` saat register, `userEditable`) | **Ops-16** |

### ❌ 15 gap → 🗺️ Roadmap M59–M73 (milestone ke depan)

> 15 gap yang tersisa dipetakan menjadi milestone lanjutan dengan konvensi repo (satu milestone per pass). Urutan di bawah adalah **usulan prioritas** — quick wins dulu (pola lama tinggal dipakai ulang), proyek besar belakangan. Tiap milestone standalone dan urutannya bebas diacak. Menutup 15/15 → cakupan peta kompetitif 62/62 (100%).
>
> **Renumber total (2026-09-20):** nomor roadmap lama M40, M42, M43, M44, M45, M47, M48, M49 **BENTROK** dengan milestone yang sudah terkirim (M41 `$db`, M42 `$env`, M43 `$lib`, M44 limits, M46 logs, M47 Auth Users). Agar tidak ada dua hal bernama sama, seluruh roadmap **direnumber ke M59–M73** (dimulai setelah M58 OIDC yang sudah ditetapkan). Dua gap **tertutup** sejak revisi sebelumnya: *riwayat eksekusi function* (M46) dan *custom profile field* (Ops-16 — sebelumnya tidak dipetakan sebagai gap, kini dihitung sebagai fitur ke-62). Setiap gap di bawah diverifikasi ulang `grep -rilE` di `server/src/` pada `1e386f3` → 0 file untuk `impersonat|presign|_audit|graphql|websocket|listSessions|otp|sms`; `magic`/`anonymous`/`csv` hanya muncul di komentar, bukan fitur.
>
> **Catatan penomoran (2026-09-18):** nomor **M41 dipakai oleh milestone terkirim `$db` binding** (akses database in-process untuk functions — bukan bagian peta 60-gap, melainkan prasyarat migrasi WekanzDashboard). Entry roadmap "Generic OAuth2/OIDC provider" yang semula M41 **dipindah ke M58**. Milestone number adalah namespace BERSAMA antara roadmap dan gelombang terkirim; saat gelombang memakai nomor yang roadmap reserve, roadmap-lah yang direnumber di pass yang sama.
>
> **Catatan penomoran (2026-09-17):** nomor **M34–M39 tidak dipakai di roadmap ini** — sudah terpakai dan **tuntas** untuk gelombang audit kesiapan backend WekanzDashboard (M34 Custom Document ID, M35 Bucket Storage, M36 SSE Auto-Reconnect, M37 401 Auto-Refresh, M38 Delete Event Full Payload, M39 Cron Timezone IANA — 6 fitur kesiapan-klien di luar peta 60-gap yang membuat BaseForge siap drop-in untuk aplikasi Appwrite-style). Roadmap kompetitif dilanjutkan dari M40. Ke-18 gap di bawah masih terbuka — tidak ada yang tertutup oleh gelombang audit tersebut.

**Tahap 1 — Quick wins paritas Auth** (menutup 3 gap 🔴 + 2 gap 🟡, effort kecil):

| Milestone | Judul | Dimiliki oleh | Prioritas | Effort | Reuse pola |
|---|---|---|---|---|---|
| **M59** | Magic link / passwordless login | PB, SB, AW | 🔴 Tinggi | Kecil | Token aksi sekali-pakai (M23) + mailer/Dev Outbox |
| **M58** | Generic OAuth2/OIDC provider (Keycloak, Authentik — URL custom) | PB, SB | 🔴 Tinggi | Kecil | Satu entry `OAUTH_PROVIDER_DEFS` (pola M31) |
| **M60** | Apple Sign-In penuh (ES256 JWT client secret dari private key) | PB, SB, AW | 🔴 Tinggi | Menengah | Entry generic M58 + signing ES256 via `node:crypto` — stub-nya di `oauth.ts:145` |
| **M61** | Anonymous auth (record guest → merge saat signup) | PB, SB, AW | 🟡 Menengah | Kecil | `_auth_users` + JWT (M09) + custom field Ops-16 utk flag `is_anonymous` |
| **M62** | Impersonate user + daftar sesi per-user (revoke individual) | PB, AW | 🟡 Menengah | Kecil | `_auth_tokens` (M09) + `revokeAllUserTokens` (Ops-15) + user-admin routes |

**Tahap 2 — Paritas inti menengah:**

| Milestone | Judul | Dimiliki oleh | Prioritas | Effort | Reuse pola |
|---|---|---|---|---|---|
| **M63** | File token / signed URL expiring + presigned direct-upload S3 | PB, SB, AW | 🟡 Menengah | Menengah | SigV4 (M30) + token kedaluwarsa (M23) |
| **M64** | Audit log platform (siapa/apa/kapan) | SB, AW | 🟢 Opsional | Kecil | Instrumentasi router (M24) / trigger (M15b) |
| **M65** | Import CSV | PB, SB | 🟢 Rendah | Kecil | `collectionJson` (M16c) |
| **M66** | Batch **mixed-op** (create+update+delete dalam satu request) | SB | 🟢 Opsional | Menengah | Perluas batch create Ops-2 (transaksi + reqCtx sudah ada) |

**Tahap 3 — Ops & DX:**

| Milestone | Judul | Dimiliki oleh | Prioritas | Effort | Reuse pola |
|---|---|---|---|---|---|
| **M67** | Migrasi framework file-based (schema → file di VCS + replay) | PB, SB | 🟢 Opsional | Menengah | Schema-as-data (M03): dump → replay |
| **M68** | Auto HTTPS — ACME bawaan atau standarisasi Caddy | PB | 🟢 Opsional | Menengah | Docs deployment + pola systemd user service |
| **M69** | **SDK mobile Kotlin** (ExploreMaps hari ini hand-write `fetch` ke REST) | PB, SB, AW | 🟡 **Menengah — dampak tertinggi untuk Wekanz** | Menengah per SDK | REST reference (`docs/api-reference.md`) + kontrak `packages/client` |
| **M70** | Phone/SMS OTP (Twilio) | AW | 🟢 Niche | Kecil | `$http.send` (M25) + token (M23) |

**Tahap 4 — Proyek besar / strategis:**

| Milestone | Judul | Dimiliki oleh | Prioritas | Effort | Reuse pola |
|---|---|---|---|---|---|
| **M71** | Push notification (FCM/APNs) | AW | 🟢 Niche | Besar | Baru — protokol FCM/APNs |
| **M72** | Presence + WebSocket dua arah | SB, AW | 🟢 Opsional | Besar | Upgrade SSE hub (M13) ke WS |
| **M73** | Multi-node / replikasi HA (ala LiteFS) | PB, SB | 🟡 Menengah | Besar | Baru — layer replikasi SQLite |
| **M57** | GraphQL API | SB, AW | 🟡 Menengah | Besar | Query AST (M04) sebagai fondasi resolver |

> **Catatan urutan:** M58 → M60 berurutan paling efisien — setelah entry generic OIDC ada, Apple tinggal generator ES256. M59 berdiri sendiri. M63 menggabungkan dua fondasi yang sudah ada (SigV4 M30 + expiring token M23). M69 (SDK Kotlin) bukan gap "paritas" biasa — ia satu-satunya gap yang **setiap hari** menggigit aplikasi Wekanz sendiri.

---

## 🐳 4. Realita Operasional Self-Hosting

```
+---------------------------------------------------------------------------+
| JEJAK DEPLOY (idle)                                                       |
+---------------------------------------------------------------------------+
| PocketBase    : [ 1 binary Go ]                                    ~40 MB |
| BaseForge     : [ node server ] + [ next dashboard ]  ~105 MB Linux prod  |
| Appwrite 2.0  : ~15+ container + ClickHouse (executions)     ~2.5–3 GB    |
| Supabase      : ~12 container (Envoy + PG17 + GoTrue + …)    ~3.5–4.5 GB  |
+---------------------------------------------------------------------------+
```

Catatan tren pesaing 2026 (semua makin BERAT, bukan makin ringan):
- **Supabase** mengganti gateway Kong → Envoy, Postgres 15 → 17, dan menambah RustFS sebagai backend storage S3-compatible opsional. Log/Analytics kini opt-in.
- **Appwrite 2.0** (self-hosted sejak 7 Sep 2026; sebelumnya 1.9.5 Jun 2026) mengganti engine total: PostgreSQL jadi default (MariaDB & MongoDB tetap opsi di wizard), executions pindah ke **ClickHouse**, Console IV dibangun ulang. VectorsDB & DocumentsDB self-host **ship OFF** dan butuh engine DB ekstra. **Catatan untuk Wekanz:** produksi WekanzDashboard sudah dimigrasikan dari Appwrite 1.6.2 ke BaseForge (2026-09-18); Appwrite tidak lagi berjalan di tencentvps1.
- **PocketBase** tetap 1 binary SQLite — arah evolusinya konsisten ringan; kini juga punya cloud hosting resmi.

---

## 🎯 5. Panduan Keputusan (Update Ops-16, 2026-09-20)

```
Butuh Postgres murni / 20+ OAuth / SAML / Presence realtime / pgvector skala besar?
  → SUPABASE
Butuh mobile-first: Push (FCM/APNS), SMS OTP, functions multi-bahasa, Sites?
  → APPWRITE
Mau binary tunggal paling ringan + 17 OAuth + auto-HTTPS + LiteFS, siap produksi hari ini?
  → POCKETBASE
Mau BaaS lengkap (MFA + vector + webhooks + CLI + metrics + monitoring + S3 + $http
  + API keys + functions dgn $db/$env/$lib + custom profile field tervalidasi)
  dalam 1 proses Node ~105 MB, 6 dependency, kode TypeScript yang bisa dibaca 100%,
  dan 656 test integrasi HTTP yang bisa dijalankan siapa pun?
  → BASEFORGE
```

### Posisi Kompetitif Setelah Ops-16

**BaseForge adalah satu-satunya BaaS ringan (< 200 MB, tanpa Docker) yang punya SEMUA ini aktif out-of-the-box:**
- ✅ Vector search (PocketBase ❌; Appwrite VectorsDB self-host OFF by default & butuh engine ekstra; Supabase ✅ tapi stack 3–4.5 GB)
- ✅ Monitoring/alerting bawaan dengan notifikasi webhook
- ✅ Webhooks outbound dengan HMAC signature + retry + delivery log
- ✅ Usage metrics per project
- ✅ S3/R2 backend dengan ZERO dependency baru (SigV4 via node:crypto)
- ✅ `$http.send` terkurasi (allowlist + SSRF guard — tidak dimiliki siapa pun)
- ✅ Dev email outbox
- ✅ Per-project API keys + MFA/TOTP
- ✅ Custom profile field yang **tervalidasi tipe + kolom SQL + pemisahan user/admin-editable** — Supabase & Appwrite hanya JSON bebas, PocketBase punya kolom tapi tanpa pemisahan hak (Ops-16)
- ✅ Functions dengan `$db` in-process **dan** trigger yang membawa before-state — Appwrite tidak punya keduanya (akar bug duplicate-spawn WekanzDashboard dulu)

**Yang TIDAK boleh dibaca dari daftar di atas:** "lebih banyak ✅" ≠ "lebih matang". PocketBase dipakai ribuan proyek dan diaudit komunitas; Supabase/Appwrite punya tim keamanan penuh waktu. BaseForge dijaga 656 test yang ditulis oleh tim yang sama yang menulis kodenya — itu kuat untuk skala Wekanz (3 aplikasi, 1 VPS), tapi bukan pengganti audit eksternal. Bug Ops-15 (`disabled` tidak ditegakkan selama berbulan-bulan) adalah bukti bahwa ✅ di tabel bisa menyembunyikan lubang sampai seseorang benar-benar mengujinya secara adversarial.

**PocketBase masih unggul di:** binary tunggal 40 MB, 17 OAuth, auto-HTTPS Let's Encrypt bawaan, LiteFS multi-instance, migrasi framework file-based, SDK Go/Dart, impersonate + session list.

**Supabase masih unggul di:** Postgres 17 murni, pgvector native C (skala 100K+ vectors), 20+ OAuth, SAML SSO, kunci asimetris `sb_`, GraphQL, Presence/Broadcast, WebSocket, SDK multi-bahasa, read replica.

**Appwrite masih unggul di:** Messaging (email/SMS/push via provider), 13+ runtime functions (termasuk Rust), Sites (hosting statis), VectorsDB dengan embedding model bawaan (di Cloud), Presences, Teams/roles, 30+ OAuth.

**Cakupan fitur BaseForge: 47 dari 62 fitur kompetitif yang dipetakan (76%)** *(peta 62 = fitur yang dimiliki ≥ 1 pesaing dan relevan untuk BaaS self-hosted; matriks §2 memuat 106 baris termasuk fitur yang hanya BaseForge punya dan detail sub-fitur, jadi jangan membagi ✅ di §2 langsung)* — dari 43/60 (72%) versi M39. Peta diperluas jadi 62 karena dua fitur baru ikut dihitung (*custom profile field tervalidasi* dan *pemisahan user/admin-editable field*), dan 4 gap lama ditutup sejak revisi itu: riwayat eksekusi function (M46), topik realtime per-record (Ops-6), batch create transaksional (Ops-2), serta penegakan disable + custom field (Ops-15/16).

Menyelesaikan Tahap 1 roadmap (M58 → M60, M59, M61, M62) menutup 5 gap prioritas-tinggi → **52/62 (84%)**; seluruh M57–M73 tuntas → **62/62 (100%)**.

**Batas dari angka ini — baca sebelum mengutipnya.** Persentase menghitung *keberadaan* fitur pada peta yang kami susun sendiri, bukan kedalaman, skala, atau kematangannya. Contoh konkret di dokumen ini: vector search BaseForge (brute-force, wajar < 50K vektor) dan pgvector Supabase (HNSW, native C, jutaan vektor) sama-sama dihitung "✅ 1 fitur". Begitu pula "OAuth ✅" untuk 7 provider vs 30 provider. Peta ini berguna untuk memutuskan *milestone berikutnya*, bukan untuk mengklaim BaseForge "76% sebaik Supabase".

---

## 🔬 6. Metode Verifikasi

Semua klaim BaseForge di dokumen ini diverifikasi ulang pada commit **`1e386f3`** (2026-09-20).

| Klaim | Cara diverifikasi | Hasil |
|---|---|---|
| Test suite hijau | `npm test` penuh dijalankan ulang pada kode final | **656 pass / 0 fail** (74 file test) |
| 137 route HTTP | `grep -rhoE "router\.(get\|post\|patch\|put\|delete)\('" src/api/*.ts \| wc -l` | 137 |
| 6 dependency produksi | `node -e` pada `server/package.json` | `@fastify/busboy`, `ioredis`, `isolated-vm`, `jose`, `nodemailer`, `sharp` |
| RAM idle ~105 MB | proses produksi hidup di tencentvps1 (3 project aktif) | ~105 MB; ~181 MB di Windows dev (`tsx`, bukan angka produksi) |
| OAuth ×7, Apple masih stub | `grep` `OAUTH_PROVIDER_DEFS` + baca `oauth.ts:145` | 6 penuh; Apple melempar *"requires an ES256-signed client_secret JWT (not yet supported)"* → **stub, bukan fitur** |
| Ops-15 `disabled` ditegakkan | HTTP nyata ke **produksi** setelah deploy | `disable → 200 {revokedSessions:3}`; login → `403 USER_DISABLED`; password salah → `401 INVALID_CREDENTIALS` (bukan oracle) |
| Ops-16 custom field | HTTP nyata ke produksi + DOM dashboard | define → 201; register+profile → 201; user ubah field admin-only → `403 FIELD_NOT_EDITABLE`, state tidak berubah |
| Ops-16 tidak merusak klien lama | bandingkan **daftar kunci** respons auth di produksi | `[avatarUrl, created, email, id, mfaEnabled, name, verified]` — identik dengan pra-Ops-16, `profile` absen saat tak ada field |
| Vector brute-force + batasnya | Komentar desain `server/src/core/vectorSearch.ts` | scan penuh, OK < 50K vectors × 1536 dims (~50–200 ms) |
| Gap impersonate / signed URL / audit log / GraphQL / WebSocket / session-list / SMS | `grep -rilE` di `server/src/` | **0 file** → gap asli |
| Gap magic link / anonymous / CSV | `grep -rniE` lalu baca hasilnya | hanya muncul di **komentar kode**, bukan implementasi → gap asli |
| Batch Ops-2 = create-many, bukan mixed-op | baca `publicRoutes.ts:372-389` | body `{ records: [...] }` saja; tidak ada field operasi → mixed-op tetap gap |
| Versi pesaing | GitHub releases & changelog resmi (20 Sep 2026) | PocketBase **v0.39.11** stable (v0.40 pre-release) · Supabase docker 0.7.1 · Appwrite **2.0** self-hosted (7 Sep 2026; 1.9.5 = rilis Jun 2026) |

**Yang TIDAK diverifikasi:** kolom PocketBase/Supabase/Appwrite berasal dari dokumentasi & changelog resmi mereka — tidak ada satu pun dari ketiganya yang dijalankan dan diuji ulang untuk dokumen ini. Angka RAM pesaing adalah rentang yang dilaporkan komunitas/dokumentasi, bukan pengukuran kami.

---

*Diperbarui pada commit `1e386f3` (Ops-16) — 656 automated tests hijau (dijalankan ulang 2026-09-20). Sumber fitur pesaing: GitHub releases PocketBase (v0.39.11 stable), supabase/docker CHANGELOG (0.7.1, Postgres 17 + Envoy + RustFS), dan changelog resmi Appwrite (2.0 self-hosted, 2026-09-07). Angka cakupan §5 dihitung dari kolom "Status BF" pada matriks §2 — bila matriks berubah, hitung ulang; jangan edit angkanya lepas dari tabelnya.*
