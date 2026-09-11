# M01 — KV Store Sederhana

> **Konsep yang dipelajari:** penyimpanan data dari nol, memori vs disk, persistensi, dan kenapa database harus ada.

## 🎯 Tujuan Milestone

Membangun **key-value store** — bentuk database paling primitif — dari nol, TANPA SQLite, TANPA library database apa pun. Hanya:
- `Map` di memori
- File JSON di disk

Tujuannya BUKAN membuat database yang bagus. Tujuannya adalah **merasakan sendiri masalah-masalah yang oleh database sungguhan diselesaikan** — supaya setiap fitur SQLite di M02-M07 terasa seperti jawaban, bukan teori.

## 🧠 Apa itu KV Store?

Database paling sederhana: **kunci → nilai**. Titik.

```
"habits:h1"  →  { "title": "Olahraga", "streak": 7 }
"habits:h2"  →  { "title": "Baca buku", "streak": 3 }
"users:u1"   →  { "name": "Farel", "email": "f@x.com" }
```

- Tidak ada tabel
- Tidak ada skema
- Tidak ada query language
- Tidak ada relasi
- Hanya: `set`, `get`, `delete`, `keys`

Redis, LevelDB, dan RocksDB adalah KV store sungguhan (sangat cepat karena sederhana). Bahkan SQLite punya mode KV di dalamnya.

## 📐 API yang Dibangun

```typescript
const kv = new KVStore('./data/kv.json');

await kv.set('habits:h1', { title: 'Olahraga', streak: 7 });
await kv.get('habits:h1');        // → { title: 'Olahraga', streak: 7 }
await kv.get('tidak-ada');        // → undefined
await kv.delete('habits:h1');     // → true
await kv.keys('habits:');         // → semua key yang diawali 'habits:'
await kv.count();                 // → jumlah key
```

## 🔬 Eksperimen Wajib (bagian terpenting!)

Setelah KV store-nya jalan, kita akan SENGAJA memicu 4 masalah dan merasakannya:

### Eksperimen 1: "Restart hilang"
1. Simpan data
2. Matikan proses
3. Nyalakan lagi
4. **Pertanyaan:** datanya masih ada? (Versi 1 tanpa persist: HILANG. Versi 2 dengan file: ada)

### Eksperimen 2: "Tulis ulang semuanya"
1. Simpan 10.000 key
2. Ukur waktu `set()` SATU key
3. **Pertanyaan:** kenapa menambah 1 key butuh waktu sebanding TOTAL data?
   (Jawaban yang akan kamu temukan: karena kita menulis ulang SELURUH file!)

### Eksperimen 3: "File corrupt"
1. Simpan data
2. Kill proses TEPAT saat sedang menulis file (atau tulis setengah lalu berhenti)
3. Nyalakan lagi
4. **Pertanyaan:** apa yang terjadi saat JSON.parse membaca file setengah jadi?

### Eksperimen 4: "Cari tanpa index"
1. Simpan 10.000 key dengan pola `habits:hNNNN`
2. Cari semua yang mengandung 'streak > 5'
3. **Pertanyaan:** bisakah tanpa membaca SEMUA value satu per satu?

## 📁 File yang Dibangun

```
server/src/lab/           ← folder eksperimen (bukan core!)
└── kvStore.ts            ← implementasi KV store
server/tests/
└── m01-kv.test.ts        ← test + eksperimen
docs/learnings/
└── M01-kv-store.md       ← jurnal ini
```

## ✅ Definisi Selesai

- [ ] `set/get/delete/keys/count` bekerja
- [ ] Data persist ke file JSON
- [ ] 4 eksperimen dilakukan dan hasilnya dicatat
- [ ] Test lulus (`npm test`)
- [ ] Jurnal diisi: "masalah apa yang kualami?"

## 🌉 Jembatan ke M02

Setelah M01, kamu akan punya daftar keluhan pribadi terhadap KV store buatanmu. M02 akan menunjukkan bagaimana SQLite menyelesaikan SETIAP keluhan itu — dan kamu akan menghargainya dengan cara yang tidak mungkin didapat dari membaca dokumentasi.

## 📝 Hasil Eksperimen & Aha! Moments

### Hasil eksperimen (angka nyata, 11 Sep 2026)

| Eksperimen | Hasil |
|-----------|-------|
| E1 persistensi | Data selamat dari restart (karena persist ke file) |
| E2 biaya persist | 2000 key = **1321ms**, file 201 KB — O(N²) kuadratik! |
| E3 file corrupt | JSON terpotong → **database gagal total load** |
| E4 full scan | Cari 2000/5000 records = baca semuanya, tanpa kecuali |

### Aha! #1 — "Database" itu ternyata bisa sesederhana Map + file
Inti sebuah KV store hanyalah hash table + cara menuliskannya ke disk.
Semua database di dunia adalah variasi dari ide ini — yang membuatnya
"database sungguhan" adalah SOLUSI atas 4 cacat yang kita rasakan.

### Aha! #2 — Menulis ulang semuanya itu O(N²)
Mengisi N key berarti menulis ulang file yang tumbuh setiap kali:
1 + 2 + 3 + ... + N = N²/2 total byte yang ditulis. Inilah kenapa
database tidak pernah menulis ulang seluruh data untuk satu perubahan —
mereka menulis ke lokasi yang TEPAT (B-Tree pages) atau menambahkan
ke log (WAL). E2 membuktikannya dengan angka: 1321ms untuk 2000 key!

### Aha! #3 — JSON polos itu rapuh untuk data penting
Satu byte terpotong = seluruh file tidak bisa dibaca (E3). Database
sungguhan punya: penulisan atomik (temp-file + rename), checksum per
halaman, dan WAL untuk recovery. "Tidak corrupt" itu fitur yang
direkayasa dengan serius, bukan kebetulan.

### Aha! #4 — Tanpa index, semua query adalah full scan
E4: mencari streak>5 HARUS membaca semua 5000 record. Tidak ada jalan
pintas. Index (M06) pada dasarnya adalah "daftar isi" yang memungkinkan
lompat langsung ke record yang relevan — dan kita akan membangunnya
setelah merasakan mahalnya full scan ini.

### Jembatan ke M02
Keluhan pribadiku terhadap KV store buatan ini:
1. Menulis lambat sekali (O(N²)) → **SQLite: B-Tree + paging**
2. Bisa corrupt total → **SQLite: WAL + atomic commit (M07)**
3. Pencarian harus baca semua → **SQLite: index (M06)**
4. Semua data harus muat di RAM → **SQLite: data di disk, cache seperlunya**
5. Tidak ada struktur data (semua bebas) → **SQLite: schema + tipe (M03)**

Setiap keluhan = satu fitur SQLite. Sekarang kita siap menghargainya. 😊

## ✅ Status: SELESAI (8/8 test lulus, 4 eksperimen terdokumentasi) — 2026-09-11
