# M12 — Relations & Expand: Menghubungkan Data Antar Collection

> **Konsep yang dipelajari:** relasi antar collection, JOIN dinamis, expand, dan N+1 problem beserta solusinya (batch loading).

## 🎯 Tujuan Milestone

Menghubungkan record antar collection — dan yang terpenting, memahami **N+1 problem**: jebakan performa paling umum di dunia database, beserta solusinya.

```typescript
// Di akhir M12, ini bekerja:
await listRecords(db, 'habits', {
  expand: 'user',           // setiap habit membawa data user-nya!
});

// Hasil:
// { id: 'h1', title: 'Olahraga', user: 'u1',
//   expand: { user: { id: 'u1', name: 'Farel' } } }
```

## 🧠 Masalah 1: Relasi Itu Apa?

```
USERS                HABITS
┌────┬───────┐       ┌────┬───────────┬────────┬────────┐
│ id │ name  │       │ id │ title     │ streak │ user   │ ← menunjuk USERS.id
├────┼───────┤       ├────┼───────────┼────────┼────────┤
│ u1 │ Farel │ ◄─────│ h1 │ Olahraga  │   7    │  'u1'  │
│ u2 │ Budi  │       │ h2 │ Baca      │   3    │  'u1'  │
└────┴───────┘       │ h3 │ Meditasi  │   5    │  'u2'  │
                     └────┴───────────┴────────┴────────┘
```

Field `user` di habits menyimpan **id** dari record di collection `users`.
Inilah "foreign key" — penunjuk antar tabel.

## 🧠 Masalah 2: N+1 Problem ★KONSEP PALING PRAKTIS★

Bayangkan mengambil 10 habits + data user masing-masing:

### Cara NAIF (N+1):
```typescript
const habits = listRecords('habits');           // 1 query
for (const h of habits) {
  h.user = getRecord('users', h.user);          // N query lagi!
}
// 10 habits = 1 + 10 = 11 query!
// 1000 habits = 1 + 1000 = 1001 query!! 💀
```

### Cara BENAR (batch loading):
```typescript
const habits = listRecords('habits');            // 1 query
const userIds = habits.map(h => h.user);         // ['u1','u1','u2',...]
const users = getUsersWhereIdIn(unique(userIds)); // 1 query SAJA!
// gabungkan di memori
// Total: 2 query — tidak peduli 10 atau 1000 habits! ✨
```

**N+1 = 1 query untuk daftar + N query untuk detail masing-masing.**
Solusinya = kumpulkan semua id dulu, ambil sekaligus dalam SATU query `WHERE id IN (...)`.

## 📐 Yang Dibangun

### 1. Tipe `relation` di field (sudah ada dari M03, sekarang diaktifkan)
```typescript
{ name: 'user', type: 'relation', options: { collectionId: 'users' } }
```

### 2. `expand` di listRecords/getRecord
```typescript
listRecords(db, 'habits', { expand: 'user' })       // expand 1 level
listRecords(db, 'habits', { expand: 'user.profile' }) // expand bertingkat (M12 lanjutan)
```

### 3. Batch loading untuk menghindari N+1
Kumpulkan id → satu query IN(...) → petakan kembali.

## 📁 File yang Dibangun

```
server/src/core/
└── relations.ts    ← expand + batch loading
server/tests/
└── m12-relations.test.ts  ← termasuk BUKTI N+1 (hitung jumlah query!)
docs/learnings/
└── M12-relations.md
```

## ✅ Definisi Selesai

- [ ] Field relation menunjuk collection lain
- [ ] `expand: 'user'` membawa data user di setiap record
- [ ] expand memakai batch loading (BUKAN N+1) — dibuktikan dengan menghitung query
- [ ] expand pada record yang tidak punya relasi → tidak error (expand kosong)
- [ ] Nested expand `a.b` bekerja
- [ ] Benchmark N+1 vs batch loading terdokumentasi
- [ ] Test lulus + jurnal diisi

## 📝 Hasil & Aha! Moments

### Bukti N+1 vs Batch Loading (angka nyata)

```
Expand 3 habits → data user:
  Cara N+1  : 3 query (1 per record)
  Cara BATCH: 1 query (1 untuk semua)

→ Untuk 1000 habits: N+1 = 1000 query, BATCH = tetap 1 query.
```

### Aha! #1 — N+1 adalah jebakan yang "terlihat benar"
Kode N+1 TAMPAK natural: ambil daftar, lalu ambil detail masing-masing.
Ia bahkan bekerja dengan benar! Masalahnya baru muncul saat data membesar
— dan saat itu, aplikasi sudah lambat di production tanpa sebab jelas.
N+1 adalah contoh sempurna "bug performa yang menyamar sebagai kode biasa".
Sekarang aku tahu mencarinya: loop yang berisi query = 🚩 tanda bahaya.

### Aha! #2 — Solusinya bukan "lebih cepat", melainkan "lebih sedikit"
Batch loading tidak membuat SATU query jadi lebih cepat — ia mengurangi
JUMLAH query dari N menjadi 1. 1 query besar hampir selalu mengalahkan
N query kecil, karena setiap query punya biaya tetap (parsing, planning,
disk I/O, network). Pelajaran umum: perhatikan BIAYA TETAP per operasi,
bukan hanya ukuran datanya.

### Aha! #3 — Mengumpulkan dulu, baru mengambil = pola universal
Pola batch loading (kumpulkan id → satu query IN(...) → petakan kembali)
muncul di mana-mana: DataLoader di GraphQL, Eager Loading di ORM,
bahkan rendering UI. Ini pola "ubah N panggilan kecil jadi 1 panggilan
besar" — dan ia lahir dari kesadaran akan N+1.

### Aha! #4 — Expand adalah JOIN yang "dirakit di aplikasi"
Database bisa melakukan JOIN langsung di SQL. Tapi expand memilih
mengambil terpisah lalu menggabungkan di memori. Kenapa? Karena untuk
nested expand dan struktur fleksibel, menggabungkan di aplikasi lebih
mudah dikontrol daripada membangun JOIN rekursif yang rumit. Ada lebih
dari satu cara benar menghubungkan data.

### 🎉 FASE SQL DATABASE — 100% TUNTAS (M01-M07 + M12)!
Dengan relations, fase database benar-benar lengkap:
- penyimpanan & query ✓
- skema & meta ✓
- filter & parser ✓
- CRUD generik ✓
- index & performa ✓
- transaksi & durability ✓
- relasi & expand ✓

### Jembatan ke fase AUTH (M08-M11)
Database sudah utuh. Sekarang saatnya melindunginya: siapa yang boleh
mengakses data ini? Dimulai dari M08 — password hashing.

## ✅ Status: SELESAI (4/4 test M12, 66/66 total) — 2026-09-11
