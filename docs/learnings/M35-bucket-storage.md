# M35 — Bucket Storage: file decoupled dari record

## Apa yang kupikirkan sebelumnya
File = field di record (desain M14). Itu model yang rapi: lifecycle file
mengikuti record, gak ada orphan. Tambah "bucket" cuma bikin dua sistem file
paralel dan duplikasi konsep.

## Apa yang ternyata benar
Dua model itu melayani DUA kasus pakai berbeda, dan BaaS nyata punya dua-duanya:

1. **Record-coupled** (M14): avatar profil, lampiran form — file hidup-mati
   dengan record. Bersih.
2. **Bucket/decoupled** (M35): rich-text editor (tiptap) embed fileId di HTML,
   catatan dengan banyak gambar, file yang direferensikan lintas record.
   File-nya hidup SENDIRI, record cuma nyimpen ID-nya.

WekanzDashboard attachments 100% pola #2 (upload → fileId → embed → resolve
URL). Tanpa bucket, tiap gambar editor harus "dimiliki" record mana? —
pertanyaan yang bahkan gak punya jawaban untuk contenteditable HTML.

## Aha! moment

**1. Determinate fileId = kunci migrasi.** Upload dengan fileId eksplisit
yang SAMA overwrite file lama (bukan error 409!) — persis semantik Appwrite.
Ini bikin import dari Appwrite idempoten: `md5(storagePath)` dihitung ulang,
file sama → fileId sama → overwrite, referensi URL lama tetap valid.

**2. Serve publik + ID unguessable = permission model yang cukup.** Pattern
Appwrite `read("any")` per-file ternyata bisa disederhanakan: bucket files
diserve anonymous (Cache-Control public, inline), keamanannya dari
fileId acak 32-char. Yang TETAP auth: list (hanya file milikmu) dan delete
(owner/admin). Enumerasi diblok, akses langsung dibuka.

**3. Bukan refactor — reuse.** Multipart parser (M14), MIME sniffing,
`resolveUser` (JWT/API key) semua dipakai ulang. Yang baru cuma:
tabel index metadata + path file tanpa `collection/recordId`. ~kode baru
jauh lebih kecil dari yang kukira.

**4. `uploadedBy` disimpan buat ownership, bukan serve.** Metadata owner
dipakai list/delete auth ("hanya file milikmu"), TAPI serve gak cek —
karena URL-nya memang dimaksudkan dibagikan (embed di editor). Memisahkan
"siapa punya file" dari "siapa boleh lihat URL" itu inti desain bucket.

## Keputusan yang dipertahankan

- 5 endpoint: upload (multipart), serve by fileId (public), list (auth),
  delete (auth owner), admin delete
- Determinate fileId → overwrite (idempoten migrasi)
- SDK: `getBucketUrl(fileId)` — tanpa project/collection context
- Cache-Control `public, max-age=3600` di serve (file immutable per ID)

## Pertanyaan yang masih tersisa

- Orphan cleanup: record-coupled punya `clean-orphans` admin — bucket
  butuh versinya (file yang gak direferensikan apa pun)
- Signed URL / expiring token untuk file privat (roadmap M45)
- Upload resumable/chunked untuk file besar (pesaing ada)
