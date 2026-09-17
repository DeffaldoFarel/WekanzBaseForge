# M34 — Custom Document ID (kompatibilitas Appwrite/PocketBase)

## Apa yang kupikirkan sebelumnya
ID record = urusan server, selalu auto-generate. Client yang minta ID sendiri
itu anti-pattern — biar database yang pegang identitas. Migrasi data dari
backend lain tinggal "ganti ID" saat import.

## Apa yang ternyata benar
Backend nyata (Appwrite, PocketBase, Supabase) SEMUA mengizinkan custom
document ID saat create — karena migrasi data HARUS preserve ID: referensi
lintas dokumen, URL attachment (`md5(path)` ala Appwrite), preference key
`${userId}_${prefKey}`, dan dedup idempoten import ulang. Tanpa ini,
migrasi ke BaseForge = reindex semua foreign key di data user.

## Aha! moment

**1. Ekstraksi `data.id` harus terjadi SEBELUM field validation loop.**
`id` bukan field skema — kalau tidak dihapus dari `data` dulu, loop validasi
menolaknya ("Field 'id' does not exist"). Urutan: extract → validate format →
cek duplikat → `delete data.id` → baru validasi field lain.

**2. Fail-fast duplikat ala UNIQUE constraint.** Cek `SELECT id WHERE id = ?`
sebelum validasi field lain — error duplikat lebih berguna muncul duluan
daripada user mengisi semua field valid lalu kena 409 di akhir. Pola yang sama
dengan constraint UNIQUE SQLite (evaluated at insert, tapi kita naikkan ke awal).

**3. Regex ID = irisan aman antar backend.** Appwrite: `[a-zA-Z0-9._-]`, max
36, no leading underscore. PocketBase: 28 char, `[a-zA-Z0-9_]`. BaseForge pakai
`[a-zA-Z0-9_-]{1,64}` — cukup lebar buat semua skema migrasi, cukup sempit
untuk jadi nama file/path yang aman (tanpa titik = tak bisa traversal).

**4. `DuplicateIdError` harus jadi 409, bukan 400.** Duplicate = konflik state
resource (punya semantik "resource exists"), bukan malformed request. Beda
kode ini yang bikin SDK client bisa membedakan "retry dengan ID lain" vs
"perbaiki payload".

**5. Rantai resolusi ID jadi 3 tingkat:**
```
customId ?? preGeneratedId ?? generateId()
```
`preGeneratedId` (M14 multipart) dan custom ID user tidak saling tabrakan —
user yang eksplisit menang, sistem fallback.

## Keputusan yang dipertahankan

- Custom ID opsional (backward compatible — tanpa `data.id` = perilaku lama)
- 409 `DOCUMENT_ID_TAKEN` + fail-fast di awal validasi
- SDK: method terpisah `createWithId(id, data)` — bukan opsi di `create()`,
  supaya signature membaca niat eksplisit

## Pertanyaan yang masih tersisa

- Semantik upsert (`createOrUpdate`)? Appwrite punya — berguna untuk import
  idempoten yang boleh overwrite
- Import bulk dengan opsi `skipDuplicates` vs `fail-fast` (ala Supabase
  `upsert(onConflict)`)
- Reserve kata terlarang? (mis. ID yang collision dengan query param `id`)
