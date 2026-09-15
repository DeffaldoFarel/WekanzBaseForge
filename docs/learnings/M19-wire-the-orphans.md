# M19 — Wire the Orphans: Agregasi & Expand lewat REST

> **Konsep:** Modul core yang lengkap dan teruji tetapi tidak pernah diimpor
> oleh satu pun route adalah fitur yang **tidak ada** dari sudut pandang klien.
> Milestone ini membuka "pintu REST" untuk dua modul yatim tersebut.

## 🎯 Masalah yang Dipecahkan

Audit gap (2026-09-15) menemukan dua modul di `server/src/core/` yang
diekspor, punya test hijau, tetapi **diimpor oleh 0 file**:

```
🚨 aggregates.ts  → diimpor oleh 0 file  (D7 ditandai ✅ di README)
🚨 relations.ts   → diimpor oleh 0 file  (D2/D6 ditandai ✅ di README)
```

Semua 19 modul core lain punya minimal 1 importer. Dua ini hanya dipanggil
dari file test — jadi test hijau **tidak membuktikan** fitur bisa dipakai.

### Bukti HTTP (server nyata di :5100, bukan analisis statis)

**Gap 1 — agregasi tidak punya pintu:**

```
GET /api/admin/projects/:pid/collections/books/aggregate?function=sum&field=harga
→ 404 NOT_FOUND
```

**Gap 2 — `expand` diabaikan diam-diam (lebih berbahaya):**

```
GET /api/admin/projects/:pid/collections/books/records?expand=author
→ HTTP 200 ✅
  { "judul": "Bumi", "author": "kdv7nuhqo0mer0x" }   ← tidak ada key "expand"
```

`databaseRoutes.ts:203` meneruskan `expand: req.query.get('expand')` ke
`listRecords()`, tetapi `ListOptions` (records.ts:45-52) **tidak punya field
`expand`**.

TypeScript sebenarnya **sudah menangkap ini**:

```
databaseRoutes.ts(203,9): error TS2353: Object literal may only specify known
properties, and 'expand' does not exist in type 'ListOptions'.
```

Tetapi `npx tsc --noEmit` pada HEAD mengeluarkan **7 error pra-ada**, jadi
peringatan yang benar tenggelam di antara noise dan tidak pernah
ditindaklanjuti. Test suite tetap 300/300 hijau karena test memanggil modul
core secara langsung, tidak lewat route.

**Pelajaran sesungguhnya bukan "TypeScript tidak menangkapnya", melainkan
"type gate yang dibiarkan merah berhenti menjadi gate".** Excess property
check bekerja persis seperti seharusnya; yang gagal adalah kebiasaan
membiarkan error menumpuk.

Efek ke klien tetap sama: opsi dibuang diam-diam, status 200, klien mengira
berhasil. Pola kegagalan ini sama dengan bug `addPlatform` di Wekanz
Dashboard: **gagal senyap lebih mahal daripada error keras.**

## 🧠 Desain

### Kontrak REST agregasi

Dua permukaan, konsisten dengan pola route yang sudah ada:

```
GET /api/admin/projects/:pid/collections/:name/aggregate   (admin, bypass rules)
GET /api/p/:pid/collections/:name/aggregate                (end user, rules berlaku)
```

Query parameter:

| Param      | Wajib | Arti                                        |
|------------|-------|---------------------------------------------|
| `function` | ya    | `count` \| `sum` \| `avg` \| `min` \| `max` |
| `field`    | kondisional | wajib untuk sum/avg/min/max           |
| `filter`   | tidak | filter M04, sama seperti `listRecords`      |
| `groupBy`  | tidak | hasil per kelompok                          |

Bentuk respons — **dua bentuk berbeda**, mengikuti tipe yang sudah ada di
`aggregates.ts` (`AggregateSingleResult` vs `AggregateGroupResult`):

```jsonc
// tanpa groupBy
{ "value": 397000 }

// dengan groupBy
{ "groups": [ { "group": "novel", "value": 260000 },
              { "group": "puisi", "value": 137000 } ] }
```

### Keamanan: agregasi WAJIB menghormati listRule

Ini bagian paling penting. Agregasi membocorkan informasi tentang baris yang
**tidak boleh dibaca** end user kalau rule diabaikan — `count` pada koleksi
orang lain adalah kebocoran data meski tidak satu pun record dikembalikan.

`aggregate()` saat ini menerima `filter` tetapi **tidak menerima `reqCtx`**.
Maka kontraknya diperluas mengikuti pola `listRecords`:

```
options.reqCtx === undefined        → admin, bypass (seperti listRecords)
listRule === null  + end user       → tidak ada baris  → value 0 / groups []
listRule === ''    (public)         → tidak menambah WHERE
listRule custom    → decideRule()   → WHERE tambahan SEBELUM filter user
```

Urutan WHERE harus sama dengan `listRecords`: **rule dulu, filter user
belakangan**, digabung dengan `AND`.

### Menyambung `expand`

`expandRecords()` sudah matang: batch loading (bukan N+1), nested `a.b.c`
rekursif, `MAX_EXPAND_DEPTH = 5`, dukungan multi-relation. Yang kurang hanya
pemanggilnya.

Titik sambung:

1. `ListOptions` → tambah `expand?: string`
2. `listRecords()` → setelah `items` terbentuk, panggil `expandRecords()`
3. `getRecord()` → terima `options?: { expand?: string }`
4. `publicRoutes.ts` → teruskan `expand` (saat ini **tidak** diteruskan sama
   sekali di jalur publik — hanya admin yang mengirim, itu pun dibuang)

Keamanan expand: record target diambil lewat `SELECT * FROM target WHERE id
IN (...)` **tanpa** mengecek `viewRule` koleksi target. Untuk M19 ini
diterima apa adanya (sama seperti perilaku PocketBase), tetapi dicatat
sebagai batasan yang diketahui — bukan diklaim aman.

## 📁 File yang Berubah

| File | Perubahan |
|---|---|
| `server/src/core/aggregates.ts` | `AggregateOptions.reqCtx`, terapkan `listRule` |
| `server/src/core/records.ts` | `ListOptions.expand`, panggil `expandRecords`; `getRecord` opsi expand |
| `server/src/api/databaseRoutes.ts` | route `/aggregate` (admin) |
| `server/src/api/publicRoutes.ts` | route `/aggregate` (end user) + teruskan `expand` |
| `server/tests/m19-aggregate-api.test.ts` | baru |
| `server/tests/m19-expand-api.test.ts` | baru |
| `dashboard/.../database/` | panel agregasi di Database Studio |
| `README.md` | koreksi klaim D7/D6/D2 + jumlah test |

## ✅ Checklist

- [ ] `AggregateOptions` menerima `reqCtx` dan menerapkan `listRule`
- [ ] Route `GET .../collections/:name/aggregate` (admin)
- [ ] Route `GET /api/p/:pid/collections/:name/aggregate` (end user + rules)
- [ ] Validasi: `function` tidak dikenal → 400, bukan 500
- [ ] `ListOptions.expand` + `listRecords` memanggil `expandRecords`
- [ ] `getRecord` mendukung expand
- [ ] `publicRoutes` meneruskan `expand` di list dan get
- [ ] Test: agregasi single + groupBy + filter
- [ ] Test: agregasi end user terbatas listRule (bukti isolasi antar user)
- [ ] Test: expand single, multi, nested, relasi tidak valid diabaikan
- [ ] Test: expand di jalur publik menghormati rules
- [ ] UI dashboard: panel agregasi
- [ ] README dikoreksi (D7, D6, D2, jumlah test)
- [ ] Suite penuh hijau, jumlah dilaporkan

## 🧪 Rencana Bukti

Bukan "test hijau" saja — audit ini lahir justru karena test hijau menutupi
fitur yang tidak tersambung. Maka bukti M19 harus mencakup:

1. **HTTP nyata**: `curl` ke server hidup, sebelum/sesudah, dengan status code
2. **Anti-regresi modul yatim**: test yang memastikan `aggregates` dan
   `relations` benar-benar diimpor oleh lapisan API — bukan hanya oleh test
3. **Isolasi**: end user A tidak boleh melihat agregat baris milik user B
4. **Perbandingan angka**: hasil `SUM` via REST == hasil hitung manual

## Aha Moments

<!-- diisi setelah implementasi -->

---

Status: SEDANG BERJALAN

---

## Hasil Akhir (terverifikasi)

### Test
```
Suite penuh : 322 pass / 0 fail   (sebelum M19: 300)
  m19-aggregate-api.test.ts : 13 pass
  m19-expand-api.test.ts    :  9 pass
tsc --noEmit : 0 error  (HEAD punya 7 error pra-ada — M19 membersihkan semuanya)
```

### Bukti agregasi lewat HTTP
```
admin  COUNT            → 5
admin  SUM(amount)      → 2100   (== hitung manual dari list)
admin  avg/min/max      → 420 / 100 / 800
admin  GROUP BY status  → { paid: 1000, pending: 1100 }
admin  COUNT amount>250 → 3
```

### Bukti listRule menegakkan isolasi
```
user A → count=3  sum=600    (100+200+300)
user B → count=2  sum=1500   (700+800)
admin  → count=5  sum=2100   (bypass)
user A GROUP BY → { paid: 300, pending: 300 }   bukan { paid: 1000, pending: 1100 }
```
Ini bagian paling penting M19. `COUNT(*)` tanpa rule sudah membocorkan
informasi: user bisa menghitung baris milik orang lain tanpa pernah melihat
isinya. Urutan WHERE dibuat identik dengan `listRecords` — rule dulu, filter
user belakangan — supaya tidak ada jalur agregasi yang lebih longgar daripada
jalur list.

### Bukti expand
```
expand=author            → expand.author.nama = 'Andrea Hirata'
expand=author.publisher  → expand.author.expand.publisher.nama = 'Bentang'
expand=kontributor       → ['Andrea Hirata', 'Tere Liye']   (array)
buku tanpa relasi        → 200, expand kosong (tidak crash)
expand=judul (non-rel)   → 200, diabaikan (semantik PocketBase)
tanpa expand             → key `expand` tidak muncul
```

---

## Pelajaran

**1. Test hijau tidak membuktikan fitur bisa dipakai.**
`d7-aggregates.test.ts` memanggil `aggregate()` langsung dari core, jadi lulus
sempurna sementara tidak ada satu pun klien yang bisa menjangkaunya. 300 test
hijau, dua fitur mati. Test yang memanggil core langsung menguji *logika*;
hanya test yang lewat HTTP menguji *fitur*. Karena itu kedua test M19 menembak
port sungguhan, bukan memanggil fungsi.

**2. Error tsc yang dibiarkan menumpuk akan menelan peringatan asli.**
Dugaan awal jurnal ini keliru: TypeScript SEBENARNYA sudah menangkap bug
`expand` dengan `TS2353: 'expand' does not exist in type 'ListOptions'`. Pesan
itu tenggelam di antara 6 error lain yang sudah lama dibiarkan, sehingga
`tsc --noEmit` berhenti dipercaya. Type gate hanya berguna kalau angkanya nol —
satu error yang ditoleransi akan menyembunyikan error berikutnya.

**3. Pemeriksaan anti-regresi lebih baik daripada niat baik.**
Kedua suite M19 menutup dengan test yang membaca kode sumber dan memastikan
modul core benar-benar diimpor lapisan API. Kalau seseorang menghapus route-nya
nanti, test merah — bukan diam-diam kembali jadi modul yatim.

**4. Permintaan tidak masuk akal = 400, bukan 500.**
`?function=sum` tanpa `field` awalnya menembus ke core dan melempar Error biasa
→ 500. Itu menyalahkan server untuk kesalahan klien. Validasi dipindahkan ke
route, di kedua jalur (admin dan publik), supaya pesannya jelas dan statusnya
jujur.

---

## Yang belum dikerjakan

- **UI dashboard** untuk agregasi (panel di Database Studio) — core & REST siap,
  tinggal antarmuka.
- **HAVING** dan **window function** — SQLite mendukung keduanya, belum diekspos
  lewat REST. Ditunda sampai ada kebutuhan nyata.
- **Cache hasil agregasi** — belum perlu; SQLite lokal, tidak ada latensi
  jaringan seperti pada REST jarak jauh.

---

## Bagian 2 — UI Dashboard (Aggregations tab)

### Yang dibangun
- `dashboard/lib/api.ts` — `aggregateRecords()` + tipe `AggregateFunction`,
  `AggregateGroup`, `AggregateResult`.
- `dashboard/components/AggregatePanel.tsx` — query builder (function, field,
  group by, filter), live request preview, kartu hasil skalar, dan daftar grup
  dengan bar proporsional.
- Tab baru `🧮 Aggregations` di Database Studio, di antara API Rules dan
  Export / Import.

### Bukti dari browser sungguhan (bukan hanya build hijau)
```
Seed demo   : 40 record, SUM(amount) = 38.918
UI COUNT    → 40
UI SUM      → 38,918          (identik dengan seed)
UI GROUP BY → Surabaya 10,648 | Medan 9,827 | Bandung 9,292 | Jakarta 9,151
              (identik dengan hitungan seed per region)
Filter ngawur → pesan error tampil, halaman TIDAK crash
SUM tanpa field → tombol Run disabled
Layout      : 0 elemen overflow, bar sejajar (left=781 seragam),
              angka rata kanan (right=1169), card #FFFFFF radius 20px,
              input radius 9999px, bar #5B86E5
```

---

## Aha Moment #5 — Build hijau bukan bukti UI jalan

`npx next build` sukses, `tsc --noEmit` nol error, tapi begitu **GROUP BY**
dijalankan di browser sungguhan layar langsung berubah jadi:

```
Application error: a client-side exception has occurred
Uncaught TypeError: Cannot read properties of undefined (reading 'toUpperCase')
```

Penyebabnya: tipe `AggregateResult` di dashboard menjanjikan field `function`
dan `field` yang **tidak pernah dikirim server**. Server hanya mengembalikan
`{ value }` atau `{ groups }`. TypeScript percaya begitu saja karena tipe
respons HTTP adalah **janji, bukan fakta** — `request<AggregateResult>()` cuma
casting, tidak ada validasi runtime.

Pelajarannya: tipe di sisi klien untuk data yang datang dari jaringan harus
diturunkan dari **respons nyata**, bukan dari bentuk yang kita harapkan.
Christy memperbaikinya dengan menyempitkan tipe agar jujur, lalu menyimpan
konteks query di state (`ranQuery`) saat Run ditekan — sehingga label hasil
berasal dari apa yang benar-benar dikirim, bukan dari apa yang dikira diterima.

Efek samping yang menguntungkan: karena `ranQuery` di-set saat Run (bukan dibaca
dari dropdown saat render), mengubah dropdown setelah query selesai tidak lagi
membuat label salah menggambarkan angka yang sedang tampil.

---

## Aha Moment #6 — Verifikasi visual tanpa mata: ukur DOM

`vision_analyze` timeout dua kali, jadi pemeriksaan tampilan dilakukan dengan
mengukur geometri langsung lewat `getBoundingClientRect()`:

- **Overflow**: hitung elemen yang `right > viewport` → 0.
- **Keselarasan**: kumpulkan `left` semua bar → hanya satu nilai unik (781),
  artinya semua bar mulai di titik yang sama.
- **Rata kanan**: `right` semua angka → satu nilai unik (1169).
- **Palet**: baca `getComputedStyle` → `#FFFFFF` card, radius 20px, input pill
  9999px, bar `rgb(91,134,229)` = `#5B86E5`.

Angka-angka ini lebih tegas daripada penilaian "kelihatannya rapi": satu nilai
unik membuktikan kesejajaran, dua nilai membuktikan ada yang meleset.

---

## Aha Moment #7 — Request preview mengubah panel jadi alat belajar

Menampilkan baris `GET /api/.../aggregate?function=sum&field=amount&groupBy=region`
yang berubah live mengikuti dropdown membuat pengguna melihat persis apa yang
dikirim. Panel berhenti menjadi kotak ajaib: hasilnya bisa disalin ke curl atau
SDK, dan ketika terjadi error, orang bisa langsung menghubungkan pesan dengan
parameter yang salah. Untuk dashboard BaaS, transparansi request lebih berharga
daripada animasi.
