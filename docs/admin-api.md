# Admin API — bentuk body per endpoint

Referensi ringkas untuk klien yang melakukan provisioning lewat script
(pola yang diulang setiap aplikasi Wekanz). Semua endpoint di bawah butuh
header `Authorization: Bearer <adminToken>` dari
`POST /api/admin/auth/login`.

Dokumen ini lahir dari real-test WekanzDashboard: tiga kontrak di bawah
sebelumnya hanya bisa dipastikan dengan membaca kode server.

---

## Collections

### `POST /api/admin/projects/:pid/collections`

Membuat collection baru.

```json
{
  "name": "quick_notes",
  "type": "base",
  "fields": [
    { "name": "userId", "type": "text", "required": true, "options": { "max": 36 } },
    { "name": "title",  "type": "text" }
  ],
  "indexes": [
    { "name": "idx_quick_notes_userId", "fields": ["userId"], "unique": false }
  ],
  "rules": {
    "listRule":   "userId = @request.auth.id",
    "viewRule":   "userId = @request.auth.id",
    "createRule": "@request.auth.id != \"\"",
    "updateRule": "userId = @request.auth.id",
    "deleteRule": "userId = @request.auth.id"
  }
}
```

Kunci tingkat teratas yang diizinkan: **`name`, `type`, `fields`, `indexes`,
`rules`, `viewQuery`** — apa pun selain itu dibalas `400 BAD_REQUEST`.

> **`rules` WAJIB bersarang.** Mengirim rule di tingkat teratas
> (`{ "name": ..., "listRule": ... }`) dibalas **400** dengan pesan
> `unknown field 'listRule' at top level — did you mean rules.listRule?`
>
> Sebelum Ops-4, body seperti itu dibalas **201** sementara seluruh rule
> tersimpan `null` — artinya mode admin, dan end-user tidak bisa mengakses
> datanya sama sekali.

**Makna nilai rule** (`rules.ts`):

| Nilai | Arti |
|---|---|
| `null` (atau tidak dikirim) | hanya admin — dunia luar tidak bisa |
| `""` | publik, termasuk anonymous |
| `"ekspresi"` | dievaluasi sebagai filter, mendukung `@request.*` |

**Index otomatis:** kolom yang direferensikan sebuah rule mendapat index
`idx_<collection>_<field>_rule` secara otomatis, karena rule pemilik menjadi
`WHERE <field> = ?` pada setiap pembacaan. Kolom yang sudah punya index buatan
pengguna atau `unique` dilewati.

Balasan: `201` + `{ "collection": { ... } }`.

### `PUT /api/admin/projects/:pid/collections/:name`

Suntingan skema penuh — **melakukan rebuild tabel** (ubah tipe, hapus kolom,
ganti index).

```json
{
  "fields":  [ /* WAJIB — daftar LENGKAP field yang diinginkan */ ],
  "indexes": [ /* opsional */ ],
  "rules":   { /* opsional, di-merge dengan yang sudah ada */ }
}
```

- `fields` **wajib** (`400` bila bukan array). Rebuild menyalin data hanya
  untuk kolom yang masih ada di daftar baru, jadi kirim daftar lengkap.
- `indexes` dihilangkan → index yang sudah ada **dipertahankan**.
- `rules` dihilangkan → rules yang sudah ada dipertahankan.
- Validasi kunci tingkat teratas sama dengan `POST`.

### `PATCH /api/admin/projects/:pid/collections/:name`

Penambahan field saja (`ALTER TABLE ADD COLUMN`).

```json
{ "fields": [ /* daftar LENGKAP: yang sudah ada + yang baru */ ] }
```

- `fields` harus memuat **semua** field yang ada; field yang hilang dianggap
  dihapus, dan penghapusan ditolak (pakai `PUT` untuk itu).
- **`rules` TIDAK diterima di sini** → `400` dengan pesan yang menunjuk
  `PATCH /collections/:name/rules` atau `PUT /collections/:name`.
  Sebelum Ops-4, `rules` di sini dibalas `200` lalu dibuang dalam diam.

### `PATCH /api/admin/projects/:pid/collections/:name/rules`

Tempat yang benar untuk mengubah rules saja (sejak M11). Field rule yang tidak
dikirim dipertahankan.

```json
{ "listRule": "userId = @request.auth.id", "createRule": "@request.auth.id != \"\"" }
```

### `GET /api/admin/projects/:pid/collections`

Balasan `{ "collections": [ { name, type, viewQuery, fields, indexes, rules, recordCount, created } ] }`.

> Verifikasi provisioning dari sini, jangan dari status `201`. Periksa
> `rules.listRule` benar-benar non-null.

### `DELETE /api/admin/projects/:pid/collections/:name`

---

## Auth users

| Method | Path |
|---|---|
| `GET` | `/api/admin/projects/:pid/**auth-users**?page=1&perPage=50` |
| `GET` | `/api/admin/projects/:pid/auth-users/:uid` |
| `DELETE` | `/api/admin/projects/:pid/auth-users/:uid` |
| `POST` | `/api/admin/projects/:pid/auth-users/:uid/verify` |
| `POST` | `/api/admin/projects/:pid/auth-users/:uid/disable` — body `{ "disabled": true \| false }` (default `true`) |
| `POST` | `/api/admin/projects/:pid/auth-users/:uid/mfa-reset` |

> Perhatikan **tanda hubung**: `auth-users`. Bentuk `auth/users` membalas `404`.

### Custom profile field (Ops-16)

| Method | Path |
|---|---|
| `GET` | `/api/admin/projects/:pid/auth-fields` |
| `POST` | `/api/admin/projects/:pid/auth-fields` — body `{ name, type, required?, userEditable?, options? }` |
| `DELETE` | `/api/admin/projects/:pid/auth-fields/:name` |

Menambahkan field membuat **kolom SQL asli** di `_auth_users` (bukan blob JSON),
sehingga bisa di-index dan dipakai di API rules. Tipe yang didukung: `text`,
`number`, `bool`, `email`, `url`, `date`, `select`, `json` — divalidasi oleh
engine `fieldTypes` yang sama dengan collection biasa.

- **`required`** ditegakkan **hanya saat register**, tidak saat `PATCH /auth/me`.
  Menambahkan field required ke project yang sudah punya user tidak mengunci
  mereka dari profilnya sendiri (nilai lama `NULL`).
- **`userEditable: false`** = padanan `app_metadata` Supabase: user mendapat
  **403 `FIELD_NOT_EDITABLE`** bila mencoba mengubahnya lewat `PATCH /auth/me`;
  hanya Admin API yang boleh. Pakai untuk `role`, `tier`, `quota`.
- Nama yang bentrok dengan kolom sistem (`id`, `email`, `password_hash`, `name`,
  `avatar_url`, `verified`, `disabled`, `created`, `updated`) ditolak
  **case-insensitive** — SQLite menganggap `Email` dan `email` kolom yang sama.
- `DELETE` menghapus definisi **dan** kolom fisiknya, sehingga nilai lama tidak
  tertinggal di disk tanpa bisa dijangkau API.

**Menonaktifkan akun (`/disable`, Ops-15)** bersifat *menegakkan*, bukan sekadar
menandai: (1) semua refresh token user itu **di-revoke seketika**, (2) login
password, OAuth, dan penyelesaian MFA menjawab **403 `USER_DISABLED`**,
(3) refresh ditolak. Access token yang sudah terbit tetap berlaku sampai TTL-nya
habis (≤ 15 menit) — JWT stateless. `{ "disabled": false }` memulihkan login
tanpa perlu langkah lain; token lama tidak dihidupkan kembali.

Balasan list: **`{ "items": [...], "page", "perPage", "totalItems", "totalPages" }`**
— kuncinya **`items`**, BUKAN `users`. Salah kunci membuat skrip pembersihan
terbaca "0 akun" padahal `totalItems > 0` (terjadi nyata saat real-test
WekanzDashboard, 2026-09-19).

---

## Projects

| Method | Path | Body |
|---|---|---|
| `POST` | `/api/admin/projects` | `{ "name": "wekanz-dashboard" }` |
| `GET` | `/api/admin/projects` | — |
| `DELETE` | `/api/admin/projects/:pid` | — |

Semua layanan (database, auth, storage, functions) aktif secara default; tidak
ada langkah aktivasi.

**Storage** tidak punya konsep bucket yang harus dibuat: satu bucket per
project, direktori `data/projects/<pid>/files/` muncul sendiri saat upload
pertama.

---

## Pola yang disarankan untuk script provisioning

1. Login admin → simpan token.
2. `POST /projects` → simpan `project.id`.
3. Untuk setiap collection: `POST /collections` dengan `fields`, `indexes`,
   dan `rules` bersarang.
4. **Baca ulang** `GET /collections` dan verifikasi: jumlah collection, jumlah
   field, dan `rules.listRule` non-null.
5. Untuk memperbaiki rules pada collection yang sudah ada: `PUT` dengan
   `fields` yang sama persis + `rules`, lalu verifikasi jumlah field tidak
   berubah.

Contoh lengkap yang dipakai di produksi:
`WekanzDashboard/scripts/migration/baseforge-provision.mjs` +
`verify-baseforge-phase0.mjs`.
