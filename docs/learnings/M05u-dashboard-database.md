# M05u 🖥️ — Dashboard: Schema Builder + Data Browser

> **Konsep yang dipelajari:** menghubungkan engine database (M03-M05) ke API REST, lalu ke UI visual. Saat "papan pengumuman" menjadi "alat kerja".

## 🎯 Tujuan Milestone

Membangun antarmuka visual untuk SQL Database yang sudah kita bangun — seperti PocketBase Admin UI:

1. **Schema Builder** — buat/edit collection & fields lewat UI (bukan kode)
2. **Data Browser** — lihat, tambah, edit, hapus records seperti spreadsheet

Ini adalah momen di mana BaseForge berhenti terasa seperti "latihan" dan mulai terasa seperti **produk**.

## 🧠 Arsitektur Alurnya

```
┌──────────────┐   HTTP    ┌──────────────┐   panggil   ┌─────────────────┐
│  Dashboard   │ ────────► │  Admin API   │ ──────────► │  Engine (M03-05) │
│  (Next.js)   │ ◄──────── │  (server)    │             │  schema.ts       │
│  schema UI   │   JSON    │  collections │             │  records.ts      │
│  data grid   │           │  records API │             │  query/          │
└──────────────┘           └──────────────┘             └─────────────────┘
                                                                  │
                                                           data/projects/
                                                             <id>/data.db
```

**Prinsip kunci (dari M00):** Dashboard hanyalah CLIENT dari Admin API. Apapun yang bisa dilakukan UI, bisa juga via API langsung.

## 📐 API Baru yang Dibangun (Admin API)

Semua butuh admin token (M00), dan beroperasi pada project tertentu:

```
# Collections (schema)
GET    /api/admin/projects/:pid/collections          → daftar collection
POST   /api/admin/projects/:pid/collections          → buat collection
GET    /api/admin/projects/:pid/collections/:name    → detail
DELETE /api/admin/projects/:pid/collections/:name    → hapus

# Records (data)
GET    /api/admin/projects/:pid/collections/:name/records?filter=&sort=&page=
POST   /api/admin/projects/:pid/collections/:name/records
PATCH  /api/admin/projects/:pid/collections/:name/records/:id
DELETE /api/admin/projects/:pid/collections/:name/records/:id
```

**Tantangan teknis:** server harus membuka database project yang benar (per `:pid`) dan meng-cache koneksinya (jangan buka-tutup setiap request). Ini pelajaran connection management!

## 🖥️ UI yang Dibangun (Dashboard)

### Halaman 1: Daftar Collections (`/projects/[id]/database`)
```
┌─────────────────────────────────────────────────┐
│  Database — wekanz                    [+ New]   │
├─────────────────────────────────────────────────┤
│  📦 habits          3 fields    12 records      │
│  📦 users           2 fields    2 records       │
│  📦 posts           3 fields    5 records       │
└─────────────────────────────────────────────────┘
```

### Halaman 2: Schema Builder (`.../database/[collection]/schema`)
```
┌─────────────────────────────────────────────────┐
│  Schema — habits                     [+ Field]  │
├─────────────────────────────────────────────────┤
│  Field    Type     Required                     │
│  ─────    ────     ────────                     │
│  title    text     ✓                            │
│  streak   number   ✗                            │
│  user     relation ✗   → users                  │
└─────────────────────────────────────────────────┘
```

### Halaman 3: Data Browser (`.../database/[collection]`)
```
┌─────────────────────────────────────────────────┐
│  Records — habits                   [+ Record]  │
│  filter: [streak > 5____________] [Apply]       │
├─────────────────────────────────────────────────┤
│  id     title      streak  done   created       │
│  ────   ─────      ──────  ────   ───────       │
│  h1     Olahraga   7       true   2026-09-11    │
│  h2     Baca       3       false  ...           │
│  (klik baris → edit inline / modal)             │
├─────────────────────────────────────────────────┤
│  ◀ Prev   Page 1 of 2   Next ▶                  │
└─────────────────────────────────────────────────┘
```

## ✅ Definisi Selesai

- [ ] Admin API collections CRUD bekerja (test curl)
- [ ] Admin API records CRUD + filter bekerja (test curl)
- [ ] Koneksi DB project di-cache dengan benar
- [ ] UI: daftar collections tampil
- [ ] UI: buat collection baru lewat form
- [ ] UI: data browser menampilkan records dalam tabel
- [ ] UI: tambah/edit/hapus record lewat UI
- [ ] UI: filter bekerja dari textbox
- [ ] Test API lulus + UI diverifikasi di browser

## 📝 Aha! Moments

### Yang diverifikasi bekerja end-to-end (11 Sep 2026)

✅ Admin API: collections CRUD + records CRUD + filter (test curl)
✅ Koneksi DB project di-cache (projectDbManager)
✅ UI: daftar collections dengan recordCount
✅ UI: buat collection lewat modal form (schema builder)
✅ UI: data browser — tabel records dengan kolom dinamis
✅ UI: bool ter-deserialize (true/false, bukan 1/0)
✅ UI: filter `streak > 5` lewat textbox → hanya 2/3 records tampil
✅ UI: pagination, tambah/edit/hapus record lewat modal

### Aha! #1 — Setiap lapisan yang kita bangun terhubung jadi satu
Momen paling memuaskan: mengetik `streak > 5` di textbox lalu tabel
terfilter. Di balik itu ada RANTAI panjang yang semuanya kita bangun:
UI form → fetch API → router (M00) → Admin API → query parser (M04,
compiler mini kita!) → record API (M05) → SQLite → deserialize → JSON →
render tabel. Satu ketikan sederhana melibatkan ENAM lapisan — dan semua
bekerja karena setiap lapisan dirancang dengan kontrak yang jelas.

### Aha! #2 — Connection caching itu penting di dunia nyata
Tanpa projectDbManager, setiap request akan membuka file SQLite baru
(puluhan ms per request + risiko lock). Dengan cache: buka sekali, pakai
berulang. Ini versi sederhana dari "connection pooling" yang dipakai
semua sistem production — dan kita merasakan KENAPA ia ada.

### Aha! #3 — Dashboard hanyalah CLIENT dari API
Halaman database ini tidak punya akses khusus ke database — ia memanggil
REST API yang sama persis dengan yang bisa dipanggil curl. Inilah desain
yang benar: API dulu, UI kemudian. Kalau besok kita ganti dashboard
dengan framework lain, backend tidak perlu berubah sama sekali.

### Aha! #4 — "Produk" muncul saat backend dan UI bertemu
Selama M01-M07 kita membangun "mesin" yang kuat tapi tak terlihat.
M05u adalah saat mesin itu mendapat WAJAH — dan tiba-tiba BaseForge
terasa seperti PocketBase sungguhan. Pelajaran: nilai sebuah sistem
baru terasa lengkap saat semua lapisannya terhubung menjadi pengalaman
yang utuh.

### 🎉 BaseForge sekarang punya: Platform + Database + Admin UI!
Persis seperti PocketBase: install → buka admin → buat collection →
kelola data. Dan semuanya kita bangun dari nol dengan pemahaman penuh.

## ✅ Status: SELESAI (API 100% bekerja, UI diverifikasi di browser) — 2026-09-11
