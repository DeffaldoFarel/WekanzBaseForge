# Batch 1-3: Melengkapi Fitur Database Menuju ~90% PocketBase

> **Target:** Menutup gap fitur database yang tersisa, dengan memanfaatkan fondasi yang sudah kuat.

## BATCH 1: Field Types Baru (select, autodate, url)

### B1.1 Field `select`
Dropdown pilihan — nilai harus salah satu dari daftar `values`.
```typescript
{ name: 'status', type: 'select', options: { values: ['active','done','archived'] } }
// nilai harus salah satu dari values
```

### B1.2 Field `autodate`
Otomatis ter-update timestamp saat record dibuat/diubah.
```typescript
{ name: 'lastSeen', type: 'autodate', options: { onCreate: true, onUpdate: true } }
```

### B1.3 Field `url`
Validasi format URL (seperti email).
```typescript
{ name: 'website', type: 'url' }
// harus format http:// atau https:// yang valid
```

## BATCH 2: Backup & Restore

### B2.1 Backup database project
SQLite memudahkan backup: `VACUUM INTO 'backup.db'` atau copy file.
```
POST /api/admin/projects/:pid/backup → download .db
POST /api/admin/projects/:pid/restore → upload .db
```

## BATCH 3: Utilitas

### B3.1 Duplikasi collection
Copy schema (+ optional data) ke collection baru.

### B3.2 Batch API
Insert/update banyak record dalam 1 transaksi (M07!).
```
POST /api/admin/projects/:pid/collections/:name/records/batch
  body: { records: [...] } → insert semua atomik
```

---

## ✅ Definisi Selesai

Batch 1: select, autodate, url bekerja + tervalidasi + test ✅
Batch 2: backup & restore database bekerja + test ✅
Batch 3: duplikasi collection + batch insert bekerja + test ✅

---

## 📝 Hasil & Aha! Moments

### Hasil (angka nyata, 12 Sep 2026)

| Fitur | Hasil |
|-------|-------|
| Field `select` | ✅ Validasi terhadap `options.values` |
| Field `url` | ✅ Validasi http/https via `new URL()` |
| Field `autodate` | ✅ Auto-fill onCreate & onUpdate |
| Backup | ✅ `VACUUM INTO` — skema + data tersalin konsisten |
| Duplikasi collection | ✅ Skema (+opsional data) |
| Batch insert 2000 record | **1765ms → 267ms (6.6x lebih cepat)** |

### Aha! #1 — VACUUM INTO: backup yang benar-benar konsisten
SQLite punya satu perintah ajaib untuk backup: `VACUUM INTO 'file.db'`.
Ia membuat salinan database yang KONSISTEN (menghormati transaksi yang
sedang berjalan) sekaligus TERKOMPAK (defragmentasi). Bandingkan dengan
"copy file" biasa yang bisa menyalin file di tengah penulisan → corrupt.
Pelajaran: selalu pakai API resmi database untuk backup, jangan copy file
mentah.

### Aha! #2 — Field name harus lowercase (batasan yang mengejutkan)
Test Batch 1 awalnya gagal karena saya memakai `lastTouched` (camelCase).
Aturan nama field BaseForge (seperti PocketBase) hanya mengizinkan
`[a-z][a-z0-9_]*`. Ini BUKAN bug — ini pertahanan keamanan (nama field
masuk ke SQL langsung, tidak bisa lewat parameter binding). Aturan ketat
itu menyelamatkan dari SQL injection, dengan "biaya" konvensi penamaan.

### Aha! #3 — Batch insert: transaksi M07 terbayar kembali
Batch insert 2000 record: **6.6x lebih cepat** dari satu-per-satu. Ini
M02/M07 terulang lagi: yang mahal adalah fsync per operasi, dan transaksi
mengelompokkannya. Bedanya di sini kita membungkusnya jadi API yang
nyaman — dan ATOMIK (satu gagal, semua batal).

### Aha! #4 — Field type baru = ~15 menit kerja
Menambah `select`, `url`, `autodate` hanya butuh: (1) tambah ke FieldType
union, (2) mapping SQL, (3) validasi. Tiga tempat, ~15 menit per tipe.
Inilah hadiah dari arsitektur "fieldTypes sebagai sumber kebenaran" yang
kita rancang di M03. Desain yang baik membuat penambahan fitur jadi murah.

## ✅ Status: SELESAI — Batch 1-3 tuntas (126/126 test total) — 2026-09-12
