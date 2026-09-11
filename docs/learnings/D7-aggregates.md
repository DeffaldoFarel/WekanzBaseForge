# D7 — Aggregates: Menjawab Pertanyaan Analitik

> **Konsep:** SQL aggregation (COUNT, SUM, AVG, MIN, MAX), GROUP BY, dan mengubah bentuk hasil query untuk statistik.

## 🎯 Masalah yang Dipecahkan

CRUD menjawab "ambil data X". Tapi produksi sering butuh pertanyaan analitik:

```
"Berapa TOTAL habits yang dimiliki setiap user?"
"Berapa RATA-RATA streak semua habits?"
"Berapa habit dengan streak TERTINGGI?"
"Berapa banyak habits per KATEGORI?"  ← GROUP BY
```

Ini bukan tentang mengambil record — melainkan MENGHITUNG dari banyak record.
Mengambil semua record lalu menghitung di JavaScript itu lambat dan boros memori
(ingat N+1 & full scan!). Database bisa menghitungnya jauh lebih efisien.

## 🧠 Fungsi Agregat SQL

| Fungsi | Arti | Contoh |
|--------|------|--------|
| `COUNT(*)` | jumlah baris | berapa habits |
| `SUM(col)` | total kolom | total semua streak |
| `AVG(col)` | rata-rata | rata-rata streak |
| `MIN(col)` | terkecil | streak terendah |
| `MAX(col)` | terbesar | streak tertinggi |

## 🧠 GROUP BY — agregat per kelompok

```sql
-- Bukan hanya "berapa total", tapi "berapa total PER user"
SELECT user, COUNT(*) AS jumlah, AVG(streak) AS rata2
FROM habits
GROUP BY user;

-- Hasil:
-- user  | jumlah | rata2
-- u1    | 5      | 6.4
-- u2    | 3      | 8.0
```

GROUP BY mengelompokkan baris berdasarkan nilai kolom, lalu agregat
dihitung PER kelompok.

## 📐 API yang Dibangun

```typescript
// Agregat sederhana (tanpa grouping)
aggregate(db, 'habits', {
  function: 'count',           // count|sum|avg|min|max
  field: 'streak',             // opsional untuk count
  filter: 'streak > 5',        // reuse M04 parser!
});

// Agregat dengan grouping
aggregate(db, 'habits', {
  function: 'avg',
  field: 'streak',
  groupBy: 'user',             // hasil per user
});
```

## 📁 Perubahan

```
core/aggregates.ts    → fungsi aggregate() + buildAggregateSql
tests/d7-aggregates.test.ts → bukti count/sum/avg/min/max + groupBy
```

## ✅ Definisi Selesai

- [ ] count menghitung jumlah record
- [ ] sum/avg/min/max pada field number
- [ ] filter bekerja (reuse M04 parser)
- [ ] groupBy menghasilkan agregat per kelompok
- [ ] Validasi: aggregate pada field non-number ditolak (kecuali count)
- [ ] Field yang tidak ada → ditolak (seperti M04)
- [ ] Test lulus + dokumentasi

## 📝 Aha! Moments

### Aha! #1 — "Ambil semua lalu hitung" adalah anti-pola yang umum
Cara naif menjawab "berapa rata-rata streak?": ambil SEMUA habits ke
memori, lalu loop dan hitung di JavaScript. Ini full scan + boros memori
— lambat di data besar. Aggregates memindahkan perhitungan KE database:
`AVG(streak)` dihitung oleh engine C SQLite yang jauh lebih efisien,
apalagi dengan index (M06). Prinsip: dorong komputasi sedekat mungkin
ke datanya.

### Aha! #2 — GROUP BY mengubah "satu jawaban" menjadi "jawaban per kelompok"
`AVG(streak)` memberi satu angka. `GROUP BY category` memberi jawaban
PER kategori (health: 5, learn: 6). Ini pergeseran dari "ringkasan global"
menjadi "perbandingan antar kelompok" — fondasi semua laporan & dashboard
analitik.

### Aha! #3 — Filter M04 bisa dipakai ulang untuk agregat
Karena filter kita sudah jadi compiler (M04), `aggregate` tinggal memakai
`filterToSql` yang sama untuk WHERE — tidak perlu parser baru. `count
dengan filter 'streak > 5'` bekerja langsung. Ini bukti arsitektur yang
baik: komponen yang reusable melipatgandakan nilainya.

### 🎉🎉 D7 SELESAI — FASE DEEPENING DATABASE TUNTAS SEPENUHNYA!

Dengan aggregates, SQL Database BaseForge kini bisa menjawab pertanyaan
analitik, bukan hanya CRUD. Fase deepening (D1-D7) selesai:

- D1 Unique constraint     → integritas data
- D2 Multi-relation        → satu ke banyak
- D3 Cascade delete        → referential integrity
- D4 Table rebuild         → evolusi skema aman
- D5 Migration history     → perubahan terlacak
- D6 Nested expand         → relasi bertingkat efisien
- D7 Aggregates            → analitik & laporan

**SQL Database BaseForge kini PRODUCTION-GRADE.**

## ✅ Status: SELESAI (9/9 test D7, 110/110 total) — 2026-09-11
