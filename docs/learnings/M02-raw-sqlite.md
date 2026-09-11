# M02 — Raw SQLite: Menyentuh Mesinnya Langsung

> **Konsep yang dipelajari:** SQL mentah, prepared statements, tipe data, transaksi dasar — dan membuktikan dengan ANGKA kenapa SQLite 50-100x lebih cepat dari KV store buatan kita.

## 🎯 Tujuan Milestone

Menyentuh SQLite secara langsung (tanpa abstraksi), melakukan operasi yang sama dengan M01, lalu **membandingkan performanya head-to-head** dengan KV store buatan sendiri.

Ini milestone "OH PANTES" — saat teori "database itu cepat" berubah menjadi angka yang kamu ukur sendiri.

## 🧠 Konsep Kunci

### 1. Dari "semua bebas" ke "ada struktur"

```
M01 KV Store:  key → value JSON bebas (tidak ada aturan)
M02 SQLite:    tabel dengan kolom bertipe (ADA aturan!)

               CREATE TABLE habits (
                 id     TEXT PRIMARY KEY,
                 title  TEXT NOT NULL,        ← wajib! tidak boleh kosong
                 streak INTEGER DEFAULT 0,    ← harus angka!
                 created TEXT
               );
```

Schema adalah **kontrak**: SQLite akan MENOLAK data yang melanggar.
Di M01, kamu bisa `set('habits:h1', 'sebuah string')` padahal seharusnya
object — tidak ada yang melarang! Di SQLite, kesalahan seperti itu
ketahuan SEGERA, bukan saat production.

### 2. Prepared statements — dua manfaat sekaligus

```typescript
// ❌ RENTAN SQL INJECTION (jangan pernah!):
db.exec(`SELECT * FROM habits WHERE title = '${userInput}'`);
//    userInput = "'; DROP TABLE habits; --"  → bencana

// ✅ AMAN (parameter binding):
const stmt = db.prepare('SELECT * FROM habits WHERE title = ?');
stmt.get(userInput);  // nilai diperlakukan sebagai DATA, bukan SQL
```

Manfaat #1: **keamanan** — nilai tidak pernah digabung ke string SQL.
Manfaat #2: **performa** — statement di-compile SEKALI, dipakai berkali-kali.

### 3. Transaksi — "semua atau tidak sama sekali"

```typescript
// 1000 INSERT tanpa transaksi:
//    setiap INSERT = 1 kali tulis ke disk + 1 kali commit = LAMBAT

// 1000 INSERT dalam 1 transaksi:
db.exec('BEGIN');
for (...) stmt.run(...);
db.exec('COMMIT');
//    1000 INSERT = 1 kali tulis ke disk = 50-100x lebih cepat!
```

Inilah rahasia kenapa E2 di M01 lambat (1321ms): setiap `set()` kita
melakukan commit terpisah. Transaksi mengelompokkan banyak perubahan
menjadi satu penulisan disk.

## 🔬 Eksperimen Head-to-Head

Kita ulangi eksperimen M01 dengan SQLite dan bandingkan:

| Eksperimen | M01 (KV buatan) | M02 (SQLite) |
|-----------|-----------------|--------------|
| Isi 2000 record | 1321ms | ??? (ukur sendiri!) |
| Isi 2000 record + transaksi | (tidak punya transaksi) | ??? |
| Cari streak > 5 dari 5000 | full scan semuanya | ??? |
| File corrupt | total gagal | ??? (spoiler: SQLite jauh lebih tangguh) |

## 📁 File yang Dibangun

```
server/src/lab/
├── kvStore.ts          (dari M01 — untuk perbandingan)
└── rawSqlite.ts        ← baru: wrapper tipis raw SQL
server/tests/
├── m01-kv.test.ts      (dari M01)
└── m02-sqlite.test.ts  ← baru: test + benchmark head-to-head
docs/learnings/
└── M02-raw-sqlite.md   ← jurnal ini
```

## ✅ Definisi Selesai

- [ ] Tabel `habits` dibuat dengan SQL mentah
- [ ] CRUD dengan prepared statements
- [ ] Validasi tipe bekerja (SQLite menolak data salah)
- [ ] Transaksi dibuktikan mempercepat bulk insert
- [ ] Benchmark head-to-head M01 vs M02 terdokumentasi
- [ ] Test lulus + jurnal diisi

## 🌉 Jembatan ke M03

Di M02 ini kita menulis `CREATE TABLE habits (...)` dengan tangan — kolom
per kolom, hardcode. Tapi PocketBase tidak menulis SQL untuk setiap
collection! Bagaimana caranya dia membuat tabel untuk collection APAPUN
yang didefinisikan user lewat UI? Jawabannya: **meta-tables** — skema yang
disimpan sebagai data. Itulah M03, jantung PocketBase.

## 📝 Hasil Benchmark & Aha! Moments

### Hasil benchmark (angka nyata, 11 Sep 2026)

| Operasi | M01 KV Store | M02 SQLite | Selisih |
|---------|-------------|------------|---------|
| Isi 2000 record | 1262ms | **5ms** (dengan tx) | **260x lebih cepat!** |
| Isi 2000 record tanpa tx | — | 1121ms | transaksi = 230x |
| Cari streak>5 dari 5000 | 1.2ms | 2.6ms (hasil identik) | ~imbang (belum ada index) |
| Gagal di tengah insert | file CORRUPT total | 0 baris (ROLLBACK) | tak terbandingkan |

### Aha! #1 — 260x lebih cepat dari SATU kata kunci: BEGIN/COMMIT
Penyebab lambatnya KV store kita (dan SQLite tanpa transaksi) BUKAN
penulisan datanya — melainkan **fsync ke disk** yang terjadi setiap
operasi. Disk sync itu mahal (~0.5ms). 2000 operasi × 0.5ms = 1 detik!
Transaksi mengubahnya: 2000 operasi → 1 kali sync = 5ms.
Pelajaran: di dunia database, yang mahal bukan "menulis data" tapi
"memastikan data BENAR-BENAR tertulis".

### Aha! #2 — Schema adalah penjaga, bukan penghalang
`title NULL` ditolak mentah-mentah oleh SQLite. Di KV store M01, data
salah seperti itu diam-diam tersimpan → jadi bug misterius minggu depan.
Constraint memindahkan deteksi error dari "saat production meledak"
menjadi "saat kamu menulis data yang salah". Itu hadiah besar.

### Aha! #3 — Atomicity = "tidak pernah setengah jadi"
B3: 500 baris berhasil lalu error → tabel tetap 0 baris. Bandingkan
dengan M01: file JSON setengah tertulis = database mati total.
ROLLBACK membuat kegagalan menjadi "seolah tidak pernah terjadi" —
dan inilah fondasi dari SEMUA operasi finansial/transfer di dunia.

### Aha! #4 — Declarative vs Imperative
Di M01 kita menulis CARA mencari (loop, periksa setiap value).
Di M02 kita menulis APA yang dicari (WHERE streak > 5) dan SQLite
yang memutuskan caranya. Pergeseran "bagaimana → apa" inilah yang
nanti memungkinkan optimizer (M06 index) mempercepat query TANPA
kita ubah kodenya.

### Jembatan ke M03
Di M02 kita menulis `CREATE TABLE habits (...)` dengan TANGAN —
kolom per kolom, hardcode. Tapi PocketBase tidak menulis SQL untuk
setiap collection! Bagaimana dia membuat tabel untuk collection
APAPUN yang didefinisikan user lewat UI?

Jawabannya adalah inti PocketBase: **skema itu disimpan SEBAGAI DATA**
(tabel `_collections`), dan SQL di-GENERATE dari data itu. Meta-tables.
Database yang mendeskripsikan dirinya sendiri. Itulah M03.

## ✅ Status: SELESAI (15/15 test lulus, 3 benchmark terdokumentasi) — 2026-09-11
