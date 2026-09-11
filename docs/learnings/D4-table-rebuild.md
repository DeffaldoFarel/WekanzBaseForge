# D4 — Table Rebuild: Mengubah Skema Tanpa Kehilangan Data

> **Konsep:** schema evolution, data migration, dan pola "rebuild" untuk mengubah/menghapus kolom yang tidak bisa dilakukan SQLite secara langsung.

## 🎯 Masalah yang Dipecahkan

Di M03 kita menemukan batasan keras SQLite:
```sql
ALTER TABLE habits DROP COLUMN streak;     -- ❌ SQLite tidak bisa (versi lama)
ALTER TABLE habits ALTER streak TO TEXT;   -- ❌ tidak bisa ubah tipe
```

Tapi di produksi, kebutuhan ini PASTI muncul:
- "Field `streak` tidak dipakai lagi, hapus saja"
- "Field `score` harusnya TEXT, bukan NUMBER"
- "Field `title` harusnya required"

Bagaimana mengubah skema TANPA kehilangan data yang sudah ada?

## 💡 Solusi: Pola "Rebuild" (cara SQLite resmi & PocketBase)

Alih-alih mengubah tabel yang ada, kita **membangun tabel baru yang benar, memindahkan data, lalu menukar**:

```
LANGKAH (semua dalam SATU transaksi — M07!):

1. CREATE TABLE habits_new (dengan skema BARU)
2. INSERT INTO habits_new SELECT ... FROM habits
      (copy data, dengan transformasi kalau perlu)
3. DROP TABLE habits
4. ALTER TABLE habits_new RENAME TO habits
5. Update definisi di _collections
6. COMMIT
```

Kalau ada yang gagal di tengah → ROLLBACK → tabel lama utuh, tidak ada
data yang hilang. Inilah kenapa transaksi (M07) sangat penting.

## 🧠 Tiga Skenario Perubahan

### Skenario A: Hapus kolom
```
Lama: id, title, streak, note
Baru: id, title, note         (streak dihapus)
Copy: INSERT INTO new SELECT id, title, note FROM old
      (kolom streak tidak di-copy → hilang dengan aman)
```

### Skenario B: Ubah tipe kolom
```
Lama: streak REAL
Baru: streak TEXT
Copy: INSERT INTO new SELECT id, title, CAST(streak AS TEXT) FROM old
      (nilai dikonversi saat copy)
```

### Skenario C: Tambah kolom required
```
Lama: id, title
Baru: id, title, category TEXT NOT NULL DEFAULT 'general'
Copy: INSERT INTO new SELECT id, title, 'general' FROM old
      (kolom baru diisi default untuk data lama)
```

## ⚠️ Tantangan Khusus

1. **Index harus dibuat ulang** — DROP TABLE menghapus index-nya juga
2. **Foreign key / relasi** — collection lain yang menunjuk ke sini tidak terpengaruh (id tetap sama), tapi harus hati-hati
3. **Semua dalam transaksi** — crash di tengah tidak boleh meninggalkan keadaan aneh
4. **Kolom yang cocok** — hanya copy kolom yang ada di KEDUA skema (lama & baru)

## 📐 API

```typescript
// Mengganti seluruh definisi fields (bisa hapus/ubah/tambah kolom)
rebuildCollection(db, 'habits', {
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'note', type: 'text' },
    // streak dihapus; title jadi required
  ],
});
```

## 📁 Perubahan

```
schema.ts       → rebuildCollection() dengan pola rebuild + transaksi
tests/d4-table-rebuild.test.ts → bukti ketiga skenario + data selamat
```

## ✅ Definisi Selesai

- [ ] Hapus kolom → kolom hilang, data kolom lain selamat
- [ ] Ubah tipe kolom → nilai dikonversi
- [ ] Tambah kolom required → data lama terisi default
- [ ] Index dibuat ulang setelah rebuild
- [ ] Semua dalam transaksi (gagal → data lama utuh)
- [ ] _collections ter-update
- [ ] Test lulus + dokumentasi

## 📝 Aha! Moments

### Aha! #1 — Mengubah skema itu operasi yang lebih berbahaya dari kelihatannya
Sepintas "ubah tipe kolom" terdengar sepele. Tapi SQLite tidak bisa — jadi
kita harus: buat tabel baru, copy dengan transformasi, hapus yang lama,
rename, buat ulang index. Satu "ubah skema" ternyata 6 langkah yang
masing-masing bisa gagal. Inilah kenapa migrasi database adalah operasi
paling menegangkan di produksi.

### Aha! #2 — Transaksi adalah jaring pengaman migrasi
Kalau rebuild gagal di langkah ke-4 (misalnya nama bentrok), tanpa
transaksi kita sudah kehilangan tabel lama tapi belum punya yang baru —
data hilang! Dengan membungkus semuanya dalam BEGIN/COMMIT: gagal di
manapun → ROLLBACK → tabel lama utuh. Migrasi yang aman = migrasi yang
atomik.

### Aha! #3 — Konversi tipe itu penuh jebakan kecil
`CAST(42 AS TEXT)` menghasilkan `"42.0"` bukan `"42"` — karena SQLite
menyimpan number sebagai REAL. Detail kecil seperti ini bisa merusak
data di produksi (bayangkan semua ID berubah jadi "123.0"!). Solusinya
`printf('%g', ...)`. Pelajaran: konversi tipe harus diuji dengan nilai
nyata, bukan diasumsikan.

### Aha! #4 — Index itu "milik tabel", bukan "milik skema"
Saat DROP TABLE, index ikut hilang — jadi setelah rebuild kita harus
membuatnya ulang (unique D1 + custom M06). Mudah dilupakan, dan kalau
lupa: query tiba-tiba lambat tanpa sebab jelas, dan unique constraint
berhenti menegakkan. D4 test membuktikan unique tetap bekerja setelah
rebuild.

### 🎉 D4 SELESAI — skema bisa berevolusi dengan aman
Batasan "SQLite tidak bisa ubah kolom" yang kita temui di M03 sekarang
terpecahkan. Skema BaseForge bisa tumbuh mengikuti kebutuhan tanpa
kehilangan data — syarat mutlak produksi jangka panjang.

## ✅ Status: SELESAI (5/5 test D4, 91/91 total) — 2026-09-11
