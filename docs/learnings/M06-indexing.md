# M06 — Indexing: Daftar Isi untuk Database

> **Konsep yang dipelajari:** B-Tree, bagaimana index mempercepat pencarian, EXPLAIN QUERY PLAN, dan trade-off index pada write.

## 🎯 Tujuan Milestone

Memahami **kenapa index membuat pencarian ratusan kali lebih cepat** — bukan dari teori, melainkan dengan MEMBUKTIKANNYA lewat benchmark: query yang sama, dengan dan tanpa index, pada data yang besar.

Ini menjawab "keluhan #3" dari M01: *"pencarian harus membaca semua"*.

## 🧠 Analogi Inti: Daftar Isi Buku

```
TANPA INDEX (full scan):
  Mencari kata "zebra" di kamus = baca dari halaman 1 sampai ketemu.
  1000 halaman = baca sampai 1000 halaman.

DENGAN INDEX (B-Tree):
  Kamus sudah urut A-Z. "zebra" → langsung lompat ke Z.
  1000 halaman = baca ~3-10 halaman saja (log N).
```

Index adalah **struktur data terpisah yang terurut**, memungkinkan database melompat langsung ke data yang relevan alih-alih membaca semuanya.

## 🌳 B-Tree Sekilas (cukup untuk memahami)

```
            [M]
           /   \
      [E]         [T]
     / | \       / | \
   A..D F..L   N..S U..Z

Mencari 'streak = 7':
  → mulai di root, turun ke cabang yang tepat
  → ~3 lompatan untuk 1 juta record (bukan 1 juta baca!)

Kompleksitas: O(log N) vs O(N) full scan
  N = 1.000.000 → log N ≈ 20.  Itulah kenapa 100-1000x lebih cepat.
```

## 🔍 EXPLAIN QUERY PLAN — "mata" database

SQLite bisa MENUNJUKKAN cara dia mengeksekusi query:

```sql
EXPLAIN QUERY PLAN SELECT * FROM habits WHERE streak > 5;

-- Tanpa index:  SCAN habits            ← membaca SEMUA baris 😱
-- Dengan index: SEARCH habits USING INDEX idx_streak (streak>?)  ✨
```

Kata kunci:
- `SCAN` = full scan (baca semua) — lambat untuk data besar
- `SEARCH ... USING INDEX` = pakai index — cepat!

## 📐 Yang Dibangun di M06

### 1. Definisi index di skema collection
```typescript
defineCollection(db, {
  name: 'habits',
  fields: [...],
  indexes: [
    { name: 'idx_streak', fields: ['streak'] },           // single
    { name: 'idx_user_streak', fields: ['user', 'streak'] }, // composite
  ],
});
// → CREATE INDEX idx_streak ON habits (streak)
```

### 2. Benchmark yang membuktikan
```
Query streak > X pada 50.000 record:
  Tanpa index : ??? ms (SCAN)
  Dengan index: ??? ms (SEARCH)
  Percepat    : ??? x
```

### 3. Trade-off: index memperlambat WRITE
Setiap INSERT/UPDATE harus juga mengupdate index.
Buktikan: insert dengan 3 index vs tanpa index.

## ⚠️ Kapan Index TIDAK Dipakai (edge cases penting!)

Index bisa "tidak terpakai" oleh optimizer:
- `WHERE streak * 2 > 10` — fungsi/operasi pada kolom
- `WHERE title LIKE '%abc'` — wildcard di AWAL (tidak bisa pakai urutan)
- Tabel terlalu kecil — full scan lebih murah

## 📁 File yang Dibangun

```
server/src/core/
└── schema.ts       (tambah: indexes di definisi + CREATE INDEX)
server/tests/
└── m06-index.test.ts  (benchmark dengan/tanpa index + EXPLAIN)
docs/learnings/
└── M06-indexing.md  ← jurnal ini
```

## ✅ Definisi Selesai

- [ ] Index bisa didefinisikan di skema collection → CREATE INDEX terbentuk
- [ ] EXPLAIN QUERY PLAN menunjukkan SCAN (tanpa index) vs SEARCH (dengan)
- [ ] Benchmark membuktikan percepatan nyata pada 50.000+ record
- [ ] Trade-off write terukur
- [ ] Composite index bekerja
- [ ] Test lulus + jurnal diisi

## 📝 Hasil Benchmark & Aha! Moments

### Hasil benchmark (angka nyata, 11 Sep 2026)

| Eksperimen | Tanpa Index | Dengan Index | Selisih |
|-----------|-------------|--------------|---------|
| Query streak>95 dari 100rb record | 11.02ms (SCAN) | 0.038ms (SEARCH) | **291x lebih cepat** |
| INSERT 20rb record | 82ms | 120ms (3 index) | 47% lebih lambat |
| Biaya membuat index | — | 34ms (sekali) | investasi awal |

### Aha! #1 — 291x lebih cepat dari SATU baris CREATE INDEX
Query yang sama, data yang sama, hasil yang sama — satu-satunya bedanya
ada index. Dari membaca 100.000 baris menjadi melompat langsung ke
~4.000 baris yang relevan. Inilah kenapa "tambah index" adalah optimasi
database #1 paling berdampak di dunia nyata — dan kenapa query lambat
hampir selalu berarti "kurang index".

### Aha! #2 — EXPLAIN QUERY PLAN adalah mata database
Sebelum M06, "apakah query saya pakai index?" adalah tebakan. Sekarang
kita bisa MELIHAT: `SCAN` (baca semua, buruk untuk data besar) vs
`SEARCH USING INDEX` (bagus). Setiap kali ada query lambat, EXPLAIN
adalah alat diagnosis pertama — dan dia selalu jujur.

### Aha! #3 — Index itu trade-off, bukan sihir gratis
3 index membuat INSERT 47% lebih lambat — karena setiap perubahan data
harus juga mengupdate SEMUA index-nya. Pelajaran desain: indexlah kolom
yang sering muncul di WHERE/ORDER BY, dan TAHAN diri untuk kolom yang
jarang di-query. Index adalah investasi yang dibayar setiap write,
dipanen setiap read.

### Aha! #4 — log N vs N adalah perbedaan yang mengubah segalanya
Full scan = O(N): 100rb record = 100rb langkah. Index B-Tree = O(log N):
100rb record ≈ 17 langkah. 1 juta record ≈ 20 langkah. Inilah mengapa
database bisa "instan" bahkan pada data raksasa — dan mengapa
struktur data (B-Tree) adalah salah satu penemuan terpenting dalam
ilmu komputer.

### Jembatan ke M07
Sekarang query sudah cepat. Tapi ada pertanyaan tersisa dari M01/M02:
"bagaimana SQLite BENAR-BENAR menjamin data tidak corrupt saat crash?"
Kita sudah menyentuh transaksi — sekarang saatnya masuk ke dalam:
WAL, atomicity, dan crash recovery. Itulah M07.

## ✅ Status: SELESAI (6/6 test M06, 57/57 total) — 2026-09-11
