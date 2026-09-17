# M32 — Scheduled Backup: VACUUM INTO + Retensi Otomatis

## Apa yang kupikirkan sebelumnya

Backup otomatis = cron daemon + rsync + rotasi file + shell script. Kompleks.
Bergantung pada tools eksternal yang harus di-install di VPS.

## Apa yang ternyata benar

**VACUUM INTO + scheduler M15c + fs = backup system lengkap.**
- `VACUUM INTO '<path>'` = SQLite native command yang membuat file .db
  BARU, self-contained, bisa dibuka independen (restore = buka file).
- Scheduler M15c sudah berjalan (30s interval) — tinggal tambah check.
- Retensi = list file, sort, delete yang lama. fs.readdirSync + unlink.
- Download = createReadStream + pipe. Express-level trivial.

Total: ~200 baris TypeScript. Zero dependency baru.

## Aha! moment

**1. `prepare().run()` TIDAK bekerja untuk VACUUM INTO di node:sqlite.**
Test pertama: backup file dibuat tapi 0 records. Debug 30 menit — ternyata
`db.prepare('VACUUM INTO ...').run()` di node:sqlite TIDAK melempar error
tapi TIDAK JUGA menjalankan VACUUM. Fix: `db.exec()`. node:sqlite masih
experimental — prepare/exec behavior untuk non-DML statements belum konsisten.

**2. Backup test 403 → createRule null → admin-only.**
Test membuat collection dengan `rules: { listRule: '' }` tapi TIDAK set
`createRule: ''`. Anonymous POST records → 403 Forbidden. Ini BUKAN bug —
ini keamanan M11 bekerja dengan benar! Test-nya yang lupa set rules publik.
Pelajaran: **fitur keamanan yang bekerja benar terasa seperti "bug" saat
testing kalau kita lupa bahwa default = deny.**

**3. Test router missing createPublicRouter → 404 → 0 records.**
Debug m32 membuat router dengan admin + database + backup routes, TAPI
TIDAK dengan `createPublicRouter()`. Route POST records tidak terdaftar →
404 → 0 records dibuat → backup snapshot database kosong. Fix: tambah
`createPublicRouter()` di setup. **Router merge order matters! Kalau route
tidak terdaftar, semuanya 404 — bukan error.**

**4. Path Windows + SQLite = forward-slash.**
`VACUUM INTO 'E:\path\to\file.db'` — backslash di string literal SQLite
bukan escape character, tapi path Windows. Normalisasi: `.replace(/\\/g, '/')`
untuk safety. SQLite menerima keduanya, tapi forward-slash lebih portable.

## Desain yang dipertahankan

- **Config per project** (bukan global): tiap project punya kebutuhan backup
  berbeda — blog pribadi weekly, production daily.
- **Retensi 1-30** (bukan unlimited): mencegah disk penuh. Default 7.
- **Metadata .json bersebelahan dengan .db**: tanpa perlu query backup file
  untuk tahu isinya (list = baca JSON, bukan buka SQLite).
- **Path-traversal guard** di download: sama pola dengan file serving M14.

## Pertanyaan yang masih tersisa

- Backup restore endpoint (POST /backup/:filename/restore → VACUUM INTO reverse)
- Backup ke S3 (kombinasi M30 storage adapter + M32 backup scheduler)
- Compression (gzip) untuk menghemat storage
- Incremental backup (WAL diff) untuk project besar
