# 🥊 Perbandingan Komprehensif BaaS Open-Source: BaseForge vs PocketBase vs Supabase vs Appwrite

> Analisis teknis, perbandingan fitur per modul, dan evaluasi operasional *self-hosted* — diperbarui setelah BaseForge menyelesaikan **M00–M39** (gelombang terbaru: M39 Cron Timezone IANA, M38 Delete Event Full Payload, M37 SDK 401 Auto-Refresh, M36 SSE Auto-Reconnect, M35 Bucket Storage, M34 Custom Document ID — enam gap audit kesiapan sebagai backend WekanzDashboard; sebelumnya M33 Monitoring, M32 Backup, M31 OAuth ×7, M30 S3, M29 Vector, M28 Webhooks+CLI, M27 MFA, M26 API Keys, M25 $http, M24 Metrics, M23 Email).
>
> **Angka terverifikasi 2026-09-17:** `npm test` = **502/502 tests hijau** (27 suite, 57 file test, 84 detik); RAM idle server diukur langsung dari proses yang berjalan = **~181 MB working set** (node.exe, mode dev `tsx`). Pesaing dibandingkan pada **versi open-source / self-hosted terbaru**: PocketBase **v0.40.1** (Aug 2026), Supabase self-hosted **0.7.1** (Aug 2026, Postgres 17 + Envoy), Appwrite **2.2.0** (engine generasi-2, PostgreSQL default + ClickHouse).

---

## 📌 1. Ringkasan Eksekutif

| Karakteristik | WekanzBaseForge | PocketBase | Supabase (Self-Hosted) | Appwrite (Self-Hosted) |
|---|---|---|---|---|
| **Bahasa / Bentuk** | TypeScript · 1 proses Node.js | Go · **1 binary tunggal** | Microservices (~12 container) | Microservices (~15+ container, kini **+ ClickHouse**) |
| **Database** | SQLite multi-file (1 project = 1 file) | SQLite tunggal | **PostgreSQL 17** (default sejak Jun 2026) | **PostgreSQL default** (sejak 2.0; MariaDB & MongoDB didukung) |
| **RAM Idle** | **~181 MB** (terukur) | **~30–80 MB** 🔥 | ~3–4.5 GB | ~2.5–3 GB (+ ClickHouse) |
| **VPS Min.** | 512 MB ($3/bln) | 256 MB ($2/bln) | 4–8 GB ($20–40/bln) | 4 GB ($15–25/bln) |
| **Konsol Admin** | Next.js terpisah (docs viewer, metrics, monitoring) | Admin UI **ter-embed** di binary | Studio (container tersendiri) | Console 2.0 (rebuild total) |
| **Fondasi Auth** | Password + **6 OAuth penuh + 1 stub** (Google, GitHub, Microsoft, Discord, GitLab, Facebook; Apple stub) + MFA/TOTP + email verify/reset + API keys | Password + **17 OAuth** + MFA/OTP + verify/reset + impersonate | Password + 20+ OAuth + MFA + SAML SSO + kunci `sb_` asimetris | Password + 30+ OAuth + MFA + SMS OTP + impersonate |
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
| Batch API transaksional (mixed-op) | ❌ | ❌ | ✅ | ❌ | **❌** |
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
| Memory limit per isolate | ✅ 32MB | ❌ | ✅ | ✅ | **✅** |
| DB triggers (CRUD events) | ✅ | ✅ | ✅ | ✅ | **✅** |
| Cron scheduler (5-field) | ✅ | ✅ | ✅ | ✅ | **✅** |
| **`$http` network access (terkurasi)** | ✅ M25 | ✅ | ✅ | ✅ | **✅** |
| Allowlist host (security) | ✅ M25 | ❌ | ❌ | ❌ | **✅** |
| SSRF guard (anti metadata) | ✅ M25 | ❌ | ❌ | ❌ | **✅** |
| **Multi-bahasa** (Python, Go, Rust…) | ❌ | ❌ | ⚠️ | ✅ (Rust sejak 1.9) | **❌** |
| npm packages dalam function | ❌ | ❌ | ✅ | ✅ | **❌** |
| Riwayat eksekusi + log persisten | ❌ | ⚠️ (app logs) | ✅ | ✅ (di **ClickHouse** sejak 2.2) | **❌** |

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
| Subscribe topik 1 record (`col/id`) | ⚠️ (via filter `id='…'`) | ✅ | ✅ | ✅ | **⚠️** |

### G. Observability & Developer Experience

| Fitur | BaseForge | PocketBase | Supabase | Appwrite | Status BF |
|---|---|---|---|---|---|
| **Usage metrics per project** (req+bandwidth, 14 hari) | ✅ M24 | ❌ | ⚠️ | ❌ | **✅ 🔥** |
| **Monitoring/alerting + notifikasi webhook** (threshold, firing/resolved) | ✅ M33 | ❌ | ⚠️ (via Loki) | ⚠️ | **✅ 🔥** |
| **Docs viewer in-product** (`/docs`) | ✅ | ❌ | ❌ | ❌ | **✅ 🔥** |
| **CLI** (login/projects/records/functions/users/webhooks) | ✅ M28 | ✅ | ✅ | ✅ | **✅** |
| SDK TypeScript (zero-dep) | ✅ | ✅ | ✅ | ✅ | **✅** |
| SDK mobile (Flutter/Swift/Kotlin) | ❌ | ✅ | ✅ | ✅ | **❌** |
| Test suite | **464 test** (terverifikasi 2026-09-17) | mature | besar | besar | **✅** |
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
| Migrasi framework (file-based, VCS) | ❌ | ✅ | ✅ | ✅ | **❌** |
| Soft delete + trash bin | ❌ | ❌ | ✅ | ❌ | **❌** |

---

## 📊 3. Scorecard — Fitur yang SUDAH vs BELUM

### ✅ BaseForge SUDAH PUNYA (42 fitur inti)

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

### ❌ 18 gap → 🗺️ Roadmap M40–M57 (milestone ke depan)

> 18 gap yang tersisa dipetakan menjadi milestone lanjutan dengan konvensi repo (satu milestone per pass, dikerjakan dengan `lanjut M##`). Urutan di bawah adalah **usulan prioritas** — quick wins dulu (pola lama tinggal dipakai ulang), proyek besar belakangan. Tiap milestone standalone dan urutannya bebas diacak. Menutup 18/18 → cakupan peta kompetitif 60/60 (100%).
>
> **Catatan penomoran (2026-09-17):** nomor **M34–M39 tidak dipakai di roadmap ini** — sudah terpakai dan **tuntas** untuk gelombang audit kesiapan backend WekanzDashboard (M34 Custom Document ID, M35 Bucket Storage, M36 SSE Auto-Reconnect, M37 401 Auto-Refresh, M38 Delete Event Full Payload, M39 Cron Timezone IANA — 6 fitur kesiapan-klien di luar peta 60-gap yang membuat BaseForge siap drop-in untuk aplikasi Appwrite-style). Roadmap kompetitif dilanjutkan dari M40. Ke-18 gap di bawah masih terbuka — tidak ada yang tertutup oleh gelombang audit tersebut.

**Tahap 1 — Quick wins paritas Auth** (menutup 3 gap 🔴 + 2 gap 🟡, effort kecil):

| Milestone | Judul | Dimiliki oleh | Prioritas | Effort | Reuse pola |
|---|---|---|---|---|---|
| **M40** | Magic link / passwordless login | PB, SB, AW | 🔴 Tinggi | Kecil | Token aksi sekali-pakai (M23) + mailer/Dev Outbox |
| **M41** | Generic OAuth2/OIDC provider (Keycloak, Authentik — URL custom) | PB, SB | 🔴 Tinggi | Kecil | Satu entry `OAUTH_PROVIDER_DEFS` (pola M31) |
| **M42** | Apple Sign-In penuh (ES256 JWT client secret dari private key) | PB, SB, AW | 🔴 Tinggi | Menengah | Entry generic M41 + signing ES256 via `node:crypto` |
| **M43** | Anonymous auth (record guest → merge saat signup) | PB, SB, AW | 🟡 Menengah | Kecil | Auth collection + JWT (M09) |
| **M44** | Impersonate user + daftar sesi per-user (revoke individual) | PB, AW | 🟡 Menengah | Kecil | Tabel `_auth_tokens` (M09) + user-admin routes |

**Tahap 2 — Paritas inti menengah:**

| Milestone | Judul | Dimiliki oleh | Prioritas | Effort | Reuse pola |
|---|---|---|---|---|---|
| **M45** | File token / signed URL expiring + presigned direct-upload S3 | PB, SB, AW | 🟡 Menengah | Menengah | SigV4 (M30) + token kedaluwarsa (M23) |
| **M46** | Riwayat eksekusi function + log persisten | SB, AW | 🟡 Menengah | Menengah | Gate `runFunctionCode` (M18a) + tabel per-project |
| **M47** | Audit log platform (siapa/apa/kapan) | SB, AW | 🟢 Opsional | Kecil | Instrumentasi router (M24) / trigger (M15b) |
| **M48** | Import CSV | PB, SB | 🟢 Rendah | Kecil | `collectionJson` (M16c) |
| **M49** | Batch API transaksional (mixed-op dalam satu request) | SB | 🟢 Opsional | Menengah | Transaksi ACID (M07) |

**Tahap 3 — Ops & DX:**

| Milestone | Judul | Dimiliki oleh | Prioritas | Effort | Reuse pola |
|---|---|---|---|---|---|
| **M50** | Migrasi framework file-based (schema → file di VCS + replay) | PB, SB | 🟢 Opsional | Menengah | Schema-as-data (M03): dump → replay |
| **M51** | Auto HTTPS — ACME bawaan atau standarisasi Caddy | PB | 🟢 Opsional | Menengah | Docs deployment + pola systemd user service |
| **M52** | SDK mobile (mulai satu: Flutter atau Kotlin) | PB, SB, AW | 🟡 Menengah | Menengah per SDK | REST reference (`docs/api-reference.md`) |
| **M53** | Phone/SMS OTP (Twilio) | AW | 🟢 Niche | Kecil | `$http.send` (M25) + token (M23) |

**Tahap 4 — Proyek besar / strategis:**

| Milestone | Judul | Dimiliki oleh | Prioritas | Effort | Reuse pola |
|---|---|---|---|---|---|
| **M54** | Push notification (FCM/APNs) | AW | 🟢 Niche | Besar | Baru — protokol FCM/APNs |
| **M55** | Presence + WebSocket dua arah | SB, AW | 🟢 Opsional | Besar | Upgrade SSE hub (M13) ke WS |
| **M56** | Multi-node / replikasi HA (ala LiteFS) | PB, SB | 🟡 Menengah | Besar | Baru — layer replikasi SQLite |
| **M57** | GraphQL API | SB, AW | 🟡 Menengah | Besar | Query AST (M04) sebagai fondasi resolver |

> **Catatan urutan:** M41 → M42 berurutan paling efisien — setelah entry generic OIDC ada, Apple tinggal generator ES256. M40 berdiri sendiri. M45 menggabungkan dua fondasi yang sudah ada (SigV4 M30 + expiring token M23).

---

## 🐳 4. Realita Operasional Self-Hosting

```
+---------------------------------------------------------------------------+
| JEJAK DEPLOY (idle)                                                       |
+---------------------------------------------------------------------------+
| PocketBase    : [ 1 binary Go ]                                    ~40 MB |
| BaseForge     : [ node server ] + [ next dashboard ]      ~181 MB (terukur)|
| Appwrite 2.2  : ~15+ container + ClickHouse (executions)     ~2.5–3 GB    |
| Supabase      : ~12 container (Envoy + PG17 + GoTrue + …)    ~3.5–4.5 GB  |
+---------------------------------------------------------------------------+
```

Catatan tren pesaing 2026 (semua makin BERAT, bukan makin ringan):
- **Supabase** mengganti gateway Kong → Envoy, Postgres 15 → 17, dan menambah RustFS sebagai backend storage S3-compatible opsional. Log/Analytics kini opt-in.
- **Appwrite 2.0** mengganti engine total: PostgreSQL jadi default (dari MariaDB), executions wajib pindah ke **ClickHouse** (2.2), Console dibangun ulang. VectorsDB & DocumentsDB self-host **ship OFF** dan butuh engine DB ekstra.
- **PocketBase** tetap 1 binary SQLite — arah evolusinya konsisten ringan; kini juga punya cloud hosting resmi.

---

## 🎯 5. Panduan Keputusan (Update M33)

```
Butuh Postgres murni / 20+ OAuth / SAML / Presence realtime / pgvector skala besar?
  → SUPABASE
Butuh mobile-first: Push (FCM/APNS), SMS OTP, functions multi-bahasa, Sites?
  → APPWRITE
Mau binary tunggal paling ringan + 17 OAuth + auto-HTTPS + LiteFS, siap produksi hari ini?
  → POCKETBASE
Mau BaaS lengkap (MFA + vector + webhooks + CLI + metrics + monitoring + S3 + $http
  + API keys) dalam 1 proses Node < 200 MB, dengan kode TypeScript yang bisa dibaca 100%?
  → BASEFORGE
```

### Posisi Kompetitif Setelah M33

**BaseForge adalah satu-satunya BaaS ringan (< 200 MB, tanpa Docker) yang punya SEMUA ini aktif out-of-the-box:**
- ✅ Vector search (PocketBase ❌; Appwrite VectorsDB self-host OFF by default & butuh engine ekstra; Supabase ✅ tapi stack 3–4.5 GB)
- ✅ Monitoring/alerting bawaan dengan notifikasi webhook
- ✅ Webhooks outbound dengan HMAC signature + retry + delivery log
- ✅ Usage metrics per project
- ✅ S3/R2 backend dengan ZERO dependency baru (SigV4 via node:crypto)
- ✅ `$http.send` terkurasi (allowlist + SSRF guard — tidak dimiliki siapa pun)
- ✅ Dev email outbox
- ✅ Per-project API keys + MFA/TOTP

**PocketBase masih unggul di:** binary tunggal 40 MB, 17 OAuth, auto-HTTPS Let's Encrypt bawaan, LiteFS multi-instance, migrasi framework file-based, SDK Go/Dart, impersonate + session list.

**Supabase masih unggul di:** Postgres 17 murni, pgvector native C (skala 100K+ vectors), 20+ OAuth, SAML SSO, kunci asimetris `sb_`, GraphQL, Presence/Broadcast, WebSocket, SDK multi-bahasa, read replica.

**Appwrite masih unggul di:** Messaging (email/SMS/push via provider), 13+ runtime functions (termasuk Rust), Sites (hosting statis), VectorsDB dengan embedding model bawaan (di Cloud), Presences, Teams/roles, 30+ OAuth.

**Cakupan fitur BaseForge: 42 dari 60 fitur kompetitif yang dipetakan (70%)** — dari 38/53 (72%) versi M29. Persentase turun sedikit karena peta fitur diperluas (schemaless DB, email policies, chunked upload, presence, monitoring pesaing ikut dihitung), bukan karena fitur berkurang: **+4 fitur inti baru (S3, backup terjadwal, monitoring, OAuth ×7) dalam M30–M33.** Di luar peta 60-gap, gelombang audit WekanzDashboard (M34–M39) menambah 6 fitur kesiapan-klien (custom document ID, bucket storage, SSE auto-reconnect, 401 auto-refresh, delete event full payload, cron timezone) — kategori "drop-in readiness" yang membuat aplikasi gaya Appwrite (client SDK + session + attachment) bisa berjalan tanpa rombak arsitektur. Menyelesaikan Tahap 1 roadmap (M40–M44) saja menutup 5 gap prioritas-tinggi → **47/60 (78%)**; seluruh M40–M57 tuntas → **60/60 (100%)**.

---

## 🔬 6. Metode Verifikasi

| Klaim | Cara diverifikasi | Hasil |
|---|---|---|
| Test suite hijau | `npm test` penuh dijalankan ulang | 464 pass / 0 fail / 27 suite / 94.2 s |
| RAM idle ~181 MB | `tasklist` pada proses server hidup (PID 41740, dev `tsx`) + `curl /api/health` | 185.560 KiB working set; health `{"status":"ok"}` |
| OAuth ×7 | `grep` `OAUTH_PROVIDER_DEFS` di `server/src/auth/oauth.ts` | google, github, microsoft, discord, gitlab, facebook, apple (stub) |
| Vector brute-force + batasnya | Komentar desain `server/src/core/vectorSearch.ts` | scan penuh, OK < 50K vectors × 1536 dims (~50–200 ms) |
| Gap impersonate / file token / magic link / anonymous / session-list | `grep -rin` di `server/src/` | tidak ditemukan → gap asli, bukan fitur tersembunyi |
| Realtime filter per-subscription | `server/src/api/realtimeRoutes.ts` + `realtime.ts` | subscribe multi-collection + filter M04 dievaluasi per record |
| Versi pesaing | GitHub releases & changelog resmi (17 Sep 2026) | PocketBase v0.40.1 · Supabase docker 0.7.1 · Appwrite 2.2.0 |

---

*Diperbarui setelah milestone M33 — 464 automated tests hijau (dijalankan ulang 2026-09-17). Sumber fitur pesaing: CHANGELOG resmi PocketBase (v0.40.1), supabase/docker CHANGELOG (0.7.1, Postgres 17 + Envoy + RustFS), dan GitHub releases Appwrite (2.2.0, PostgreSQL default + ClickHouse + VectorsDB opt-in).*
