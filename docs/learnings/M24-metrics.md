# M24 — Usage Metrics: Request & Bandwidth per Project

## Apa yang kupikirkan sebelumnya

Statistik request/bandwidth = fitur "menara gading" dashboard cloud. Kubayangkan
perlu database time-series (InfluxDB?), sampling, dan agen pengumpul. Terasa
terlalu berat untuk platform belajar.

## Apa yang ternyata benar

Untuk kebutuhan dashboard (bukan billing per-byte presisi), **agregasi harian
satu tabel SQLite sudah lebih dari cukup** — dan seluruh sistemnya cuma ~150
baris:

```
request → [buffer in-memory O(1)] →(30 detik)→ [upsert batch ke platform.db]
                                                      ↑
GET /stats ← merge (DB + buffer yang belum di-flush) ─┘
```

## Aha! moment

**1. Write amplification vs single-writer SQLite.**
Insting pertama: tulis row per request → tiba-tiba sadar ini ANTRIANKAN
bencana di SQLite (satu penulis per database!). 100 req/detik = 100 write/detik
hanya untuk statistik. Buffer in-memory + flush batch = ratusan kali lebih
hemat, dan tabel agregat harian (project, date) = 365 baris/tahun per project,
bukan jutaan row.

**2. Observer effect: endpoint stats yang menghitung dirinya sendiri.**
Test pertama gagal misterius: angka +1 dari nol. Penyebab: `/stats` adalah
request project → ikut tercatat → tiap pembacaan dashboard menambah trafik
(feedback loop; test jadi non-deterministik). Solusi: `metricsProjectId()`
mengembalikan null untuk path monitoring — "pengukur tidak mengukur dirinya".
Konsep sama seperti `request.auth` di rules: identitas pemanggil menentukan
pengecualian.

**3. Mengukur bytesOut = bungkus `res.write`/`res.end`, bukan Content-Length.**
`Content-Length` tidak selalu terisi (streaming file M14, SSE M13). Membungkus
write/end di router menangkap SEMUA jalur keluar data — JSON, file, thumbnail,
event SSE — dengan satu titik instrumentasi. Pencatatan di event `finish`
(selesai respons) = handler tidak menanggung biaya apa pun. Kekurangan yang
disadari: SSE baru tercatat saat koneksi tutup (bytes terakumulasi di memori).

**4. Atribusi project = parsing path, bukan konteks handler.**
Tiga prefiks path menentukan pemilik trafik: `/api/p/{pid}/` (end-user),
`/api/admin/projects/{pid}/` (dashboard), `/api/files/{pid}/` (bandwidth file —
yang paling besar!). Dibaca dari `req.path` sebelum routing — nol kopling ke
handler mana pun.

## Keputusan yang dipertahankan

- **Real-time via merge**: stats = DB + buffer yang belum di-flush → angka
  selalu segar tanpa menunggu interval 30 detik.
- **Hari zero-filled 14 hari**: chart dashboard tidak perlu logic "hari kosong".
- **Interval `.unref()`**: flusher tidak menghalangi process exit (penting utk
  test & shutdown bersih).

## Pertanyaan yang masih tersisa

- Retensi: tabel metrics tumbuh selamanya (1 baris/project/hari) — perlu
  cleanup baris > 90 hari ala `cleanupExpiredTokens`.
- Presisi billing: `bytesIn` hanya body request (header tak dihitung) — cukup
  untuk dashboard, belum cukup untuk tagihan.
- Breakdown per endpoint / per status code (4xx vs 2xx) → dimensi tambahan
  di tabel agregat bila kelak dibutuhkan.
