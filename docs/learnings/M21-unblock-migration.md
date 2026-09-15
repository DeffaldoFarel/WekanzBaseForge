# M21 — Membuka Tiga Blocker Migrasi (B1, B2, B3)

> **Masalah:** M20 membuktikan BaseForge secara arsitektur sanggup menggantikan
> Appwrite untuk Wekanz Dashboard — 162/162 tipe terpetakan, 10/10 query lulus,
> agregasi akurat. Tetapi migrasi nyata berhenti di tiga hambatan mekanis.
> M21 membuka ketiganya tanpa menyentuh repo dashboard.

---

## B1 — Nama field wajib huruf kecil

### Kondisi sekarang

`server/src/core/fieldTypes.ts:73`

```ts
const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
```

Dampak terukur pada skema Wekanz Dashboard:

```
atribut ditolak : 79/162  (48%)
koleksi gagal   : 19/21
```

Contoh yang ditolak: `userId`, `cardId`, `namaTagihan`, `dueDate`,
`googleEventId`, `spawnedNextId`, `frequencyType`.

### Kenapa aturan ini ada

Komentar di atasnya menjelaskan alasannya, dan alasannya **benar**:

> nama collection dan nama field akan disisipkan LANGSUNG ke dalam string SQL
> (CREATE TABLE <nama> ...). Parameter binding (?) TIDAK BISA dipakai untuk
> nama tabel/kolom — hanya untuk nilai!

Jadi perbaikan tidak boleh melonggarkan pertahanan SQL injection. Yang diubah
hanya **rentang karakter yang diizinkan**, bukan ketatnya validasi.

### Desain

```ts
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
```

Tetap: wajib diawali huruf, hanya alfanumerik + underscore, maksimal 64
karakter, tanpa spasi/tanda kutip/titik koma/tanda hubung. Permukaan serangan
tidak bertambah — huruf kapital tidak punya makna khusus di SQL.

### Konsekuensi yang harus ditangani

Probe langsung ke `node:sqlite` menunjukkan tiga fakta:

```
CREATE TABLE t2 ("userId" TEXT, "userid" TEXT)  → DITOLAK: duplicate column name
SELECT "USERID" FROM t                          → berhasil, mengembalikan userId
PRAGMA table_info(t)                            → ["userId","id"]  (apa adanya)
```

1. **SQLite membandingkan nama kolom secara case-insensitive.** `userId` dan
   `userid` dianggap sama → duplikat harus dideteksi case-insensitive, jika
   tidak errornya muncul sebagai 500 dari SQLite (persis gejala B3).
2. **Kapitalisasi tetap tersimpan** di PRAGMA, sehingga respons API tetap
   mengembalikan `userId` seperti yang didefinisikan.
3. **Field sistem harus dicek case-insensitive**: `ID`, `Created`, `UPDATED`
   sama berbahayanya dengan `id`, `created`, `updated`.

---

## B2 — Rules diabaikan diam-diam saat update

### Kondisi sekarang

```ts
// schema.ts:546
export function rebuildCollection(
  db: DatabaseSync,
  name: string,
  newDef: { fields: FieldDefinition[]; indexes?: IndexDefinition[] }  // ← tanpa rules
): CollectionMeta
```

`databaseRoutes.ts:119` tetap mengirim `rules: body.rules`. TypeScript tidak
protes karena nilainya datang dari variabel, bukan objek literal — excess
property check tidak berlaku.

```
PUT  .../collections/:name  { rules: {...} }  → HTTP 200 ✅
GET  .../collections/:name                    → rules: null ❌
```

Rules hanya tersimpan bila di-set saat `POST` create. Untuk Wekanz Dashboard
ini berarti setiap perubahan aturan akses menuntut collection dibuat ulang.

### Desain

1. Tambahkan `rules?: Partial<CollectionRules>` ke tipe `newDef`.
2. Terapkan di dalam transaksi rebuild yang sama (rules ikut atomik).
3. Semantik: field `rules` yang **tidak dikirim** dipertahankan; yang dikirim
   menimpa; `null` eksplisit menghapus aturan.
4. Tambahkan juga jalur `PATCH` khusus rules sehingga mengubah aturan akses
   tidak perlu rebuild tabel sama sekali — mengubah rules adalah operasi
   metadata, bukan operasi skema.

---

## B3 — Field duplikat menghasilkan 500

### Kondisi sekarang

```
POST .../collections  fields: [{name:'a'}, {name:'a'}]
→ HTTP 500 INTERNAL_ERROR "duplicate column name: a"
```

Kesalahan input klien dilaporkan sebagai kesalahan server. Ditemukan lewat
collection `billings` yang memang memuat `order` dua kali di skema aslinya.

### Desain

Validasi duplikat **case-insensitive** sebelum SQL dibangun, di `defineCollection`
dan `rebuildCollection`, dengan pesan yang menyebut nama yang bentrok →
`400 VALIDATION_ERROR`.

---

## Berkas yang disentuh

| Berkas | Perubahan |
|---|---|
| `server/src/core/fieldTypes.ts` | `NAME_PATTERN` izinkan A-Z; helper cek field sistem case-insensitive |
| `server/src/core/schema.ts` | validasi duplikat case-insensitive; `rebuildCollection` terima `rules`; `updateCollectionRules()` baru |
| `server/src/api/databaseRoutes.ts` | teruskan `rules` ke rebuild; rute `PATCH .../rules` |
| `server/tests/m21-*.test.ts` | test HTTP untuk ketiga blocker |

---

## Checklist

- [x] B1: `NAME_PATTERN` menerima camelCase
- [x] B1: field sistem ditolak case-insensitive (`ID`, `Created`, `Updated` → 6/6 ditolak)
- [x] B1: kapitalisasi terjaga di respons API (`namaTagihan` utuh)
- [x] B1: keamanan tidak melonggar (7/7 nama berbahaya ditolak)
- [x] B3: duplikat case-insensitive → 400, bukan 500
- [x] B2: `rebuildCollection` menyimpan rules (PUT)
- [x] B2: `PATCH .../rules` — **ternyata sudah ada sejak M11**, lihat koreksi
- [x] Skema Wekanz Dashboard **21/21** collection, 159 atribut, **tanpa** rename
- [x] Suite penuh hijau — **335/335**

---

## Hasil Akhir (terverifikasi)

```
Skema asli Wekanz Dashboard, tanpa satu pun rename:
  M20:  2/21 collection  (48% atribut ditolak)
  M21: 21/21 collection, 159 atribut          ✅

Query produksi dengan nama camelCase asli:
  equal(userId)        414 item      equal(type,'buy')   199 item
  equal(investmentId)    3 item      orderDesc(date)     414 item
  greaterThan(idr,0)   217 item      paginate p3         414 item
  lessThan(idr,0)      197 item      AND gabungan         98 item
  → 8/8 HTTP 200, 8/8 mengembalikan data

Agregasi:
  SUM(idr) REST = -46.622.197  vs seed -46.622.197   ✅ identik
  GROUP BY investmentId → 101 grup, cocok 101/101    ✅

Keamanan (tidak melonggar):
  'user Id' 'user-Id' 'user;drop' "user'x" '1abc' 'user.id' 'user"q' → 7/7 ditolak 400
  'id' 'ID' 'Id' 'created' 'CREATED' 'Updated'                       → 6/6 ditolak 400

Test: 335/335 lulus (sebelum M21: 322), 27 suite, ~46 detik, exit 0
tsc --noEmit: 0 error
```

---

## KOREKSI terhadap laporan M20

**Klaim B2 di jurnal M20 terlalu luas dan salah.** Judulnya berbunyi "rules
tidak bisa diubah setelah collection dibuat". Faktanya:

```
PATCH /api/admin/projects/:pid/collections/:name/rules  → 200 dan TERSIMPAN ✅
```

Endpoint itu sudah ada sejak M11, lengkap dengan validasi dan merge, dan
terdaftar di dua router. Yang benar-benar cacat hanya jalur `PUT`.

Penyebab kesalahan: Christy menguji satu endpoint (`PUT`), melihatnya gagal,
lalu menyimpulkan kemampuannya tidak ada — tanpa mencari apakah ada endpoint
lain yang sudah menyediakannya. Jurnal M20 sudah dikoreksi di tempatnya.

Pelajarannya: **sebelum menyatakan sebuah kemampuan hilang, cari dulu.**
Satu `grep updateCollectionRules` akan menjawabnya dalam hitungan detik.

---

## Aha Moments

### #1 — Satu regex tiga baris menahan seluruh migrasi

`/^[a-z][a-z0-9_]*$/` → `/^[A-Za-z][A-Za-z0-9_]*$/`. Satu karakter berubah,
dan skema yang tadinya lolos 2/21 menjadi 21/21.

Tidak ada fitur baru yang ditambahkan di sini. Yang dikerjakan M21 hampir
seluruhnya adalah **menghapus hambatan**, bukan menambah kemampuan. Untuk
sebuah platform yang hendak dipakai orang lain, pekerjaan jenis ini sering
lebih menentukan daripada menambah fitur berikutnya.

### #2 — Melonggarkan validasi tidak sama dengan melemahkan keamanan

Aturan huruf-kecil-saja ada karena nama kolom disisipkan langsung ke SQL —
alasan yang benar. Tetapi yang sebenarnya melindungi adalah **daftar karakter
yang diizinkan**, bukan huruf kecilnya. Huruf kapital tidak punya makna khusus
di SQL.

Setelah perubahan, 7 nama berbahaya tetap ditolak dan 6 nama field sistem tetap
ditolak. Permukaan serangan tidak bertambah satu pun.

Pelajaran: ketika sebuah aturan keamanan menghalangi pekerjaan nyata, pisahkan
**apa yang benar-benar melindungi** dari **apa yang kebetulan ikut terlarang**.

### #3 — Melonggarkan satu aturan memunculkan kewajiban baru

Mengizinkan huruf kapital langsung melahirkan masalah yang sebelumnya mustahil:
SQLite membandingkan nama kolom secara case-insensitive.

```
CREATE TABLE t ("userId" TEXT, "userid" TEXT) → duplicate column name
SELECT "USERID" FROM t                        → berhasil
PRAGMA table_info(t)                          → ["userId","id"]  (apa adanya)
```

Artinya: (a) pengecekan duplikat wajib case-insensitive, (b) penolakan field
sistem wajib case-insensitive (`ID` sama berbahayanya dengan `id`).

Tanpa keduanya, B1 akan "berhasil" sambil melahirkan gelombang 500 baru —
persis gejala B3 yang sedang diperbaiki di milestone yang sama. Probe langsung
ke `node:sqlite` sebelum menulis kode yang mengungkap ini.

### #4 — "8/8 query lulus, 0 item" adalah hijau palsu

Saat menguji ulang query produksi, seluruh 8 query membalas HTTP 200 — dan
semuanya mengembalikan **0 item**, karena seed gagal diam-diam (`date` bersifat
required dan Christy lupa mengirimnya).

Kalau laporan berhenti di "8/8 HTTP 200", M21 akan dinyatakan berhasil
berdasarkan tabel kosong. Sejak itu setiap baris hasil memuat dua angka:
status **dan** jumlah data. Sebuah query yang benar atas data kosong tidak
membuktikan apa pun.

### #5 — Kesalahan sendiri bisa jadi alat verifikasi

`isReservedFieldName is not defined` muncul karena Christy lupa menambah
import — tetapi error itu justru membuktikan server `tsx` melakukan hot-reload
dan benar-benar menjalankan kode yang baru diedit, bukan versi lama di memori.

Tanpa kegagalan itu, semua pengujian berikutnya berpotensi menguji kode basi
tanpa ada yang menyadarinya.

---

**Status: SELESAI** — B1, B2, B3 tertutup; 21/21 collection skema asli tanpa
rename; 335/335 test; tsc 0 error; repo Wekanz Dashboard tidak disentuh.
