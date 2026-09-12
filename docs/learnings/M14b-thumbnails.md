# M14b — Thumbnails ala PocketBase (Lazy + Cache, pakai Sharp)

> **Konsep:** `?thumb=WxH` di URL file menghasilkan thumbnail on-demand — format & semantik persis PocketBase, generate lazily, cache di disk.

## 🎯 Latar

Riset: PocketBase punya thumbnail BUILT-IN (first-class); Firebase tidak
di core tapi menyediakan official extension `storage-resize-images`
(based on Sharp). Keputusan user: **Pilihan A — gaya PocketBase**,
dengan Sharp sebagai satu-satunya native dependency.

## 🧠 Semantik Format (identik PocketBase)

```
?thumb=100x300   → crop ke 100x300 (dari center)
?thumb=100x300t  → crop dari top
?thumb=100x300b  → crop dari bottom
?thumb=100x300f  → fit di dalam 100x300 (tanpa crop, preserve ratio)
?thumb=0x300     → resize by height (preserve ratio)
?thumb=100x0     → resize by width  (preserve ratio)
```

MIME didukung: jpg, jpeg, png, gif, webp. Non-image → error ramah 400.
Lazily: dibuat saat request PERTAMA, cache di
`thumbs_<filename>/<spec>_<filename>` — request berikutnya baca disk.

## 📁 Perubahan

```
core/thumbs.ts            → parseThumbSize + isThumbable + getThumb + deleteThumbs
api/storageRoutes.ts      → handler async + ?thumb= query param integration
package.json              → + sharp (native, prebuilt binaries)
tests/m14b-thumbs.test.ts → 12 test
```

## 📝 Aha! Moments

### Aha! #1 — Lazy generation: upload tetap cepat, biaya dibayar per-ukuran
Berbeda dengan Firebase (generate saat upload via storage trigger),
PocketBase membuat thumb LAZILY: request pertama → proses → cache →
request berikutnya baca disk. 10 thumb sizes dikonfigurasi tapi hanya
2 yang diakses = hanya 2 yang pernah digenerate. Upload tidak pernah
melambat.

### Aha! #2 — fit:'fill' = STRETCH, bukan preserve ratio!
Bug pertama: 0x50 memakai fit:'fill' → hasil 200x50 (ratio rusak!).
Sharp hanya preserve ratio kalau KITA TIDAK set fit. Fix: hapus fit →
100x50 ✅. Lesson: 'fill' berarti "penuhi kedua dimensi", bukan "auto".

### Aha! #3 — Cache key = spesifikasi mentah
`thumbs_photo.jpg/100x100_photo.jpg` — string spesifikasi dipakai
langsung sebagai nama. Parse ulang tidak pernah terjadi untuk cache
hit. deleteThumbs menghapus folder sekaligus (tidak ada orphan).

### Aha! #4 — withoutEnlargement = pertahanan DoS default
Regex membatasi format (1-5 digit), tapi 99999x99999 tetap valid
secara format. Sharp `withoutEnlargement: true` menolak memperbesar →
output ≤ ukuran asli — DoS lewat ukuran thumb gagal by construction.

## ✅ Status: SELESAI — 12/12 test, 200/200 total; E2E HTTP: 800x600 → ?thumb=100x100 = 100x100 crop; 0x150=200x150; 300x0=300x225; 200x200f=200x150; invalid=400; non-image=400 — 2026-09-12
