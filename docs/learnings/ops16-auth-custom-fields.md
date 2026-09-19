# Ops-16 — Custom profile field pada `_auth_users` (paritas Supabase, versi tervalidasi)

**Tanggal:** 2026-09-20
**Commit:** `8da5951`
**Status:** SELESAI — `tsc` 0 (server + dashboard + SDK) · **656/656 test** (645 → +11) ·
diverifikasi di server lokal dan DOM dashboard

## Konteks

Perbandingan auth BaseForge vs Supabase/Appwrite/PocketBase menempatkan "custom profile
field" sebagai gap paling nyata: `_auth_users` hanya punya `name` + `avatarUrl`, sementara
kompetitor mengizinkan field bebas per user.

Supabase punya DUA mekanisme:

1. `raw_user_meta_data` (`user_metadata`) — JSON bebas, **bisa diubah sendiri oleh user
   lewat `updateUser()`**, tanpa validasi, tidak bisa di-index. Dokumentasi Supabase
   sendiri memperingatkan agar tidak memakainya untuk otorisasi, dan menyediakan
   `app_metadata` (read-only bagi user) untuk itu.
2. Tabel `public.profiles` terpisah + trigger `on_auth_user_created` — rekomendasi RESMI
   mereka untuk data yang serius.

**Keputusan user: opsi tervalidasi (kolom SQL asli di `_auth_users`).** Alasannya opsi 2
(meniru `user_metadata`) berarti menyalin bagian yang Supabase sendiri anggap kompromi,
dan opsi 3 (collection `profiles`) di BaseForge lebih mahal daripada di Postgres —
BaseForge tidak punya trigger untuk event auth (`triggerExecutor` hanya melayani
`create/update/delete` pada collection), jadi auto-create baris profil saat register
harus dibangun sebagai subsistem baru.

## Infrastruktur yang DIPAKAI ULANG (bukan dibangun baru)

Semua sudah ada dan terbukti di repo ini — diverifikasi dengan grep sebelum desain:

| Yang dipakai | Lokasi | Catatan |
|---|---|---|
| `validateValue(field, value)` | `core/fieldTypes.ts:207` | 13 tipe field siap pakai |
| `isValidName(name)` | `core/fieldTypes.ts:89` | pola nama + batas 64 char |
| `isReservedFieldName(name)` | `core/fieldTypes.ts:100` | case-insensitive (SQLite `ID` ≡ `id`) |
| `FieldDefinition` | `core/fieldTypes.ts:28` | `name`/`type`/`required`/`unique`/`options` |
| Pola `ALTER TABLE ADD COLUMN` idempotent | `auth/users.ts:49` (M47 `disabled`) | cek `PRAGMA table_info` dulu |
| `PATCH /auth/me` + daftar-tolak | `api/authRoutes.ts:374` (Ops-9) | tinggal diperluas |

## Desain

### Penyimpanan definisi field

Tabel baru **`_auth_fields`** di project DB (bukan `_collections` — `_auth_users` adalah
tabel sistem, tidak terdaftar sebagai collection):

```
_auth_fields (
  name          TEXT PRIMARY KEY,   -- nama kolom di _auth_users
  type          TEXT NOT NULL,      -- FieldType yang sudah ada
  required      INTEGER NOT NULL DEFAULT 0,
  user_editable INTEGER NOT NULL DEFAULT 1,
  options       TEXT,               -- JSON, dipakai validateValue
  created       TEXT NOT NULL
)
```

Kolom fisiknya ditambahkan ke `_auth_users` via `ALTER TABLE ADD COLUMN` (pola M47).

### `user_editable` — pemisahan yang setara `user_metadata` vs `app_metadata`

Field dengan `user_editable = 0` **tidak bisa** diubah lewat `PATCH /auth/me` (403), hanya
lewat Admin API. Ini untuk `role`, `tier`, `quota` — persis alasan Supabase memisahkan
`app_metadata`. Bedanya: di sini tetap tervalidasi dan tetap kolom SQL yang bisa di-index
dan dipakai di API rules.

### Aturan `required` — HANYA saat register

`required` ditegakkan pada **register**, TIDAK pada `PATCH /auth/me`. Alasannya konkret:
menambah field `required` ke project yang sudah punya user membuat semua baris lama
bernilai `NULL`; kalau `PATCH` menegakkan `required`, user lama tidak bisa mengubah
`name`-nya sendiri hanya karena ada field baru yang tidak mereka isi. Update tetap
parsial (`'x' in body`), semantik Ops-9 dipertahankan.

### Kompatibilitas — OPT-IN PENUH

Tanpa satu pun field didefinisikan, perilaku server **identik** dengan sekarang:
`sendAuthSuccess` memakai daftar field eksplisit (`authRoutes.ts:106`), bukan spread, jadi
tidak ada yang bocor. Custom field muncul di respons hanya sebagai objek `profile` terpisah
dan hanya bila ada definisinya:

```jsonc
{ "user": { "id": "...", "email": "...", "name": "...", "profile": { "bio": "..." } } }
```

`profile` DIHILANGKAN sepenuhnya kalau `_auth_fields` kosong → byte-identical dengan respons
hari ini.

**Audit konsumen (sudah dilakukan, 2026-09-20):**
- ExploreMaps (Kotlin): Gson `JsonObject` + `json.get("x")` per field → field baru diabaikan.
- Dashboard & Bookmark Manager: SDK vendored, `authStore.save(..., res.user)` menyimpan objek
  user UTUH → field baru ikut tersimpan tanpa perubahan kode.
- Tidak satu pun memakai strict deserialization. Tidak ada yang perlu diubah agar tidak rusak.

### Bahaya `SELECT *` (harus ditangani eksplisit)

Enam query di `auth/users.ts` memakai `SELECT * FROM _auth_users`. Setelah ada kolom custom,
row membawa properti di luar `interface AuthUser`. `rowToUser` HARUS tetap memetakan field
sistem secara eksplisit dan memisahkan custom field ke `profile` lewat daftar dari
`_auth_fields` — jangan pernah menyebar row mentah ke respons, karena field ber-`user_editable=0`
buatan admin (mis. `internal_note`) akan ikut terkirim. Ini varian dari alasan
`password_hash` di-strip.

## Perubahan

- [x] `server/src/auth/authFields.ts` (BARU, 300 baris): `_auth_fields`, `defineAuthField`,
      `listAuthFields`, `deleteAuthField`, `validateProfileValues`, `extractProfile`
- [x] `server/src/auth/users.ts`: `rowToUser(db, row)` memisahkan `profile`; register + update
      menulis custom field
- [x] `server/src/api/authRoutes.ts`: helper `userPayload()` tunggal (sebelumnya blok user
      disalin 4×), validasi `profile` saat register, `PATCH /auth/me` menegakkan `userEditable`
- [x] `server/src/api/userAdminRoutes.ts`: GET/POST/DELETE `/auth-fields`
- [x] `server/tests/ops16-auth-custom-fields.test.ts`: **11 test**
- [x] `packages/client`: `updateProfile()` + `register(..., profile?)` + tipe `profile`
- [x] `dashboard/components/AuthFieldsEditor.tsx` + `lib/api.ts` + halaman Auth
- [x] `docs/api-reference.md` + `docs/admin-api.md`
- [ ] commit → push → deploy (menunggu perintah user)

## Verifikasi di server + DOM nyata

```
admin POST /auth-fields bio               → 201
admin POST /auth-fields tier (admin-only) → 201
user  register + profile                  → 201  {'bio': 'halo dunia', 'tier': 'free'}
user  PATCH /auth/me {bio}                → 200  bio='diubah user'
user  PATCH /auth/me {tier:'pro'}         → 403  FIELD_NOT_EDITABLE
      GET /auth/me                        → tier='free'  ← state, bukan hanya status code
DOM dashboard: tabel menampilkan bio | tier [Admin only] ; form menambah 'company' → muncul
```

## Aha Moments

1. **`fieldToSql()` TIDAK bisa dipakai untuk `ALTER TABLE ADD COLUMN`.** Ia menghasilkan
   `"x" TEXT NOT NULL` untuk field required, dan SQLite menolaknya pada tabel yang sudah
   berisi baris (`Cannot add a NOT NULL column with default value NULL` — diprobe langsung
   ke `node:sqlite`, bukan diasumsikan). Kolom custom karena itu SELALU nullable dan
   `required` ditegakkan di lapisan aplikasi. Kebetulan inilah juga yang membuat
   penambahan field aman bagi user yang sudah terdaftar — batasan SQLite memaksa desain
   yang memang lebih benar.

2. **`required` yang ditegakkan di update akan mengunci user lama dari profilnya sendiri.**
   Menambah field required ke project berisi user membuat baris lama `NULL`; kalau
   `PATCH /auth/me` menegakkan required, user tidak bisa mengubah namanya sendiri hanya
   karena admin menambah field yang tak pernah mereka isi. Mode validasi dipisah
   (`'register'` vs `'update'`) dan dikunci test khusus.

3. **`SELECT *` + kolom dinamis = kebocoran menunggu terjadi.** Enam query di `users.ts`
   memakai `SELECT *`; setelah ada kolom custom, row membawa kolom yang definisinya sudah
   dihapus maupun `password_hash`. Yang mencegah bocor BUKAN tipe TypeScript (row hanya
   diketik), melainkan `extractProfile` yang memfilter lewat daftar `_auth_fields`.
   Alasan yang sama dengan `password_hash` yang selalu di-strip.

4. **`tsc` menemukan pemanggil yang grep lewatkan.** Menambah parameter `db` ke `rowToUser`
   memunculkan error di `rows.map(rowToUser)` — bentuk yang tidak cocok dengan pola grep
   `rowToUser(row)`. Mengubah signature fungsi internal: percayakan inventarisnya ke
   `tsc --noEmit`, bukan ke grep.

5. **Penolakan harus keras, bukan senyap — dan dibuktikan lewat STATE.** Field admin-only
   yang diabaikan diam-diam akan membalas 200 dan membuat klien mengira eskalasi
   privilesenya berhasil. Jawabannya 403 `FIELD_NOT_EDITABLE`, dan test-nya tidak berhenti
   di status code: ia membaca ulang `GET /auth/me` untuk membuktikan `tier` benar-benar
   tidak berubah (pelajaran langsung dari Ops-9).

6. **Bentuk respons adalah kontrak — non-regresi diuji dengan membandingkan DAFTAR KUNCI.**
   Klaim "tidak merusak aplikasi yang ada" tidak bisa bersandar pada status 200. Test
   membandingkan `Object.keys(user).sort()` pada register/login/refresh/me/patch terhadap
   daftar 7 kunci yang persis ada sebelum Ops-16, sehingga kunci `profile` yang bocor
   tanpa sengaja akan menggagalkan build.

7. **Gap Ops-9 baru ketahuan saat memeriksa konsumen.** `PATCH /auth/me` dibangun di Ops-9
   justru agar frontend tidak perlu menyesuaikan diri — tapi SDK tidak pernah mendapat
   pembungkusnya, jadi konsumen SDK harus menulis `fetch` manual. Menambah kapabilitas
   server tanpa memeriksa apakah SDK bisa memakainya mengulang persis drift Ops-13.

## Yang TIDAK dikerjakan (sengaja)

- **Ketiga aplikasi konsumen tidak disentuh.** Audit menunjukkan tidak ada yang perlu
  berubah agar tidak rusak: ExploreMaps memakai Gson `JsonObject` (ambil per nama),
  Dashboard & Bookmark Manager menyimpan objek user utuh lewat `authStore.save`.
- **Re-vendor SDK ke 2 aplikasi belum dilakukan** — repo terpisah dengan aturan commit
  sendiri; menunggu permintaan user.
- **UI untuk mengedit nilai profil per user di dashboard admin** belum ada; admin bisa
  melihat nilainya di daftar Auth Users, tetapi mengubahnya masih lewat API.
