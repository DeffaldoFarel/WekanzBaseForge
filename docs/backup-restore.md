# 💾 Backup & Restore

BaseForge membuat backup lewat **VACUUM INTO** — sebuah snapshot file SQLite
yang **bisa dibuka independen**, bukan dump teks. Artinya restore adalah
mengganti file `data.db` project dengan file backup, bukan menjalankan ulang
SQL.

## Membuat backup

```
POST /api/admin/projects/:pid/backup/run
```

Backup tersimpan di `<DATA_DIR>/backups/<projectId>/<timestamp>.db` (lihat
`backupScheduler.ts`). Endpoint `GET .../backup/list` dan
`GET .../backup/download/:filename` tersedia untuk mengelola dan mengambilnya.

> **Prinsip:** backup yang belum pernah dibuktikan bisa dibuka adalah harapan,
> bukan backup. Jalankan latihan restore (di bawah) secara berkala — test
> `ops-1-2-3-hardening.test.ts` membuktikan sebuah backup benar-benar bisa
> dibuka dan datanya utuh setelah dipulihkan.

## Prosedur Restore (produksi, `tencentvps1`)

Restore **mengganti seluruh database project** — data sesudah backup akan
hilang. Lakukan dengan hati-hati.

1. **Hentikan service** (SQLite tidak boleh ditulis saat file-nya diganti):
   ```bash
   systemctl --user stop baseforge-server.service
   ```

2. **Cadangkan file saat ini** (jaga-jaga bila restore keliru):
   ```bash
   cp ~/WekanzBaseForge/data/projects/<projectId>/data.db \
      ~/WekanzBaseForge/data/projects/<projectId>/data.db.before-restore
   ```

3. **Salin file backup menggantikan `data.db`:**
   ```bash
   cp ~/WekanzBaseForge/data/backups/<projectId>/<timestamp>.db \
      ~/WekanzBaseForge/data/projects/<projectId>/data.db
   ```

4. **Hapus file WAL/SHM sisa** (agar tidak ada state transaksi lama):
   ```bash
   rm -f ~/WekanzBaseForge/data/projects/<projectId>/data.db-wal \
         ~/WekanzBaseForge/data/projects/<projectId>/data.db-shm
   ```

5. **Nyalakan service & verifikasi:**
   ```bash
   systemctl --user start baseforge-server.service
   curl https://baseforge.wekanz.id/api/health
   # Login ke dashboard dan cek jumlah record koleksi kunci.
   ```

6. Bila semua baik, hapus `data.db.before-restore`. Bila keliru, kembalikan
   file itu dengan langkah 1–5 yang sama (arah sebaliknya).

## Latihan restore (WAJIB berkala)

Jangan tunggu bencana untuk pertama kali menguji restore. Secara berkala:

1. Buat backup (`POST .../backup/run`).
2. Salin file backup ke lokasi sementara, **buka dengan SQLite**, dan baca
   jumlah record + satu record penanda.
3. Bandingkan dengan database aktif.

Langkah 2 persis yang dibuktikan test `ops-1-2-3-hardening.test.ts`
("backup → pulihkan ke DB baru → data utuh"). Bila latihan ini gagal,
backup Anda tidak berguna — perbaiki sebelum benar-benar dibutuhkan.
