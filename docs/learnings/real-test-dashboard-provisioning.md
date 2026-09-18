# Temuan real-test BaseForge: provisioning WekanzDashboard (2026-09-18)

Migrasi backend Wekanz Dashboard (Appwrite → BaseForge) adalah pemakaian
BaseForge pertama oleh aplikasi **multi-collection** (21 collection, 179 field,
~600 dokumen nyata). Bookmark Manager dan ExploreMaps masing-masing hanya
memakai 1–3 collection, sehingga beberapa masalah di bawah tidak pernah
tersentuh.

Dokumen ini mencatat apa yang **benar-benar menghambat**, bukan daftar
keinginan. Tiga di antaranya adalah bug/kekurangan produk, satu masalah
dokumentasi, sisanya catatan yang sudah tertangani.

---

## 1. `POST /collections` menerima rules yang salah bentuk tanpa protes (BUG)

**Dampak: tinggi.** Data end-user tidak bisa diakses, dan tidak ada tanda apa pun.

Body yang benar adalah `{ name, fields, rules: { listRule, ... } }`.
Mengirim rule secara **flat**:

```json
{ "name": "preferences", "fields": [...], "listRule": "...", "createRule": "..." }
```

membalas **`201 Created`** dengan gembira, tetapi seluruh rule tersimpan
`null`. Rule `null` berarti **mode admin**, sehingga end-user tidak bisa
membaca atau menulis apa pun — 21 collection tampak sukses dibuat padahal
tidak satu pun bisa dipakai aplikasi.

Gejalanya tidak terlihat sampai seseorang memeriksa `GET /collections` dan
membaca `rules`. Untuk klien yang memakai kredensial admin (seperti script
provisioning) semuanya terasa normal, karena admin melewati rules.

**Usulan:** tolak properti tak dikenal di tingkat teratas body collection
(`400 BAD_REQUEST: unknown field 'listRule' — did you mean rules.listRule?`).
Server sudah punya kebiasaan baik menolak field tak dikenal saat membuat
*record* (`Field 'updatedAt' does not exist in collection 'quick_notes'`) —
konsistensi yang sama di jalur schema akan langsung menangkap kasus ini.

## 2. `PATCH /collections/:name` membuang rules dalam diam (BUG)

**Dampak: sedang.** Membuat pengguna API mengira rules sudah diperbarui.

`PATCH` hanya membaca `body.fields`. Mengirim `{ rules: {...} }` membalas
**`200 OK`** tanpa mengubah apa pun. Satu-satunya endpoint yang benar-benar
menyimpan rules adalah `PUT`.

Yang membuat ini menonjol: ada komentar di `schema.ts` yang mencatat bug
**identik** pernah diperbaiki di M21 pada jalur `PUT`:

> *"M21 (B2): sebelumnya rules tidak pernah diteruskan ke sini, sehingga PUT
> dengan rules membalas 200 tanpa menyimpan apa pun."*

Jadi pola "rules diterima lalu dibuang" sudah pernah muncul sekali dan kembali
lagi di endpoint sebelahnya. Ini menunjukkan perlunya satu tempat validasi
body schema, bukan validasi ad-hoc per rute.

**Usulan:** `PATCH` sebaiknya (a) meneruskan `rules` seperti `PUT`, atau
(b) menolak `400` bila `rules` dikirim. Balasan `200` yang menyesatkan adalah
pilihan terburuk.

## 3. Tidak ada index otomatis untuk kolom pemilik (KEKURANGAN PERFORMA)

**Dampak: tinggi pada skala nyata.** Setiap pembacaan = full table scan.

Rule pemilik (`listRule: "userId = @request.auth.id"`) diterjemahkan server
menjadi `WHERE userId = ?` untuk **setiap** operasi list. Tetapi
`defineCollection` tidak membuat index apa pun untuk kolom itu, dan tidak ada
peringatan bahwa index dibutuhkan.

Terukur di project dashboard setelah provisioning (21 collection):

```
index non-sistem: 3      ← hanya milik tabel auth internal
                           (idx_auth_users_email, idx_auth_tokens_user,
                            idx_email_tokens_user_purpose)

EXPLAIN QUERY PLAN SELECT * FROM investments WHERE userId = ?
  → SCAN investments
EXPLAIN QUERY PLAN SELECT * FROM investment_activities WHERE userId = ?
  → SCAN investment_activities
```

Setelah menambahkan `idx_<col>_userId` secara manual ke 21 collection:

```
index userId: 21
  → SEARCH investments USING INDEX idx_investments_userId (userId=?)
  → SEARCH investment_activities USING INDEX idx_investment_activities_userId (userId=?)
masih SCAN: 0
```

Aplikasi seperti dashboard ini membaca 21 collection saat memuat halaman; tanpa
index setiap pemuatan adalah 21 full scan. Pada satu user dengan ~600 dokumen
dampaknya belum terasa, tetapi ia tumbuh linear terhadap jumlah user di project
yang sama — justru pada skenario multi-user yang menjadi alasan rules ada.

**Usulan:** ketika sebuah rule mereferensikan kolom (mis. `userId`), buat
index untuk kolom itu secara otomatis, atau tolak rule tersebut dengan pesan
yang menyarankan index. Alternatif paling murah: catat peringatan saat
collection dibuat dengan rule pemilik tanpa index yang cocok.

## 4. Kontrak admin API sulit ditemukan (DOKUMENTASI)

Tiga hal di bawah hanya bisa Christy pastikan dengan **membaca kode server**,
bukan dokumen:

| Yang dicari | Kenyataan |
|---|---|
| Daftar auth user | `/api/admin/projects/:pid/**auth-users**` (tanda hubung). `auth/users` → 404 |
| Ubah rules | hanya `PUT`, dan `fields` wajib disertakan (PUT = rebuild tabel) |
| Bentuk body collection | `rules` bersarang; tidak ada skema yang dipublikasikan |

Untuk aplikasi yang melakukan provisioning lewat script (pola yang akan diulang
setiap app Wekanz), ini friksi yang berulang.

**Usulan:** satu halaman `docs/admin-api.md` berisi bentuk body tiap endpoint
admin — cukup tabel ringkas, tidak perlu OpenAPI.

---

## Yang justru bekerja dengan baik

Supaya laporan ini berimbang:

- **Isolasi pemilik benar-benar menegakkan batas.** Diuji melawan server
  produksi: user baru membuat 1 record lalu `getList()` membalas
  `totalItems: 1` — bukan jumlah seluruh record di collection. Ini inti
  keamanan multi-user dan ia bekerja.
- **`rebuildCollection` tidak menghilangkan data.** Ia menyalin `commonFields`
  dan mempertahankan index lama bila `indexes === undefined`. Setelah 21
  collection di-PUT ulang, verifikasi mandiri mencatat 179 field utuh.
- **Validasi field record ketat dan pesannya jelas.**
  `Field 'updatedAt' does not exist in collection 'quick_notes'` langsung
  menunjuk kesalahan — jauh lebih baik daripada menerima diam-diam.
- **`createDefaultAuthStore()` sudah SSR-safe** (`typeof window` + fallback
  `MemoryAuthStore`). Kalau saja ini terpakai lebih awal, satu koreksi di sisi
  dashboard bisa dihindari.
- **Storage tanpa konsep bucket** menghapus seluruh ritual Appwrite
  (buat bucket, `fileSecurity`, per-file `read("any")`).

---

## Catatan operasional (bukan bug)

- **Kredensial admin di `server/.env` bisa basi.** `.env` produksi masih
  memuat `ADMIN_EMAIL` bootstrap, tetapi admin yang terdaftar di
  `_platform_admins` adalah akun Google pemilik → login dengan `.env` membalas
  401, dan `/api/admin/auth/setup` juga 401 (sudah ter-setup). Tidak ada jalur
  reset password admin platform (yang ada hanya reset password *auth user* per
  project dan `mfa-reset`). Bila password admin hilang, satu-satunya jalan
  adalah menyunting `_platform_admins` langsung di SQLite.
- **`platform.db` bisa tampak kecil (4 KB) karena WAL belum checkpoint** —
  isinya ada di `platform.db-wal` (ratusan KB). Tidak ada checkpoint eksplisit
  di kode server (`wal_checkpoint` nol kemunculan). Ini aman, tetapi mudah
  disalahartikan sebagai database kosong/korup saat inspeksi manual.
