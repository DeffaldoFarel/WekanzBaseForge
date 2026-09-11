# M05 — Record API: CRUD Generik untuk Semua Collection

> **Konsep yang dipelajari:** menggabungkan skema (M03) + query parser (M04) menjadi API CRUD generik, validasi data, pagination, dan serialize/deserialize tipe.

## 🎯 Tujuan Milestone

Membangun **satu set fungsi CRUD yang bekerja untuk SEMUA collection** — tanpa hardcode nama collection atau field-nya. Inilah yang membuat PocketBase bisa melayani collection apa pun yang kamu buat.

```typescript
// SATU fungsi ini bekerja untuk habits, posts, users, APAPUN:
await listRecords(db, 'habits', { filter: 'streak > 5', page: 1, perPage: 20 });
await listRecords(db, 'posts',  { filter: 'title ~ "sqlite"', sort: '-created' });
await createRecord(db, 'habits', { title: 'Olahraga', streak: 7 });
```

## 🧠 Masalah yang Harus Dipecahkan

### 1. Serialize/Deserialize tipe
Database menyimpan SEMUANYA sebagai teks/angka mentah. Tapi user mengirim/mengharap tipe yang benar:

| Tipe | User kirim | Simpan di SQLite | User terima |
|------|-----------|------------------|-------------|
| bool | `true` | `1` | `true` |
| json | `{a:1}` | `'{"a":1}'` | `{a:1}` |
| number | `7` | `7` | `7` |
| text | `'x'` | `'x'` | `'x'` |

Kita butuh lapisan serialize (user → DB) dan deserialize (DB → user).

### 2. Validasi sebelum INSERT
Setiap field divalidasi terhadap skema (M03 `validateValue`) + field sistem `id/created/updated` di-generate otomatis.

### 3. Pagination yang benar
```
page=2, perPage=20  →  LIMIT 20 OFFSET 20
```
Plus `totalItems` dan `totalPages` — user butuh tahu "ada berapa halaman lagi".

### 4. Sorting
```
sort: '-streak,+created'  →  ORDER BY streak DESC, created ASC
```
`-` = descending, `+` = ascending (konvensi PocketBase).

## 📐 API yang Dibangun

```typescript
interface ListResult {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  items: Record<string, unknown>[];
}

createRecord(db, collection, data)          → record (dengan id/created/updated)
getRecord(db, collection, id)               → record | null
updateRecord(db, collection, id, data)      → record | null
deleteRecord(db, collection, id)            → boolean
listRecords(db, collection, options)        → ListResult
  options: { filter?, sort?, page?, perPage? }
```

## 📁 File yang Dibangun

```
server/src/core/
└── records.ts      ← CRUD generik (memakai schema.ts + query/)
server/tests/
└── m05-records.test.ts
docs/learnings/
└── M05-record-api.md  ← jurnal ini
```

## ✅ Definisi Selesai

- [ ] createRecord generate id + timestamps otomatis
- [ ] Validasi field bekerja (tipe salah → ditolak dengan pesan jelas)
- [ ] Serialize bool/json ke DB, deserialize kembali dengan benar
- [ ] getRecord/updateRecord/deleteRecord bekerja
- [ ] listRecords dengan filter (M04!), sort, pagination
- [ ] Pagination menghitung totalItems & totalPages dengan benar
- [ ] SATU set fungsi bekerja untuk 2 collection berbeda (bukti generik!)
- [ ] Test lulus + jurnal diisi

## 🌉 Jembatan ke M06

Setelah CRUD bekerja, pertanyaan berikutnya: "bagaimana membuat query
`streak > 5` CEPAT saat datanya jutaan?" → Index. Itulah M06.

## 📝 Aha! Moments

### Aha! #1 — Generik itu berarti "skema yang bekerja, bukan kode"
`createRecord` tidak tahu apa itu "habits" atau "posts" — ia hanya membaca
skema dari `_collections` (M03) dan membangun INSERT secara dinamis.
Sekali lagi: LOGIKA digerakkan oleh DATA (skema), bukan oleh kode yang
ditulis untuk setiap kasus. Inilah alasan PocketBase bisa melayani
collection apa pun tanpa diubah kodenya.

### Aha! #2 — Serialize/Deserialize adalah penerjemah dua dunia
Di dalam SQLite: bool = 1, json = string. Di dunia user: bool = true,
json = object. Tanpa lapisan serialize/deserialize, user akan melihat
`done: 1` (membingungkan!) atau string JSON mentah. Lapisan tipis ini
adalah yang membuat API "terasa benar" — dan ia HARUS digerakkan oleh
skema (tipe field), bukan tebakan.

### Aha! #3 — Pagination itu dua query, bukan satu
`LIMIT ? OFFSET ?` hanya memberi satu halaman. Tapi user butuh tahu
"ada berapa halaman lagi?" → butuh query COUNT(*) TERPISAH dengan
WHERE yang sama. `totalItems` dan `totalPages` tidak gratis — harus
dihitung. Dan OFFSET pada data yang sedang berubah bisa melewatkan/
menduplikat record (edge case yang akan kita temui lagi).

### Aha! #4 — Sort juga harus divalidasi seperti filter
`sort: '-streak'` berarti nama field masuk ke ORDER BY — dan seperti
di M03/M04, nama TIDAK BISA lewat parameter binding. Jadi sort field
divalidasi terhadap skema dengan cara yang sama. Keamanan itu konsisten:
SETIAP input user yang menjadi bagian SQL harus divalidasi.

### Aha! #5 — M03 + M04 = M05 tanpa kode baru yang besar
Perhatikan betapa sedikitnya logika BARU di M05: validasi dari M03,
filter dari M04, CRUD hanyalah "lem" yang merangkainya. Arsitektur yang
baik membuat fitur baru menjadi KOMPOSISI dari yang sudah ada, bukan
tumpukan kode baru. Ini tanda desain M03/M04 sudah benar.

### 🎉 FASE SQL DATABASE INTI SELESAI!
Dengan M05, BaseForge sekarang bisa:
- definisikan collection (M03)
- buat/baca/ubah/hapus record (M05)
- query dengan filter bahasa sendiri (M04)
- semua dengan validasi + keamanan berlapis

Inilah inti PocketBase — dan kita membangunnya dari nol.

### Jembatan ke M06/M07
- "Query `streak > 5` lambat saat data jutaan" → M06: index
- "Bagaimana kalau crash di tengah?" → M07: transaksi & WAL mendalam

## ✅ Status: SELESAI (10/10 test M05, 51/51 total) — 2026-09-11
