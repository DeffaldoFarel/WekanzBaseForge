# M69 v0.3.0 — SDK Kotlin Files

**Tanggal:** 2026-09-20
**Status:** SELESAI (lokal) — 46/46 test hijau, terbukti di emulator Android

## Cakupan

Menambah operasi **Files** (bucket storage) ke SDK Kotlin
(`id.wekanz.baseforge:kotlin-client:0.3.0`). Paritas dengan `filesService.ts` di SDK TS.

| Operasi | Method/URL | Catatan |
|---|---|---|
| `getUrl(collection, recordId, filename, thumb?)` | `GET /api/files/{pid}/{col}/{rid}/{file}` | URL untuk file ter-attach ke record |
| `getBucketUrl(fileId)` | `GET /api/files/{pid}/bucket/{fileId}` | URL bucket (decoupled) |
| `uploadToBucket(bytes, filename, fileId?)` | `POST /api/p/{pid}/storage/upload` | multipart, optional determinate fileId |
| `deleteBucketFile(fileId)` | `DELETE /api/p/{pid}/storage/bucket/{fileId}` | |
| `listBucketFiles()` | `GET /api/p/{pid}/storage/bucket` | milik user yang login |

## Keputusan desain

- **Upload menerima `ByteArray` + filename**, BUKAN `java.io.File` — JVM murni, tidak
  bergantung filesystem, dan paling natural dipakai dari Android (bitmap → ByteArray).
- **Multipart dibangun manual** (OkHttp `MultipartBody`) — OkHttp sudah jadi dependency,
  tidak perlu library tambahan.
- **`getUrl`/`getBucketUrl` mengembalikan String URL**, bukan melakukan request — sama
  seperti SDK TS (klien yang memutuskan cara memuatnya: Coil/Glide di Android).
- **Files = endpoint terautentikasi** (upload/delete/list), kecuali `getUrl`/`getBucketUrl`
  yang hanya menyusun string.

## Bukti (sudah dijalankan)

1. `./gradlew test` → **46/46 hijau** (7 unit FilesServiceTest baru + 39 lama).
2. `LiveFilesTest` ke server `:5100` → upload → getBucketUrl mengembalikan **bytes
   identik** (round-trip biner utuh, bukan re-encode) → list memuat file → delete → 404. PASSED.
3. Publish `0.3.0` ke mavenLocal, dikonsumsi ExploreMaps.
4. **Di emulator Android** (`FilesSdkInstrumentedTest`): render bitmap marker 96x96 di
   perangkat → kompres PNG → upload via SDK → unduh → **bytes identik**. PASSED (2.639s).

## Keputusan yang penting dicatat

- `HttpCore.requestRaw()` ditambahkan untuk multipart (OkHttp `RequestBody` mentah) —
  JSON string tidak bisa mengangkut multipart. Auth + auto-refresh M37 tetap berlaku sama.
- Upload menerima `ByteArray` (bukan `java.io.File`) — JVM murni, natural untuk Android
  (Bitmap.compress → ByteArrayOutputStream).
- `getUrl`/`getBucketUrl` hanya menyusun String URL — klien (Coil/Glide) yang memuatnya,
  sama seperti SDK TS.
