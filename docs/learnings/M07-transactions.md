# M07 — Transactions & WAL: Selamat dari Kematian Mendadak

> **Konsep yang dipelajari:** ACID secara mendalam, Write-Ahead Log (WAL), atomic commit, dan crash recovery — bagaimana database selamat saat listrik mati di tengah penulisan.

## 🎯 Tujuan Milestone

Menjawab pertanyaan yang tersisa sejak M01: **"bagaimana database BENAR-BENAR menjamin data tidak corrupt saat crash di tengah jalan?"**

Kita sudah memakai transaksi di M02 — sekarang kita membuka kap mesinnya dan MENCOBA MERUSAKNYA dengan sengaja.

## 🧠 Masalah Fundamental: Penulisan Disk Itu Tidak Atomik

```
Menulis 1 MB ke disk BUKAN kejadian sekejap — ia proses:
  [tulis 100KB] [tulis 100KB] [tulis 100KB] ...
                   ↑
              LISTRIK MATI DI SINI — apa yang terjadi?!
              → file setengah tertulis = CORRUPT (seperti M01!)
```

Database tidak bisa mencegah listrik mati. Yang bisa dia lakukan:
**membuat crash menjadi TIDAK BERBAHAYA** — dengan trik yang cerdik.

## 💡 Ide Jenius: Write-Ahead Log (WAL)

> **"Tulis NIATMU dulu di tempat aman, BARU ubah data aslinya."**

```
Tanpa WAL (cara naif):
  UPDATE langsung menimpa file database
  crash di tengah → data asli rusak 💀

Dengan WAL (cara SQLite):
  1. Tulis perubahan ke FILE LOG terpisah dulu (data.db-wal)
     → "SAYA AKAN mengubah halaman 5 menjadi X"
  2. fsync (paksa masuk disk)
  3. COMMIT — tandai di log bahwa transaksi ini SAH
  4. NANTI: pindahkan perubahan dari log ke file utama (checkpoint)

  Crash di mana pun:
    - sebelum COMMIT di log → transaksi dianggap TIDAK PERNAH ADA (abaikan log)
    - setelah COMMIT → replay log saat restart (perubahan diterapkan ulang)
```

**Data asli tidak pernah dalam keadaan "setengah jadi"** — karena yang diubah duluan adalah log, dan log punya penanda "sah" yang jelas.

## 🔬 Eksperimen yang Akan Kita Lakukan

### Eksperimen 1: "Bukti transaksi atomik"
Sudah kita buktikan di M02 (500 sukses + 1 gagal = 0 baris). Sekarang kita dalami KENAPA bisa begitu.

### Eksperimen 2: "Isolation — dua koneksi, satu database"
Dua koneksi membaca data yang sama saat satu sedang menulis:
```
Koneksi A: BEGIN, UPDATE (belum commit)
Koneksi B: SELECT → melihat data LAMA (bukan yang sedang diubah A!)
Koneksi A: COMMIT
Koneksi B: SELECT → baru sekarang melihat data baru
```
Inilah ISOLATION — transaksi tidak "mengintip" pekerjaan setengah jadi milik transaksi lain.

### Eksperimen 3: "WAL vs rollback journal — bandingkan mode"
SQLite punya 2 mode jurnal:
- `journal_mode = DELETE` (rollback journal — cara lama)
- `journal_mode = WAL` (lebih modern, lebih cepat untuk read+write bersamaan)
Kita lihat file apa yang muncul di masing-masing mode.

### Eksperimen 4: "Savepoint — transaksi bersarang"
```
BEGIN;
  INSERT A;
  SAVEPOINT sp1;
    INSERT B;
  ROLLBACK TO sp1;   ← batalkan HANYA B, A tetap!
COMMIT;              → hanya A yang tersimpan
```

### Eksperimen 5 (puncak): "Mencoba corrupt — dan gagal"
Simulasikan crash recovery dengan WAL:
1. Tulis data dengan WAL dalam transaksi
2. "Crash" — tutup koneksi TANPA checkpoint (paksa)
3. Buka ulang → SQLite membaca WAL → data SELAMAT

## 📁 File yang Dibangun

```
server/tests/
└── m07-transactions.test.ts  ← 5 eksperimen di atas
docs/learnings/
└── M07-transactions.md  ← jurnal ini
```
(M07 tidak menambah modul baru — ia mendalami apa yang sudah ada di M02.)

## ✅ Definisi Selesai

- [ ] Eksperimen isolation dua koneksi terbukti
- [ ] Mode WAL vs DELETE dibandingkan (file yang muncul)
- [ ] Savepoint (transaksi bersarang) bekerja
- [ ] Simulasi crash + recovery dengan WAL → data selamat
- [ ] Pemahaman ACID terdokumentasi dengan contoh nyata
- [ ] Test lulus + jurnal diisi

## 📝 Hasil Eksperimen & Aha! Moments

### Hasil 5 eksperimen

| # | Eksperimen | Hasil |
|---|-----------|-------|
| E1 | Atomicity (rollback) | Saldo tetap 1000 — tidak ada setengah jadi |
| E2 | Isolation (2 koneksi) | Lihat nilai lama (100) sampai commit → baru 999 |
| E3 | WAL vs DELETE mode | File `-wal` muncul di mode WAL |
| E4 | Savepoint | Rollback sebagian: A tersimpan, B batal |
| E5 | Crash recovery | 100 record SELAMAT setelah "crash" berkat WAL |

### Aha! #1 — "Crash" itu bukan kecelakaan, melainkan SKENARIO yang dirancang
Di M01, crash = bencana (file corrupt, database mati). Di M07, kita
MEMBUNUH proses dengan sengaja dan data tetap selamat. SQLite tidak
"mencegah crash" (mustahil) — ia membuat crash TIDAK BERBAHAYA.
Inilah bedanya sistem yang "berharap tidak gagal" dengan sistem yang
"dirancang untuk tetap benar saat gagal". Yang kedua jauh lebih kuat.

### Aha! #2 — WAL = menulis niat sebelum bertindak
Trik jenius WAL: tulis "SAYA AKAN mengubah X" ke log dulu, baru ubah
data aslinya. Kalau mati di tengah, log yang tidak bertanda "COMMIT"
dianggap tidak pernah ada; yang bertanda COMMIT di-replay ulang.
Data asli TIDAK PERNAH dalam keadaan setengah jadi. Prinsip ini
(jurnal/log dulu) dipakai di hampir semua sistem kritis: database,
filesystem (journaling), bahkan sistem pembayaran.

### Aha! #3 — Isolation = setiap transaksi punya "dunia sementara"-nya
E2 menunjukkan koneksi lain melihat data LAMA (100) padahal transaksi
sedang mengubahnya menjadi 999 — sampai COMMIT. Setiap transaksi
bekerja di "salinan sementara" dan dunia luar hanya melihat hasil
setelah COMMIT. Tanpa ini, laporan keuangan bisa membaca angka
"setengah transfer" — uang tampak hilang sesaat!

### Aha! #4 — ACID bukan satu hal, melainkan empat janji terpisah
- **A**tomicity: semua atau tidak sama sekali (E1) ✓
- **C**onsistency: aturan (constraint) selalu terjaga (M02) ✓
- **I**solation: transaksi tidak saling mengintip (E2) ✓
- **D**urability: sekali commit, selamat dari crash (E5) ✓
Empat eksperimen kita memetakan persis ke empat huruf ACID — dan
sekarang masing-masing punya BUKTI, bukan hanya definisi hafalan.

### 🎉 FASE SQL DATABASE — TUNTAS SEPENUHNYA!
Dengan M07, kita telah membangun & memahami: KV store (M01), raw SQL
(M02), schema-as-data (M03), query parser (M04), record API (M05),
indexing (M06), dan durability (M07). Inti PocketBase — selesai.

### Jembatan ke fase berikutnya
Database sudah kokoh. Selanjutnya: **AUTH (M08-M11)** — password
hashing, JWT, OAuth, dan row-level security. Kita mulai melindungi
data ini dari orang yang tidak berhak.

## ✅ Status: SELESAI (5/5 eksperimen, 62/62 total) — 2026-09-11
