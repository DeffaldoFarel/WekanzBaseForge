# 📡 REST API Reference

Dokumentasi ini berisi panduan lengkap endpoint HTTP BaseForge untuk digunakan oleh aplikasi klien (Frontend Web, Mobile Android/iOS, dsb).

---

## 🌐 Struktur URL

### 🔑 API Keys (M26) — Server-to-Server Access

Per-project API keys untuk akses backend/cron/integrasi **tanpa login end-user**.
Buat dari dashboard (project overview → **API Keys**) atau admin API.

* **Header:** `Authorization: Bearer bf_...` **atau** `X-API-Key: bf_...`
* **Scope:**
  * `read` — GET endpoints saja (list/view records, aggregate, files)
  * `write` — semua method (records CRUD, file upload)
* **Perilaku:** key **melewati (bypass) API Rules** — service-level access
  seperti `service_role` Supabase. Rate limit terpisah: 300 req/menit per key.
* **Key penuh hanya muncul sekali** saat dibuat; yang tersimpan di DB hanya
  hash SHA-256.

```bash
# Buat (admin)
curl -X POST http://localhost:5100/api/admin/projects/:pid/api-keys \
  -H "Authorization: Bearer <adminToken>" \
  -d '{"name": "production-backend", "scope": "write"}'

# Pakai (end-user API — rules dilewati)
curl -H "Authorization: Bearer bf_xxx..." \
  http://localhost:5100/api/p/:pid/collections/posts/records
```

Admin endpoints: `GET .../api-keys` (list masked + usage),
`DELETE .../api-keys/:id` (revoke). Key **tidak berlaku** untuk flow
end-user (`/auth/*`, `auth-with-password`, `auth-refresh`).

---

> ⚠️ **Deprecated sejak 2026-09-19 (Tahap 3 konsolidasi auth).**
> Endpoint auth-collection (`POST /api/p/:pid/collections/:name/auth-with-password`,
> `auth-refresh`, `auth-logout`) masih berfungsi penuh selama satu rilis, tetapi
> setiap responsnya membawa header `Deprecation: true` dan pemanggilannya dicatat
> di log server. Gunakan platform auth sebagai gantinya:
>
> | Lama | Baru |
> |---|---|
> | `collections/:name/auth-with-password` | `POST /api/p/:pid/auth/login` |
> | `collections/:name/auth-refresh` | `POST /api/p/:pid/auth/refresh` |
> | `collections/:name/auth-logout` | `POST /api/p/:pid/auth/logout` |
>
> Token kedua surface interoperable (`issueTokens()` dan `_auth_tokens` yang sama),
> jadi API Rules `@request.auth.id` tidak perlu diubah saat berpindah.

---

Setiap project di BaseForge memiliki ID unik (`:pid`). Semua endpoint untuk aplikasi klien Anda berakar pada prefiks `/api/p/:pid`:

```text
http://localhost:5100/api/p/<PROJECT_ID>/...
```

*Contoh Project ID:* `q9tylwaruigffwr`

---

## 🔐 1. Authentication (End-User Auth)

BaseForge menyediakan sistem autentikasi lengkap berbasis **JWT (jose) + Persisted Refresh Tokens** dengan hashing kata sandi `scrypt`.

### A. Register User
Mendaftarkan akun baru untuk aplikasi Anda (otomatis login dan menghasilkan token):

* **Method:** `POST`
* **URL:** `/api/p/:pid/auth/register`
* **Headers:** `Content-Type: application/json`
* **Body:**
  ```json
  {
    "email": "budi@example.com",
    "password": "PasswordKuat123!",
    "name": "Budi Santoso"
  }
  ```
* **Response (201 Created):**
  ```json
  {
    "user": {
      "id": "7nd6z9x3wkbys22",
      "email": "budi@example.com",
      "name": "Budi Santoso",
      "verified": false,
      "created": "2026-09-12T16:56:24.312Z"
    },
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "7a8b9c...",
    "expiresIn": 900
  }
  ```

### B. Login User
Masuk dengan email dan kata sandi:

* **Method:** `POST`
* **URL:** `/api/p/:pid/auth/login`
* **Body:**
  ```json
  {
    "email": "budi@example.com",
    "password": "PasswordKuat123!"
  }
  ```
* **Response (200 OK):** Mengembalikan payload user dan token yang sama seperti register.
* *Keamanan:* Dilindungi rate limiter anti-brute force (maksimum 10 percobaan per menit).

### C. Refresh Token
Mendapatkan access token baru tanpa mengharuskan pengguna login ulang:

* **Method:** `POST`
* **URL:** `/api/p/:pid/auth/refresh`
* **Body:**
  ```json
  {
    "refreshToken": "7a8b9c..."
  }
  ```
* **Response (200 OK):**
  ```json
  {
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "refreshToken": "8b9c0d...",
    "expiresIn": 900
  }
  ```

### D. Get Current User Profile (`/me`)
Mendapatkan data pengguna yang sedang login dari bearer token:

* **Method:** `GET`
* **URL:** `/api/p/:pid/auth/me`
* **Headers:** `Authorization: Bearer <accessToken>`
* **Response (200 OK):**
  ```json
  {
    "user": {
      "id": "7nd6z9x3wkbys22",
      "email": "budi@example.com",
      "name": "Budi Santoso",
      "verified": false,
      "created": "2026-09-12T16:56:24.312Z"
    }
  }
  ```

### E. Update Own Profile (`PATCH /me`)
Mengubah field profil milik pengguna yang sedang login:

* **Method:** `PATCH`
* **URL:** `/api/p/:pid/auth/me`
* **Headers:** `Authorization: Bearer <accessToken>`
* **Body (semua field opsional):**
  ```json
  {
    "name": "Budi Santoso",
    "avatarUrl": "https://cdn.example.com/avatar.png"
  }
  ```
* **Semantik partial update:**
  * Field yang **tidak dikirim** → tidak tersentuh.
  * Field bernilai **`null`** → dikosongkan.
  * Body **`{}`** → no-op, tetap `200`.
* **Field yang DITOLAK (`400 BAD_REQUEST`):** `email`, `password`, `verified`,
  `disabled`, `id`. Masing-masing punya jalur terverifikasi sendiri dan tidak
  boleh diubah lewat endpoint ini.
* **Batas:** `name` maks 255 karakter, `avatarUrl` maks 2048 karakter.
* **Response (200 OK):** bentuk sama dengan `GET /me`.

### F. Logout (Revoke Token)
Mematikan refresh token agar tidak bisa digunakan kembali:

* **Method:** `POST`
* **URL:** `/api/p/:pid/auth/logout`
* **Headers:** `Authorization: Bearer <accessToken>`
* **Body:**
  ```json
  {
    "refreshToken": "7a8b9c..."
  }
  ```

### G. OAuth2 Login (Google & GitHub) — M10

Login sosial via **Authorization Code Flow**. Provider harus dikonfigurasi
admin lebih dulu di dashboard (**Project → Auth → Settings**) atau via
`PUT /api/admin/projects/:pid/auth/providers/:provider` (clientId, clientSecret).

#### Alur lengkap

```
Browser ── GET /api/p/:pid/auth/oauth/google/authorize?redirect_to=...
        ←─ 302 ke accounts.google.com (consent screen, state anti-CSRF)
Browser ── login & consent di Google
Google ── 302 ke /api/p/:pid/auth/oauth/google/callback?code=...&state=...
Server ── tukar code → access_token Google → fetch profil → find-or-create user
        ←─ 302 ke redirect_to#access_token=...&refresh_token=...
           (atau JSON bila authorize dipanggil tanpa redirect_to)
```

#### Endpoint 1 — Mulai Login

* **Method:** `GET`
* **URL:** `/api/p/:pid/auth/oauth/:provider/authorize`
* **Params:** `provider` = `google` | `github`
* **Query (opsional):**
  * `redirect_to` — URL aplikasi Anda (http/https). Setelah sukses, user
    diarahkan ke sini dengan token di **URL fragment**
    (`#access_token=…&refresh_token=…&expires_in=…`).
    Bila admin mengisi *allowed origins* di konfigurasi provider, hanya origin
    terdaftar yang diizinkan — URL lain diabaikan (fallback respons JSON).
* **Response:** `302` → consent screen provider
* **Error:** `404 PROVIDER_NOT_CONFIGURED` (belum diatur admin / disabled)

#### Endpoint 2 — Callback (dipanggil provider, bukan aplikasi Anda)

* **Method:** `GET`
* **URL:** `/api/p/:pid/auth/oauth/:provider/callback?code=…&state=…`
* **Response sukses (tanpa redirect_to):**
  ```json
  {
    "user": {
      "id": "a1b2c3...", "email": "user@gmail.com", "name": "Budi",
      "avatarUrl": "https://...", "verified": true, "created": "..."
    },
    "accessToken": "eyJ...", "refreshToken": "e4f5...", "expiresIn": 900
  }
  ```

#### SDK Client

```ts
import { BaseForge } from '@wekanz/baseforge';
const bf = new BaseForge({ baseUrl, projectId });

// 1. Redirect user ke login Google
bf.auth.loginWithOAuth('google', 'https://myapp.com/callback');

// 2. Di halaman /callback — parse token dari fragment
const result = await bf.auth.handleOAuthCallback();
if (result?.error) { /* tampilkan error */ }
// token tersimpan otomatis di authStore + user diambil via /me
```

#### Aturan Keamanan Built-in

| Mekanisme | Perilaku |
|---|---|
| **State anti-CSRF** | Random 64-hex, satu kali pakai, TTL 10 menit. Replay/mismatch → `400 BAD_STATE`. |
| **Account linking** | Email provider yang **terverifikasi** + cocok dengan user existing → identity di-link otomatis (user bisa login Google & password). |
| **Anti account-takeover** | Email cocok tetapi **belum terverifikasi provider** (mis. email GitHub unverified) → `409 EMAIL_UNVERIFIED_CONFLICT`. Linking ditolak. |
| **Client secret at-rest** | Disimpan terenkripsi AES-256-GCM (key: `OAUTH_SECRET` env → fallback `JWT_SECRET`). |
| **Token di fragment** | `#access_token` tidak dikirim ke server mana pun (tidak bocor di log akses), tidak di query string. |
| **Rate limit** | 30 request/menit per IP per provider untuk authorize & callback. |

### H. Email Verification & Password Reset (M23)

### I. MFA / Two-Factor Authentication (M27 — TOTP)

Dua faktor via app authenticator (Google Authenticator, Authy, 1Password —
format `otpauth://` standar) + 10 recovery codes sekali pakai.

#### 1. Enroll (login aktif)
* **`POST /api/p/:pid/auth/mfa/enroll`** · `Authorization: Bearer <accessToken>`
* Response: `{ secret, otpauthUrl }` — scan `otpauthUrl` dengan app authenticator.
* Enrollment *pending* — login masih normal sampai diverifikasi.

#### 2. Verify (konfirmasi + recovery codes)
* **`POST /api/p/:pid/auth/mfa/verify`** · Bearer · Body: `{ "token": "123456" }`
* Response: `{ mfaEnabled: true, recoveryCodes: ["..." × 10] }` — **disimpan sekali saja**.

#### 3. Login dengan MFA
* **`POST /api/p/:pid/auth/login`** → password benar = faktor-1 lolos, tapi token TIDAK terbit:
  ```json
  { "mfaRequired": true, "mfaToken": "..." }
  ```
* **`POST /api/p/:pid/auth/mfa/challenge`** · Body: `{ mfaToken, token }` atau `{ mfaToken, recoveryCode }`
* Sukses → `{ user, accessToken, refreshToken, expiresIn }` (kontrak login normal).
* Rate limit **5 percobaan/15 menit per mfaToken** (anti brute-force 6-digit).
* mfaToken: TTL 5 menit, konsumsi sekali sukses; percobaan salah tidak mematikannya.

#### 4. Disable
* **`POST /api/p/:pid/auth/mfa/disable`** · Bearer · Body: `{ token }` atau `{ recoveryCode }`
* Admin reset (user terkunci): **`POST /api/admin/projects/:pid/auth-users/:uid/mfa-reset`**

#### SDK
```ts
const enroll = await bf.auth.mfaEnroll();        // scan enroll.otpauthUrl
await bf.auth.mfaVerify('123456');               // simpan recoveryCodes!
const res = await bf.auth.login(email, pass);
if (bf.auth.isMfaRequired(res)) {
  await bf.auth.mfaChallenge(res.mfaToken, code); // atau recoveryCode
}
```

---

Ditambah otomatis setelah `register` (email verifikasi), dan tersedia via
endpoint khusus. Tanpa SMTP terkonfigurasi (Admin API `/api/admin/settings/mail`
atau env `SMTP_HOST`), email masuk ke **DEV OUTBOX** (dashboard Settings → Outbox)
— semua link tetap berfungsi.

#### Request Verification Email
* **Method:** `POST` · **URL:** `/api/p/:pid/auth/request-verification`
* **Body:** `{ "email": "user@example.com" }` (atau kosong + Bearer token = user saat ini)
* **Response:** selalu `200` (anti user-enumeration). Rate limit 5/15 menit/IP.
* Link di email: `GET /api/p/:pid/auth/verify-email?token=...` → halaman sukses
  (atau `POST { token }` untuk SDK).

#### Request Password Reset
* **Method:** `POST` · **URL:** `/api/p/:pid/auth/request-password-reset`
* **Body:** `{ "email": "user@example.com" }`
* **Response:** selalu `200` (anti user-enumeration). Rate limit 5/15 menit/IP.
* Link di email: `GET /api/p/:pid/auth/confirm-password-reset?token=...` →
  form HTML self-contained, atau `?redirect_to=` → `302` dengan
  `#reset_token=...` untuk halaman form aplikasi Anda.

#### Confirm Password Reset
* **Method:** `POST` · **URL:** `/api/p/:pid/auth/confirm-password-reset`
* **Body:** `{ "token": "...", "password": "newPassword123" }`
* **Efek:** password berganti + **semua refresh token user di-revoke**
  (logout dari semua device). Token sekali pakai, TTL 1 jam.

#### SDK Client

```ts
await bf.auth.requestVerification('user@example.com');
await bf.auth.requestPasswordReset('user@example.com');
await bf.auth.confirmPasswordReset(token, newPassword);
```

---

## 📋 2. Records CRUD (Database Collections)

Operasi CRUD generik untuk membaca dan memanipulasi data di setiap koleksi tabel. Setiap request dievaluasi terhadap **API Rules (RLS)** yang ditetapkan untuk koleksi tersebut.

### A. List Records
Mengambil daftar data dengan dukungan pagination, sorting, filtering, searching, dan expand relasi:

* **Method:** `GET`
* **URL:** `/api/p/:pid/collections/:collection/records`
* **Headers (Opsional):** `Authorization: Bearer <accessToken>`
* **Query Parameters:**
  * `page` *(number)*: Nomor halaman (default: `1`).
  * `perPage` *(number)*: Jumlah item per halaman (default: `20`, max: `100`).
  * `sort` *(string)*: Pengurutan field. Gunakan tanda `-` untuk descending. Contoh: `-created` atau `streak,-created`.
  * `filter` *(string)*: Ekspresi filter data (lihat bagian Sintaks Filter di bawah).
  * `search` *(string)*: Pencarian teks FTS5. Contoh: `?search=kopi gayo`.
  * `expand` *(string)*: Relasi yang ingin di-expand (JOIN otomatis). Contoh: `user` atau `user,author.profile`.

* **Response (200 OK):**
  ```json
  {
    "page": 1,
    "perPage": 20,
    "totalItems": 45,
    "totalPages": 3,
    "items": [
      {
        "id": "p4obybxwkje4bf7",
        "created": "2026-09-12T17:09:02.306Z",
        "updated": "2026-09-12T17:09:02.306Z",
        "title": "Belajar BaseForge",
        "user": "7nd6z9x3wkbys22",
        "expand": {
          "user": {
            "id": "7nd6z9x3wkbys22",
            "name": "Budi Santoso",
            "email": "budi@example.com"
          }
        }
      }
    ]
  }
  ```

### B. Get Single Record
Mengambil satu baris data berdasarkan ID:

* **Method:** `GET`
* **URL:** `/api/p/:pid/collections/:collection/records/:id`
* **Query Parameters:** `expand` (opsional).
* **Response (200 OK):**
  ```json
  {
    "record": {
      "id": "p4obybxwkje4bf7",
      "title": "Belajar BaseForge",
      ...
    }
  }
  ```

### C. Create Record
Menambahkan data baru. Mendukung format **JSON** maupun **Multipart Form-Data** (untuk upload file):

* **Method:** `POST`
* **URL:** `/api/p/:pid/collections/:collection/records`
* **Headers:** `Content-Type: application/json` (atau multipart saat upload file).
* **JSON Body Contoh:**
  ```json
  {
    "title": "Catatan Hari Ini",
    "done": false,
    "tags": ["coding", "backend"]
  }
  ```
* **Response (201 Created):** Mengembalikan objek record yang baru dibuat beserta `id`, `created`, dan `updated`.

### D. Update Record
Mengubah sebagian field record:

* **Method:** `PATCH`
* **URL:** `/api/p/:pid/collections/:collection/records/:id`
* **Body:** JSON atau Multipart berisi field yang ingin diubah.
* **Response (200 OK):** Mengembalikan objek record ter-update.

### E. Delete Record
Menghapus record:

* **Method:** `DELETE`
* **URL:** `/api/p/:pid/collections/:collection/records/:id`
* **Response (204 No Content)**

---

## 🔍 3. Sintaks Filter Query

BaseForge memiliki parser query SQL sendiri (M04) yang mengonversi ekspresi aman menjadi prepared statement SQL parameterized:

### Operator Perbandingan Dasar
* `field = "nilai"` : Sama dengan.
* `field != "nilai"` : Tidak sama dengan.
* `field > 10`, `field >= 10` : Lebih besar / sama dengan.
* `field < 5`, `field <= 5` : Lebih kecil / sama dengan.
* `field ~ "kata"` : Pencarian substring (`LIKE '%kata%'`).
* `field !~ "kata"` : Tidak mengandung kata.

### Operator Any-Match (Array / Multi-Relation)
Untuk field berupa array JSON atau relasi ganda (`maxSelect > 1`):
* `tags ?= "backend"` : Benar jika **setidaknya satu** elemen bernilai "backend".
* `tags ?!= "legacy"` : Benar jika **tidak ada satu pun** elemen bernilai "legacy".
* `tags ?~ "dev"` : Benar jika setidaknya satu elemen mengandung teks "dev".

### Operator Logika & Pengelompokan
* `&&` : AND logika.
* `||` : OR logika.
* `( ... )` : Kurung untuk prioritas evaluasi.

*Contoh Kompleks:*
```text
?filter=(status = "active" || status = "pending") && streak >= 5 && user = @request.auth.id
```

---

## 📁 4. File Storage & Thumbnails

### Upload File
Kirim request `POST` atau `PATCH` ke endpoint record dengan header `multipart/form-data`:
```bash
curl -X POST "http://localhost:5100/api/p/:pid/collections/photos/records" \
  -H "Authorization: Bearer <TOKEN>" \
  -F "title=Liburan" \
  -F "image=@pantai.jpg"
```

### Mengakses File
URL penyajian file publik:
```text
GET /api/files/:pid/:collection/:recordId/:filename
```

### Image Thumbnails Otomatis (`?thumb=WxH`)
Jika file adalah gambar, tambahkan parameter `?thumb` di akhir URL untuk membuat thumbnail instan secara lazy (ditenagai oleh library `sharp` dengan disk-caching otomatis):

* **`?thumb=100x100`** : Crop tengah persegi 100×100 px.
* **`?thumb=300x0`** : Lebar 300 px, tinggi proporsional mengikuti rasio asli.
* **`?thumb=0x200`** : Tinggi 200 px, lebar proporsional.
* **`?thumb=200x200f`** : Fit di dalam kotak 200×200 px tanpa pemotongan (preserve aspect ratio).

---

## 📊 5. Project Usage Stats (M24) — Admin

Statistik request & bandwidth per project (agregat harian, real-time — tampil juga di dashboard overview):

* **Method:** `GET`
* **URL:** `/api/admin/projects/:pid/stats`
* **Headers:** `Authorization: Bearer <adminToken>`

```json
{
  "today": { "date": "2026-09-16", "requests": 6, "bytesIn": 0, "bytesOut": 2576 },
  "days": [ { "date": "2026-09-03", "requests": 0, "bytesIn": 0, "bytesOut": 0 } ],
  "totals": { "requests": 6, "bytesIn": 0, "bytesOut": 2576 }
}
```

`days` berisi 14 hari terakhir (UTC, zero-filled — siap untuk chart). Yang
dihitung: semua request dengan projectId di path — public API
(`/api/p/:pid/…`), admin API (`/api/admin/projects/:pid/…`), dan file serving
(`/api/files/:pid/…`). Endpoint `/stats` sendiri tidak dihitung (observer effect).

---

## 🔔 6. Webhooks (M28) — Outbound HTTP on CRUD

**POST** ke URL Anda saat record CRUD terjadi. Keamanan via **HMAC-SHA256
signature** (ala Stripe/GitHub) — verifikasi di sisi penerima dengan secret
yang sama.

### Payload
```json
{
  "event": "posts.create",
  "action": "create",
  "collection": "posts",
  "record": { "id": "...", "title": "hello" },
  "previous": null,
  "timestamp": "2026-09-17T..."
}
```

### Headers (verifikasi)
```
X-BaseForge-Event: posts.create
X-BaseForge-Signature: sha256=<hex HMAC-SHA256(body, secret)>
```

### Verifikasi di penerima (Node.js)
```javascript
const crypto = require('crypto');
const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); // true = valid
```
⚠️ Body harus dibaca **raw** (bukan re-parse + re-stringify) — byte-level
fidelity adalah kontrak signature.

### Event Matching
- `posts.create` — hanya event itu
- `posts.*` — semua action pada collection `posts`
- `*` — semua event

### Delivery
- Timeout 10 detik per attempt (AbortController)
- **Retry: 3x dengan exponential backoff** (1s → 4s) saat non-2xx
- Delivery log 100 terakhir per webhook (query via admin API)

### Admin API
```
POST   /api/admin/projects/:pid/webhooks           { name, url, events } → secret sekali
GET    /api/admin/projects/:pid/webhooks           → list (secret disamarkan)
GET    /api/admin/projects/:pid/webhooks/:id       → detail + secret penuh
PATCH  /api/admin/projects/:pid/webhooks/:id       { name?, url?, events?, enabled? }
DELETE /api/admin/projects/:pid/webhooks/:id       → hapus
POST   /api/admin/projects/:pid/webhooks/:id/test  → kirim test payload
GET    /api/admin/projects/:pid/webhooks/:id/deliveries → log 20 terakhir
```

---

## 🖥️ 7. CLI (M28)

```bash
cd server && npm run cli -- <command>
# atau setelah build: baseforge <command>

baseforge login admin@baseforge.local    # prompt password → simpan token
baseforge use <projectId>                # set project aktif
baseforge projects                       # tabel daftar project
baseforge collections                    # tabel daftar collection
baseforge records list posts --perPage 5
baseforge records create posts '{"title":"Hello"}'
baseforge records delete posts <id>
baseforge functions                      # tabel daftar function
baseforge users                          # tabel end-users (verified, MFA)
baseforge webhooks                       # tabel daftar webhook
baseforge whoami                         # identitas + project aktif
baseforge logout
```

State: `~/.baseforge/cli.json` (token + project + server URL).

---

## 🧲 8. Vector Search (M29) — Embeddings & Similarity

## 📦 9. Storage Backend (M30) — Local Disk atau S3-Compatible

## 💾 10. Scheduled Backup (M32) — VACUUM INTO + Retensi Otomatis

### Admin API
```
GET    /api/admin/projects/:pid/backup/config     → { schedule, retention }
PUT    /api/admin/projects/:pid/backup/config     → set { schedule: 'daily'|'weekly'|'off', retention: 1-30 }
DELETE /api/admin/projects/:pid/backup/config     → reset ke default (off, 7)
POST   /api/admin/projects/:pid/backup/run        → trigger backup manual
GET    /api/admin/projects/:pid/backup/list       → daftar backup + metadata
GET    /api/admin/projects/:pid/backup/download/:filename → stream file .db
```

### Contoh
```bash
# Set backup harian dengan retensi 7
curl -X PUT http://localhost:5100/api/admin/projects/:pid/backup/config \
  -H "Authorization: Bearer <adminToken>" \
  -d '{"schedule": "daily", "retention": 7}'

# Trigger manual
curl -X POST http://localhost:5100/api/admin/projects/:pid/backup/run \
  -H "Authorization: Bearer <adminToken>"

# List backup
curl http://localhost:5100/api/admin/projects/:pid/backup/list \
  -H "Authorization: Bearer <adminToken>"
```

Backup file adalah SQLite database **self-contained** — bisa dibuka dengan
tool SQLite apa pun (DB Browser, sqlite3 CLI, atau `new DatabaseSync(path)`).
Restore = ganti file `data.db` dengan backup.

### Layout
```
data/backups/<projectId>/
  ├── 2026-09-17T10-30-00-000Z.db    ← file backup (SQLite self-contained)
  └── 2026-09-17T10-30-00-000Z.json  ← metadata (size, duration, counts)
```

---

### Konfigurasi (Admin API)

```
GET    /api/admin/settings/storage           → info backend aktif
PUT    /api/admin/settings/storage           → set config (local atau S3)
POST   /api/admin/settings/storage/test      → test koneksi (health check)
DELETE /api/admin/settings/storage           → reset ke local disk
```

### S3-Compatible Providers

| Provider | Endpoint | Region |
|---|---|---|
| AWS S3 | `https://s3.amazonaws.com` | `us-east-1` |
| Cloudflare R2 | `https://<account_id>.r2.cloudflarestorage.com` | `auto` |
| MinIO | `http://localhost:9000` | `us-east-1` |
| DO Spaces | `https://<region>.digitaloceanspaces.com` | `<region>` |
| Backblaze B2 | `https://s3.<region>.backblazeb2.com` | `<region>` |

### Set S3 Backend (contoh Cloudflare R2)

```bash
curl -X PUT http://localhost:5100/api/admin/settings/storage \
  -H "Authorization: Bearer <adminToken>" \
  -d '{
    "backend": "s3",
    "s3": {
      "endpoint": "https://abc123.r2.cloudflarestorage.com",
      "region": "auto",
      "bucket": "baseforge-files",
      "accessKeyId": "your-r2-access-key",
      "secretAccessKey": "your-r2-secret"
    }
  }'
```

### Environment Variables (alternatif)

```bash
S3_ENDPOINT=https://s3.amazonaws.com
S3_REGION=us-east-1
S3_BUCKET=my-bucket
S3_ACCESS_KEY_ID=AKIA...
S3_SECRET_ACCESS_KEY=...
S3_PREFIX=baseforge  # optional subdirectory dalam bucket
```

File layout di S3: `s3://<bucket>/<projectId>/<recordId>_<filename>` —
mirror dari layout lokal, jadi migration antar backend transparan.

---

### Field Type: `vector`
```json
{ "name": "embedding", "type": "vector", "options": { "dimensions": 1536 } }
```
Embedding disimpan sebagai JSON array. Dimensions harus cocok dengan model
embedding Anda (OpenAI `text-embedding-3-small` = 1536, `all-MiniLM-L6-v2` = 384).

### Search
* **`POST /api/p/:pid/collections/:name/vector-search`**
* **Body:**
```json
{
  "vector": [0.1, 0.2],
  "k": 10,
  "field": "embedding",
  "metric": "cosine",
  "minScore": 0.7,
  "filter": "category = 'published'"
}
```
* **Response:**
```json
{
  "items": [
    { "id": "...", "score": 0.95, "record": { "..." : "..." } },
    { "id": "...", "score": 0.87, "record": { "..." : "..." } }
  ],
  "totalSearched": 500,
  "vectorField": "embedding",
  "metric": "cosine",
  "durationMs": 42
}
```

### Parameters
| Param | Default | Description |
|---|---|---|
| `vector` | required | Query embedding (harus sama dims dengan field) |
| `k` | 10 | Top-K results (max 100) |
| `field` | first vector field | Nama field vector yang dicari |
| `metric` | `cosine` | `cosine` atau `l2` (skor 1/(1+distance)) |
| `minScore` | none | Threshold similarity (0-1) |
| `filter` | none | Filter expression M04 untuk pre-filter |
| **listRule** | **dievaluasi** | Security parity dengan aggregate M19 |

### RAG Pipeline Example (dengan M25 $http.send)
```javascript
// 1. Function generate embedding via OpenAI (M25 $http.send)
const res = await $http.send({
  url: "https://api.openai.com/v1/embeddings",
  method: "POST",
  headers: { "Authorization": "Bearer sk-..." },
  body: JSON.stringify({ input: text, model: "text-embedding-3-small" }),
});
const embedding = res.json().data[0].embedding;
return embedding; // → simpan ke record field type vector

// 2. Search: POST /vector-search dengan query embedding
```

---

## 🛑 Format Error Response

Semua endpoint mengembalikan error dalam format JSON seragam:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Field 'email' wajib diisi"
  }
}
```

Kode status HTTP umum:
* `400 Bad Request`: Validasi skema gagal atau parameter query tidak valid.
* `401 Unauthorized`: Token tidak disertakan, kedaluwarsa, atau tanda tangan tidak valid.
* `403 Forbidden`: Ditolak oleh API Rules (akses tidak diizinkan).
* `404 Not Found`: Project, koleksi, atau record tidak ditemukan.
* `409 Conflict`: Nilai field unique sudah digunakan (duplikat).
* `429 Too Many Requests`: Batas laju panggilan terlampaui (rate limit).
