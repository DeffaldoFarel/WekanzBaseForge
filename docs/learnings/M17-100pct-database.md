# M17 — 100% Gap SQL Database: Any-Match Operator + FTS5

> **Konsep:** dua fitur penutup gap terakhir — operator `?` any-match (multi-value matching ala PocketBase) dan FTS5 full-text search.

## M17a — Any-Match Operator

```
tags ?= "minuman"     → AT LEAST ONE elemen = "minuman"
tags ?!= "minuman"    → TIDAK ADA elemen = "minuman"
tags ?~ "sehat"       → elemen mengandung "sehat"
tags ?!~ "sehat"      → tidak ada elemen mengandung
tags ?> 5, ?>=, ?<, ?<= → perbandingan elemen
```

Implementasi: `json_each` (SQLite JSON1) — array di-expand per elemen:
```sql
EXISTS (SELECT 1 FROM json_each("tags") WHERE json_each.value = ?)
```
Parameterized → anti-injection warisan M04 tetap utuh. Bekerja untuk
multi-relation (array id), json field, select multi.

## M17b — FTS5 Full-Text Search

```
// Definisi: field dengan options.fulltext = true di-index
{ name: 'title', type: 'text', options: { fulltext: true } }

// Pencarian:
GET .../records?search=kopi gayo
```

- Tabel virtual `_fts_<collection>` + 3 TRIGGERS (INSERT/UPDATE/DELETE)
  → sinkron otomatis DI DALAM transaksi write (atomik by construction!)
- Query sanitasi: `"kopi" "gayo"*` — quote per token (aman dari operator
  FTS asing), prefix `*` di token terakhir
- `search` digabung dengan filter M04 AND rules M11 (params ordering:
  rule/filter params dulu, MATCH param belakangan)
- Collection tanpa field fulltext → param search diabaikan (no crash)
- deleteCollection → drop FTS table + 3 triggers

## 📝 Aha! Moments

### Aha! #1 — FTS5 delete-command vs DELETE biasa
Dokumentasi FTS5 menyarankan special command `INSERT INTO fts(fts, ...)
VALUES ('delete', ...)` — TAPI itu untuk contentless table dan butuh
nilai kolom lama persis. Untuk table normal: `DELETE FROM fts WHERE
record_id = ?` cukup — dan jauh lebih sederhana. Baca dua path, pilih
yang benar untuk arsitekturmu (jangan tiru buta).

### Aha! #2 — Trigger sinkron = atomic by construction
FTS index di-update via trigger SQLite → berjalan DI DALAM transaksi
write (M07!). Record tersimpan tapi index gagal = transaksi ROLLBACK —
tidak ada index out-of-sync. Alternatif (sync manual di API layer)
rentan lupa/mati di tengah.

### Aha! #3 — Parameter ordering: SQL placeholder harus sinkron dengan array
Bug klasik: rules/filter params ditambah SEBELUM search param di array,
tapi kita concat `searchParams dulu`. WHERE rule (?1) menerima nilai
search (?2) → hasil salah diam-diam. Lesson: urutan placeholder = urutan
array — gambar dulu WHERE-nya baru concat param searah.

### Aha! #4 — json_each = array di SQL tanpa tabel relasi
Multi-value matching biasanya butuh tabel junction. json_each mengubah
kolom JSON jadi baris sementara — array matching dalam SATU query tanpa
JOIN fisik. SQLite JSON1 = senjata tersembunyi.

## ✅ Status: SELESAI — 16/16 test M17, 279/279 total — SQL Database = 100% PocketBase-parity (untuk fitur harian) — 2026-09-12