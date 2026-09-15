# M20 — Parity Check: BaseForge vs Kebutuhan Nyata Wekanz Dashboard

> **Pertanyaan yang dijawab:** apakah BaseForge sudah cukup untuk menggantikan
> Appwrite pada Wekanz Dashboard? Bukan "apakah fiturnya ada", tapi "apakah
> skema dan query produksi yang sebenarnya bisa berjalan di atasnya".

**Aturan kerja:** repo `E:\MyApps\WekanzDashboard` dan Appwrite production
**hanya dibaca**. Tidak ada tulis, commit, push, atau deploy ke sisi dashboard.
Seluruh artefak M20 ditulis ke repo BaseForge.

---

## Metode

1. Baca `scripts/migration/schema.ts` milik Wekanz Dashboard — sumber kebenaran
   21 koleksi / 162 atribut.
2. Petakan tipe Appwrite → tipe BaseForge.
3. Bangun ulang seluruh skema itu di project BaseForge `m20-parity` lewat REST.
4. Seed data berskala produksi (105 investments, 414 investment_activities).
5. Jalankan 10 query yang benar-benar dipakai dashboard.
6. Uji fitur pendukung: permission, index, realtime, storage, functions, FTS.

---

## Hasil

### 1. Pemetaan tipe — 162/162 (100%)

| Appwrite | BaseForge | Jumlah |
|---|---|---|
| `string` | `text` | 103 |
| `integer` | `number` | 24 |
| `double` | `number` | 17 |
| `enum` | `select` | 13 |
| `boolean` | `bool` | 5 |

Tidak ada tipe yang kehilangan padanan. `datetime` tidak dipakai skema ini
(tanggal disimpan sebagai string) — BaseForge tetap punya `date` bila perlu.

Bonus: 12 field `*Id` yang di Appwrite hanya string biasa bisa menjadi
`relation` sungguhan di BaseForge, sehingga `expand` (M19) bisa dipakai.

### 2. Query produksi — 10/10 lulus

```
Query.equal(userId)           414 item   22.2 ms
Query.equal(investmentId)       7 item    3.0 ms
Query.greaterThan(idr,0)      194 item    3.6 ms
Query.lessThan(idr,0)         220 item    3.5 ms
Query.notEqual                414 item    3.1 ms
Query.orderDesc(date)                     2.5 ms
Query.orderAsc(date)                      2.7 ms
Query.limit + offset                      5.1 ms
proyeksi / select                         3.0 ms
filter gabungan (AND)         100 item   19.0 ms
```

### 3. Agregasi — identik dengan hitungan manual

```
SUM(idr) via REST   = -71.557.031
SUM(idr) dari seed  = -71.557.031        ✅ identik
GROUP BY investment_id → 103 grup, 103/103 cocok dengan seed
```

### 4. Benchmark melawan Appwrite production

| | Waktu | Data |
|---|---|---|
| BaseForge agregasi REST | **7,1 ms** | **19 byte** |
| BaseForge tarik 414 dok | 18,7 ms | 104 KB |
| Appwrite tarik 414 dok | 757 ms | 240 KB |
| Appwrite agregasi | ❌ HTTP 400 | — |

**106× lebih cepat, 12.665× lebih sedikit data** untuk jawaban yang sama.
Catatan jujur: BaseForge berjalan lokal, Appwrite lewat jaringan ke VPS —
sebagian keunggulan berasal dari latensi, bukan hanya arsitektur. Yang **tidak**
bisa dijelaskan oleh latensi adalah 19 byte vs 240 KB: itu murni akibat
agregasi dihitung di server.

### 5. Fitur pendukung

| Kebutuhan | Status |
|---|---|
| Auth collection | ✅ |
| Permission per-user (rules) | ✅ saat create |
| Isolasi data terbukti | ✅ A=3/6000, B=2/1200, anonim=0, admin bypass |
| Index B-Tree | ✅ via `PUT` |
| Realtime SSE | ✅ |
| Storage | ✅ |
| Functions | ✅ |
| Full-text search | ✅ |
| Export JSON | ✅ |
| `PATCH` additive (ALTER TABLE) | ✅ |

---

## 🚨 Tiga Blocker yang Ditemukan

### B1 — Nama field wajib huruf kecil (48% atribut ditolak)

`NAME_PATTERN = /^[a-z][a-z0-9_]*$/` di `server/src/core/fieldTypes.ts:73`.

Wekanz Dashboard memakai camelCase di **seluruh** skemanya: `userId`,
`cardId`, `namaTagihan`, `dueDate`, `googleEventId`.

```
atribut lolos   :  83/162 (51%)
atribut ditolak :  79/162 (48%)
koleksi gagal   :  19/21
```

Migrasi tanpa perubahan ini berarti mengganti nama 79 field di seluruh
codebase dashboard — persis jenis pekerjaan yang membuat migrasi gagal.
Nama koleksi aman (semuanya sudah `snake_case`).

### B2 — Rules diabaikan diam-diam pada `PUT` (dikoreksi di M21)

> **KOREKSI (M21).** Judul asli temuan ini berbunyi "rules tidak bisa diubah
> setelah collection dibuat" — itu **terlalu luas dan salah**. Pengujian ulang
> di M21 membuktikan `PATCH /api/admin/projects/:pid/collections/:name/rules`
> sudah ada sejak M11, berfungsi, dan menyimpan dengan benar. Yang benar-benar
> cacat hanya jalur `PUT`. Kesalahan Christy: menyimpulkan "fitur tidak ada"
> setelah menguji satu endpoint saja, tanpa mencari endpoint lain yang sudah
> menyediakan fungsi itu. Sebelum menyebut sesuatu hilang, cari dulu.

`rebuildCollection(db, name, newDef)` bertipe `{ fields, indexes? }` — tanpa
`rules`. `databaseRoutes.ts` juga tidak pernah meneruskan `body.rules` ke sana.
TypeScript tidak protes karena nilainya datang dari variabel (excess property
check hanya berlaku untuk objek literal).

```
PUT   .../collections/:name  { rules: {...} }  → HTTP 200 ✅
GET   .../collections/:name                    → rules: null ❌

PATCH .../collections/:name/rules              → 200 dan TERSIMPAN ✅ (jalur yang benar)
```

Ini pola yang **sama persis** dengan bug `expand` di M19: route mengirim,
core membuang, klien menerima 200.

### B3 — Field duplikat menghasilkan 500, bukan 400

```
POST .../collections  fields: [{name:'a'}, {name:'a'}]
→ HTTP 500 INTERNAL_ERROR "duplicate column name: a"
```

Kesalahan input klien dilaporkan sebagai kesalahan server. Ditemukan lewat
koleksi `billings`, yang di skema aslinya memang memuat `order` dua kali.

---

## Aha Moments

### #1 — Parity bukan daftar fitur, tapi daftar hambatan

Sebelum M20, tabel fitur BaseForge terlihat lengkap: CRUD ✅ auth ✅ realtime ✅
storage ✅ functions ✅ agregasi ✅. Semua benar. Tapi migrasi nyata berhenti di
**baris pertama**: nama field ditolak.

Satu aturan validasi tiga baris memblokir 48% skema — lebih menentukan daripada
seluruh daftar fitur di atasnya. Kesiapan sebuah platform ditentukan oleh
hambatan terkecilnya yang tidak bisa dihindari, bukan oleh fitur terbesarnya.

### #2 — "HTTP 200" bukan berarti "tersimpan"

Dua dari tiga blocker adalah gagal senyap, dan keduanya lolos dari 322 test.
Penyebabnya sama: test memverifikasi **status respons**, bukan **keadaan
setelahnya**. Pola yang benar untuk setiap operasi tulis:

```
PUT/PATCH  → cek status
GET ulang  → cek nilainya benar-benar berubah
```

Tanpa langkah kedua, sebuah endpoint bisa hijau selamanya sambil tidak
mengerjakan apa pun.

### #3 — TypeScript tidak menangkap properti berlebih yang diteruskan variabel

`rules` diteruskan ke fungsi yang tipenya tidak punya `rules`, dan kompilasi
tetap lolos. Excess property check hanya berlaku pada objek literal yang
ditulis langsung di tempat pemanggilan — begitu nilainya datang dari variabel
(`body.rules`), pengecekan itu hilang.

Karena itu type gate perlu didampingi test yang membaca ulang keadaan, bukan
dipercaya sendirian.

### #4 — Data uji harus berskala produksi

Dengan 5 record semuanya terlihat baik. Barulah pada 414 record perbedaan
7 ms vs 18,7 ms dan 19 byte vs 104 KB menjadi terlihat, dan `GROUP BY`
menghasilkan 103 grup yang bisa dibandingkan satu per satu dengan seed.
Angka kecil menyembunyikan karakteristik, bukan menyederhanakannya.

---

## Kesimpulan

BaseForge **secara arsitektur sudah siap** menggantikan Appwrite untuk Wekanz
Dashboard: seluruh tipe atribut punya padanan, 10 dari 10 query produksi jalan,
agregasi akurat dan jauh lebih efisien, isolasi data per-user terbukti.

Yang menghalangi bukan kemampuan, melainkan tiga hambatan mekanis (B1, B2, B3)
yang semuanya bisa diperbaiki di sisi BaseForge tanpa menyentuh dashboard.

**M21 yang disarankan:** perbaiki B1 (izinkan camelCase), B2 (rules pada
update), B3 (400 untuk field duplikat) — barulah migrasi data nyata layak
dicoba.

---

**Status: SELESAI** — 21 koleksi diuji, 162 atribut dipetakan, 10/10 query
lulus, 3 blocker terdokumentasi. Repo Wekanz Dashboard tidak disentuh
(HEAD `d2fa33d`, tree bersih, checksum tidak berubah).
