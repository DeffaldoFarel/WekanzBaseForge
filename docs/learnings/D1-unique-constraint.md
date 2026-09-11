# D1 — Unique Constraint: Mencegah Data Duplikat

> **Konsep:** unique index, race condition pada insert, dan error handling yang ramah untuk produksi.

## 🎯 Masalah yang Dipecahkan

```typescript
// Tanpa unique constraint, ini BISA terjadi:
createRecord('users', { email: 'farel@x.com', name: 'Farel' });
createRecord('users', { email: 'farel@x.com', name: 'Farel Palsu' });
// → DUA user dengan email sama! Login jadi ambigu. 💀
```

Di produksi, duplikat pada field identitas (email, username) adalah bencana.
Unique constraint membuat database MENOLAK duplikat di level mesin — bukan
hanya di kode aplikasi (yang bisa dilewati).

## 🧠 Kenapa Validasi di Kode Tidak Cukup?

```typescript
// ❌ RENTAN race condition:
const existing = getUserByEmail(email);  // cek dulu
if (!existing) createUser(email);        // baru buat

// Dua request bersamaan:
//   Request A: cek → tidak ada → (belum sempat buat)
//   Request B: cek → tidak ada → (belum sempat buat)
//   Request A: buat ✓
//   Request B: buat ✓  ← DUPLIKAT terjadi!
```

Satu-satunya pertahanan yang benar: **UNIQUE constraint di database itu
sendiri** — mesin SQLite yang menegakkannya secara atomik, tidak bisa
dilewati oleh race condition.

## 📐 Desain

### 1. Tambah `unique` ke FieldDefinition
```typescript
{ name: 'email', type: 'email', required: true, unique: true }
```

### 2. Generate UNIQUE INDEX saat membuat collection
```sql
CREATE UNIQUE INDEX idx_users_email_unique ON users (email);
-- SQLite otomatis menolak INSERT/UPDATE yang duplikat
```

### 3. Tangkap error constraint → pesan yang RAMAH
```
SQLite error mentah:
  "UNIQUE constraint failed: users.email"  ← jelek untuk user

Pesan ramah untuk produksi:
  "Email 'farel@x.com' sudah digunakan"
```
Konsep: menerjemahkan error mesin menjadi pesan yang bisa ditampilkan
ke user. Ini penting untuk produksi (target skenario A & C).

## 📁 Perubahan

```
fieldTypes.ts   → tambah `unique?: boolean` + validasi
schema.ts       → generate UNIQUE INDEX untuk field unique
records.ts      → tangkap UNIQUE constraint error → pesan ramah
tests/d1-unique.test.ts → bukti duplikat ditolak + race condition aman
```

## ✅ Definisi Selesai

- [ ] Field bisa didefinisikan `unique: true`
- [ ] UNIQUE INDEX terbentuk di SQLite
- [ ] INSERT duplikat → ditolak dengan pesan ramah
- [ ] UPDATE menjadi nilai duplikat → ditolak
- [ ] Field TIDAK unique → tetap boleh duplikat (kontrol)
- [ ] Pesan error menyebut field & nilai yang duplikat
- [ ] Test lulus + dokumentasi

## 📝 Aha! Moments

### Aha! #1 — Keunikan harus ditegakkan oleh MESIN, bukan kode
Pelajaran terpenting D1: validasi "cek dulu baru buat" di kode aplikasi
SELALU bisa ditembus race condition (dua request cek bersamaan, dua-duanya
lolos, dua-duanya buat → duplikat). Satu-satunya pertahanan yang benar
adalah UNIQUE INDEX di database itu sendiri — ditegakkan secara atomik
oleh mesin SQLite, tidak bisa dilewati. E5 membuktikannya: dua insert
"bersamaan", hanya satu yang tersimpan.

### Aha! #2 — Error mesin ≠ pesan untuk user
SQLite melempar `"UNIQUE constraint failed: users.email"` — akurat tapi
jelek untuk ditampilkan ke user. Untuk produksi (target skenario A & C),
kita menerjemahkannya menjadi: `"Nilai 'farel@x.com' sudah digunakan
untuk field 'email' (harus unik)"`. Lapisan penerjemah error ini kecil
tapi menentukan pengalaman pengguna. Sistem yang baik berbicara dalam
bahasa penggunanya.

### Aha! #3 — DuplicateError sebagai tipe khusus
Dengan membuat class `DuplicateError` (bukan Error generik), lapisan API
nanti bisa memetakannya ke HTTP 409 Conflict dengan struktur yang jelas,
berbeda dari error validasi biasa. Tipe error yang spesifik = penanganan
yang spesifik.

### 🎉 D1 SELESAI — integritas data naik satu level
Field identitas (email, username) sekarang dijamin unik oleh mesin
database. Ini fondasi penting untuk fase Auth (M08-M11) nanti — login
bergantung pada email/username yang unik!

## ✅ Status: SELESAI (7/7 test D1, 73/73 total) — 2026-09-11
