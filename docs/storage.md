# Storage & Files

BaseForge menyediakan dua cara menyimpan file, dengan tujuan berbeda. Memilih yang tepat
menghindarkan kebingungan di kemudian hari.

| | **Record File** | **Bucket File** |
|---|---|---|
| Terikat pada | sebuah **record** (field type `file`) | tidak terikat apa pun (**decoupled**) |
| Dapatkan URL lewat | `getUrl(collection, recordId, filename)` | `getBucketUrl(fileId)` |
| Khas dipakai untuk | avatar record, lampiran per-baris | lampiran editor/notes, aset aplikasi |
| Dibuat lewat | upload saat create/update record | `POST /storage/upload` |

---

## 1. Record File (file ter-attach ke record)

Sudah didokumentasikan di
[REST API Reference — Upload File](api-reference.md). Ringkasnya:

```bash
# Upload saat membuat record (multipart)
curl -X POST $BASE/api/p/:pid/collections/posts/records \
  -H "Authorization: Bearer $TOKEN" \
  -F "title=Halo" \
  -F "cover=@foto.jpg"

# URL view-nya
GET $BASE/api/files/:pid/posts/:recordId/foto.jpg
```

Thumbnail (bila field type `image`): tambahkan `?thumb=100x100`.

---

## 2. Bucket File (decoupled storage)

> **M35.** Satu bucket per project, tidak perlu dibuat dulu. File punya `fileId` sendiri
> dan bisa dipakai di mana saja — inilah yang dipakai dashboard untuk lampiran notes.

### Upload

`POST /api/p/:pid/storage/upload` — **multipart/form-data**, field `file`
(opsional field `fileId` untuk ID deterministik, mis. saat migrasi).

```bash
curl -X POST $BASE/api/p/:pid/storage/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@dokumen.pdf" \
  -F "fileId=opsional-custom-id"
```

Respons (201):

```json
{
  "fileId": "a1b2c3…",
  "filename": "dokumen.pdf",
  "contentType": "application/pdf",
  "size": 152300,
  "url": "https://baseforge.example.com/api/files/:pid/bucket/a1b2c3…"
}
```

### Mengakses file

```
GET /api/files/:pid/bucket/:fileId
```

URL ini yang disimpan di konten (mis. field `gambar` pada notes) — bukan URL bertoken,
jadi aman ditulis langsung ke record/HTML.

### List file milik user yang login

```
GET /api/p/:pid/storage/bucket
Authorization: Bearer <token user>
```

```json
{ "files": [ { "fileId": "…", "filename": "…", "contentType": "…", "size": 0, "uploadedAt": "…", "uploadedBy": "uid" } ] }
```

### Hapus

```
DELETE /api/p/:pid/storage/bucket/:fileId
```

User biasa hanya bisa menghapus **file miliknya sendiri**.

---

## Autentikasi & batasan

- **Upload / list / delete** butuh token user (Bearer) atau API key (`X-API-Key`).
- **View URL** (`/api/files/…`) bersifat publik bila rules koleksi mengizinkan; untuk
  bucket, file bisa diakses siapa pun yang tahu URL-nya — perlakukan URL sebagai rahasia
  ringan (seperti link Google Drive "anyone with the link").
- Ukuran & tipe file dibatasi konfigurasi server (lihat Admin API → storage settings).

## SDK

Kedua operasi tersedia di SDK:

```ts
// TypeScript
const res = await bf.files.uploadToBucket(file, "foto.jpg");
const url = bf.files.getBucketUrl(res.fileId);
```

```kotlin
// Kotlin (v0.3.0+)
val res = bf.files.uploadToBucket(bytes, "foto.jpg", "image/jpeg")
val url = bf.files.getBucketUrl(res.fileId) // serahkan ke Coil/Glide
```

---

## Migrasi dari Appwrite / Firebase

Field `fileId` pada upload memungkinkan **ID deterministik** sehingga URL lama bisa
dipetakan 1:1 tanpa mengubah konten yang sudah ada. Pola yang terbukti: pertahankan
`fileId` asal, lalu rewrite hanya host-nya. (Lihat jurnal
[learnings/m69-kotlin-sdk-files](learnings/m69-kotlin-sdk-files.md) untuk pelajaran
penting soal enkripsi storage Appwrite.)
