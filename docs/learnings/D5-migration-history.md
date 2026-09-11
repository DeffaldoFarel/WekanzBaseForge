# D5 — Migration History: Melacak Evolusi Skema

> **Konsep:** versioned schema, audit trail, dan reproducible schema changes.

## 🎯 Masalah yang Dipecahkan

Di D4 kita bisa mengubah skema dengan aman. Tapi di produksi yang berjalan berbulan-bulan, muncul pertanyaan:

- "Skema database ini sudah sampai versi berapa?"
- "Siapa/kapan menambahkan kolom `category` ke `habits`?"
- "Bagaimana bentuk skema `users` 3 bulan lalu?"
- "Kalau deploy ke server baru, bagaimana memastikan skemanya sama?"

Tanpa catatan, perubahan skema adalah "sejarah yang hilang" — dan itu berbahaya saat debugging atau deploy.

## 💡 Solusi: Tabel `_migrations`

Setiap perubahan skema dicatat sebagai record di tabel `_migrations`:

```
_migrations
┌────┬────────────┬──────────────┬────────────────────────┬─────────────────────┐
│ id │ collection │ action       │ changes (JSON)         │ applied_at          │
├────┼────────────┼──────────────┼────────────────────────┼─────────────────────┤
│ m1 │ habits     │ create       │ {fields:[...]}         │ 2026-09-11T10:00:00 │
│ m2 │ habits     │ add_column   │ {field:{name:'note'}}  │ 2026-09-11T11:00:00 │
│ m3 │ users      │ rebuild      │ {before:[], after:[]}  │ 2026-09-11T12:00:00 │
│ m4 │ habits     │ drop         │ {fields:[...]}         │ 2026-09-11T13:00:00 │
└────┴────────────┴──────────────┴────────────────────────┴─────────────────────┘
```

**Schema-as-data (M03) sekarang juga punya HISTORY-as-data!**

## 📐 Desain

### 1. Tabel `_migrations`
Dibuat otomatis saat initSchemaTable (seperti _collections).

### 2. Pencatatan otomatis
Setiap operasi skema mencatat migrasi:
- `defineCollection` → action 'create'
- `updateCollection` → action 'add_column'
- `rebuildCollection` → action 'rebuild' (dengan before/after)
- `deleteCollection` → action 'drop'

### 3. API membaca history
```typescript
getMigrations(db)                    // semua migrasi, urut waktu
getMigrations(db, 'habits')          // migrasi untuk collection tertentu
getSchemaVersion(db, 'habits')       // berapa kali habits berubah
```

## 📁 Perubahan

```
schema.ts       → _migrations table + recordMigration() + hook ke 4 operasi
tests/d5-migration-history.test.ts → bukti history tercatat dengan benar
```

## ✅ Definisi Selesai

- [ ] Tabel `_migrations` terbentuk otomatis
- [ ] create/add_column/rebuild/drop tercatat otomatis
- [ ] Migrasi rebuild mencatat before & after
- [ ] getMigrations mengembalikan urutan yang benar
- [ ] getMigrations per collection bekerja
- [ ] Test lulus + dokumentasi

## 📝 Aha! Moments

### Aha! #1 — Schema-as-data sekarang punya HISTORY-as-data
Di M03 kita belajar bahwa skema bisa disimpan sebagai data (_collections).
D5 menambah dimensi waktu: BUKAN hanya "bagaimana bentuk skema sekarang",
melainkan "bagaimana skema BERUBAH dari waktu ke waktu" (_migrations).
Ini pola yang sama seperti event sourcing — yang disimpan bukan hanya
state, tapi juga rangkaian perubahan yang mengantar ke state itu.

### Aha! #2 — History adalah syarat debuggability di produksi
Tanpa _migrations, menjawab "kapan kolom ini ditambahkan?" hampir mustahil
— kamu harus menebak dari data atau mencari di git history (kalau ada).
Dengan history, setiap perubahan punya jejak: apa, kapan, sebelum/sesudah.
Di produksi, kemampuan menelusuri "siapa mengubah apa" itu menyelamatkan
berjam-jam debugging.

### Aha! #3 — Rebuild mencatat before & after = snapshot perubahan
Migrasi rebuild menyimpan skema SEBELUM dan SESUDAH. Ini berarti kita bisa
merekonstruksi bentuk skema di TITIK MANAPUN dalam sejarah — bukan hanya
yang terbaru. Inilah dasar dari "schema versioning" yang sebenarnya.

### Aha! #4 — Pencatatan otomatis > pencatatan manual
Kita bisa saja meminta developer "ingat mencatat perubahan skema" — tapi
itu pasti terlupakan. Dengan mencatat OTOMATIS di dalam define/update/
rebuild/delete, history selalu akurat tanpa bergantung pada kedisiplinan.
Sistem yang baik membuat hal benar terjadi secara default.

### 🎉 D5 SELESAI — evolusi skema sekarang terkelola & terlacak
D4 membuat skema bisa berubah dengan aman; D5 membuat perubahan itu
tercatat dan bisa ditelusuri. Bersama-sama, evolusi skema di BaseForge
kini production-ready.

## ✅ Status: SELESAI (6/6 test D5, 97/97 total) — 2026-09-11
