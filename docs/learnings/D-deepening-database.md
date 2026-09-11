# Deepening SQL Database — Menuju Production-Grade

> **Tujuan:** Mengangkat SQL Database BaseForge dari "belajar" ke "siap produksi".
> Setiap fitur dibangun dengan pemahaman, diuji dengan test, dan terdokumentasi.

## 🎯 Prinsip

Karena ini akan dipakai produksi, standarnya naik:
1. **Kebenaran di atas kecepatan** — data tidak boleh corrupt/salah
2. **Migrasi yang aman** — skema berubah tanpa kehilangan data
3. **Teruji** — setiap fitur punya test yang membuktikan kebenarannya

---

## 📋 Roadmap Deepening (urutan prioritas)

### 🔴 Prioritas 1: Integritas Data (fondasi produksi)

#### D1. Unique Constraint
```
Masalah: dua user dengan email sama? Data ambigu!
Solusi: field unique → UNIQUE constraint di SQLite + error yang jelas

defineCollection({
  name: 'users',
  fields: [{ name: 'email', type: 'email', unique: true }]
})
// INSERT email duplikat → error "email sudah dipakai"
```
Konsep: unique index, race condition pada insert, error handling yang ramah.

#### D2. Multi-Relation (1 field → banyak record)
```
Masalah: satu post punya BANYAK tags. Satu field relation tidak cukup.
Solusi: relation array → disimpan sebagai JSON array of ids

{ name: 'tags', type: 'relation', options: { collectionId: 'tags', maxSelect: 5 } }
// nilai: ['tag1', 'tag2', 'tag3']
```
Konsep: single vs multi relation, expand array, maxSelect validation.

#### D3. Cascade Delete
```
Masalah: hapus user → habits-nya jadi "yatim" (menunjuk user yang sudah tidak ada)
Solusi: 3 opsi saat relasi dihapus:
  - cascade: hapus juga record yang merujuk
  - setNull: kosongkan field relasinya
  - restrict: TOLAK penghapusan kalau masih ada yang merujuk
```
Konsep: referential integrity, orphan records, delete strategies.

---

### 🟡 Prioritas 2: Evolusi Skema (production pasti berubah)

#### D4. Table Rebuild (ubah/hapus kolom dengan aman)
```
Masalah: SQLite tidak bisa DROP/ALTER kolom. Tapi production butuh!
Solusi: pola "rebuild":
  1. CREATE TABLE baru dengan skema baru
  2. COPY data dari tabel lama (dengan transformasi)
  3. DROP tabel lama
  4. RENAME tabel baru
  5. Semua dalam SATU transaksi (aman dari crash!)
```
Konsep: schema evolution, data migration, zero-downtime thinking.

#### D5. Migration History
```
Masalah: bagaimana tahu skema sudah sampai versi berapa?
Solusi: tabel _migrations yang mencatat setiap perubahan
  - id, name, applied_at, checksum
  - bisa rollback / re-apply
```
Konsep: versioned schema, reproducible deployments.

---

### 🟢 Prioritas 3: Query Lanjutan (menyusul kebutuhan)

#### D6. Nested Expand Multi-Level (a.b.c)
```
Saat ini: expand 'user' (1 level) ✓
Target: expand 'author.profile.city' (rekursif)
```
Konsep: rekursi dalam batch loading, tetap hindari N+1 di setiap level.

#### D7. Aggregate Queries (COUNT, SUM, AVG, GROUP BY)
```
listRecords dengan aggregate:
  → stats per collection
  → GROUP BY untuk laporan
```
Konsep: SQL aggregation, mengubah bentuk hasil query.

---

## 📊 Estimasi & Urutan Kerja

| # | Fitur | Estimasi | Dampak Produksi | Status |
|---|-------|----------|-----------------|--------|
| D1 | Unique constraint | 1-2 jam | 🔴 Tinggi | ✅ SELESAI (7 test) |
| D2 | Multi-relation | 2-3 jam | 🔴 Tinggi | ✅ SELESAI (7 test) |
| D3 | Cascade delete | 2-3 jam | 🔴 Tinggi | ✅ SELESAI (6 test) |
| D4 | Table rebuild | 2-3 jam | 🟡 Tinggi | ✅ SELESAI (5 test) |
| D5 | Migration history | 2 jam | 🟡 Sedang | ⬅ BERIKUTNYA |
| D6 | Nested expand | 1-2 jam | 🟡 Sedang | |
| D7 | Aggregates | 2 jam | 🟢 Sedang | |

**Urutan kerja yang disarankan:** D1 → D2 → D3 → D4 → D5 → D6 → D7

---

## ✅ Definisi "Production-Ready" untuk SQL Database

Selesai deepening ini ketika:
- [ ] Email/username tidak bisa duplikat (unique)
- [ ] Satu record bisa punya banyak relasi (multi-relation)
- [ ] Hapus data induk tidak meninggalkan yatim (cascade)
- [ ] Skema bisa berubah tanpa kehilangan data (rebuild + migration)
- [ ] Expand bisa bertingkat (nested)
- [ ] Semua teruji dengan test lulus
