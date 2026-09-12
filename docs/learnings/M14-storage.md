# M14 — Storage: File Upload ala PocketBase

> **Konsep:** multipart/form-data parsing dari nol, field type `file`, penyimpanan di disk, dan serving file dengan content-type yang aman.

## 🎯 Masalah yang Dipecahkan

Sampai M13, semua data adalah teks/angka. Aplikasi nyata butuh **file**:
foto profil, lampiran PDF, gambar produk. PocketBase menyelesaikannya
dengan field type `file` + endpoint serving `/api/files/...`.

## 🧠 Bagaimana File Masuk ke Server?

1. Browser kirim form `multipart/form-data`: body dibagi per "bagian"
   (boundary = pemisah), tiap bagian punya header (nama field, filename)
   + isi bytes.
2. Server PARSE sendiri: cari boundary dari header Content-Type, split
   body, ekstrak field teks & file.
3. File disimpan ke DISK (`storage/<projectId>/<recordId>_<filename>`),
   metadata (nama file asli) disimpan di kolom record.
4. Serving: GET /api/files/:pid/:collection/:record/:filename → baca
   dari disk, kirim dengan Content-Type yang benar.

## 🔒 Keamanan File (penting!)

- **Path traversal**: filename dibersihkan (`..`, `/`, `\` ditolak) —
  attacker tidak bisa `filename=../../../etc/passwd`.
- **Content-Type mapping**: ekstensi → MIME dari whitelist; tidak
  menebak dari isi (XSS via text/html dicegah — binary selalu
  application/octet-stream kecuali whitelist).
- **Ukuran**: max 5 MB default (options.maxSize).
- **Isolasi project**: file hidup di folder project — project A tidak
  bisa menyentuh file project B.

## 📁 Perubahan

```
core/multipart.ts     → parser multipart dari nol (Buffer-based)
core/storage.ts       → simpan/baca/hapus file di disk
core/fieldTypes.ts    → tipe 'file' (single & maxSelect multi)
core/records.ts       → handle file: simpan file saat create/update,
                        hapus file saat replace/delete
api/storageRoutes.ts  → GET /api/files/:pid/:collection/:rid/:filename
```

## ✅ Definisi Selesai

- [ ] Parser multipart (boundary, teks & file, multi-file)
- [ ] Field type file + maxSelect + maxSize + validasi
- [ ] Simpan ke disk per project, nama file unik (recordId_prefiks)
- [ ] Serving dengan content-type whitelist + path traversal aman
- [ ] Replace file saat update, hapus file saat record dihapus
- [ ] Test lulus + jurnal

## 📝 Aha! Moments

### Aha! #1 — Multipart harus di-parse dari BUFFER, bukan string
File = bytes binary (PNG mulai 0x89 0x50...). Mengubah body ke utf-8
SEBELUM parse merusak bytes yang tidak valid UTF-8. Parser bekerja
langsung di Buffer: indexOf delimiter, slice content — binary tetap utuh.
Bukti: bytes yang di-upload = bytes yang di-download (cmp identik).

### Aha! #2 — Multipart butuh recordId SEBELUM insert
Nama file di disk = <recordId>_<filename>. Tapi recordId baru ada
setelah INSERT... Kecuali kita generate id sendiri dulu! createRecord
diberi parameter opsional preGeneratedId — API layer generate, parse
multipart (simpan file pakai id itu), baru INSERT dengan id sama.
Masalah "ayam-telur" diselesaikan dengan membalik urutan, bukan
menambah kompleksitas.

### Aha! #3 — Path traversal butuh PERTAHANAN BERSUSUN
(1) sanitizeFilename membuang semua path component saat parse; (2)
readFile resolve path absolut lalu verifikasi masih di dalam folder
project. Dua lapis — kalau satu lolos, satu lagi menahan. Test:
../../etc/passwd → 'passwd'; serve ..%2f..%2fplatform.db → 404.

### Aha! #4 — Content-Type dari WHITELIST, bukan tebakan
Ekstensi dikenal → MIME-nya; tidak dikenal → application/octet-stream
+ Content-Disposition: attachment. Sengaja TIDAK ada .html/.svg/.js di
whitelist — file aktif tidak pernah dirender browser (anti-XSS by
construction). .xyz terbukti jadi download, bukan dieksekusi.

### Aha! #5 — File bukan bagian transaksi SQLite
DELETE record dalam transaksi bisa ROLLBACK... tapi file yang sudah
terhapus TIDAK bisa di-rollback. Karena itu cleanup file terjadi di
API layer SETELAH COMMIT sukses. Trade-off yang sadar: crash di
tengah bisa meninggalkan file orphan (bisa dibersihkan manual), tapi
TIDAK PERNAH file hilang padahal record masih ada.

## ✅ Status: SELESAI — 10/10 test M14, 188/188 total; E2E via HTTP nyata: upload multipart → serve → bytes identik; traversal 404; record lain 404; .xyz = octet-stream — 2026-09-12
