# M16 — Menutup Gap SQL Database: Views, Field Types, Import/Export

> **Konsep:** tiga milestone pengejaran fitur PocketBase area SQL Database — view collections (M16a), field types baru (M16b), import/export JSON (M16c).

## M16a — View Collections

```
POST /api/admin/projects/:pid/views
{ "name": "order_stats", "viewQuery": "SELECT user, COUNT(*) AS total FROM orders GROUP BY user" }
```

- View = SQL view fisik (`CREATE VIEW`) + meta type='view'
- **Fields diekstrak sekali saat create** (dry-run + stmt.columns())
- Read = semua mekanisme normal: list, filter M04, pagination, rules!
- Write = ditolak `VIEW_READ_ONLY` (pesan ramah, bukan SQL error mentah)
- Delete = DROP VIEW (bukan DROP TABLE)
- ORDER BY default di-skip kalau view tak punya kolom `created`

## M16b — Field Types Baru

| Type | Simpan | Validasi | Khusus |
|------|--------|----------|--------|
| `editor` | TEXT | string | rich text HTML, sanitasi di client render |
| `geoPoint` | TEXT JSON | lat -90..90, lng -180..180, numeric | deserialize → object |
| `password` | TEXT scrypt hash | min 8, max 128 | **HASH saat write; field DIHAPUS dari semua response** (write-only!) |

Password field-level reuse hashPassword dari M08 — konsistensi kriptografi gratis.

## M16c — Import/Export JSON

```
GET  /api/admin/projects/:pid/collections/:name/export  → file .json
POST /api/admin/projects/:pid/collections/import
     { data: <json string|object>, mode: 'create'|'replace'|'merge' }
```

- Format self-describing: `{ format: 'baseforge-collection', version: 1, collection: {...}, records: [...] }`
- Mode `create` (default, aman) / `replace` (drop + import) / `merge` (upsert by id — sinkronisasi dua instance!)
- Password ter-export sebagai HASH (plain tidak pernah ada di mana pun)
- View di-export tanpa records (query dieksekusi ulang di tujuan)
- Field asing di-skip saat import (skema menang, tidak crash)

## 📝 Aha! Moments

### Aha! #1 — View: query dijalankan SEKALI (create-time), bukan per-request
Dry-run saat create: validasi SQL + ekstrak nama kolom hasil jadi fields
meta. Setelah itu view hidup sebagai `CREATE VIEW` fisik — SQLite yang
mengoptimalkan. Kesalahan umum yang dihindari: menjalankan "view query"
manual di tiap request list (double-parsing, tidak bisa di-index).

### Aha! #2 — Password field: hilang by construction
`deserializeRow` delete field password → TIDAK ADA code path yang bisa
membocorkan hash/plain. Bahkan export JSON berisi hash, bukan plain.
Konsisten dengan filosofi M08: hash tidak pernah keluar dari lapisan data.

### Aha! #3 — Merge mode = sync antar instance gratis
Upsert by id (INSERT OR REPLACE) membuat replikasi sederhana antar
project/instance jadi fitur 20 baris. Export dari VPS → import ke laptop
dengan mode merge = "pull changes" mini.

### Aha! #4 — listRecords DESC default menipu test
Test merge gagal karena items[0] adalah record TERBARU (Gula), bukan
Kopi yang di-update. Lesson: default ordering DESC harus disadari saat
menulis assertion — selalu pilih record eksplisit.

### Aha! #5 — DROP VIEW vs DROP TABLE
deleteCollection harus tahu type — kalau DROP TABLE ke view → error
"use DROP VIEW". Type metadata yang ditambah untuk fitur (M16a) otomatis
menyelamatkan fitur lain. Skema yang benar mencegah bug sebelum terjadi.

## ✅ Status: SELESAI — M16a 7/7, M16b+M16c 14/14, total 263/263 — 2026-09-12