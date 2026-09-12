# M14u — Dashboard: File Browser & Upload UI

> **Konsep:** upload file langsung dari dashboard (modal record), preview gambar thumbnail di tabel, dan link download — semuanya memakai API multipart M14a.

## 🎯 Tujuan

M14a memberi API upload, tapi admin butuh CARA VISUAL:
1. **Modal record** punya input file untuk field type `file`
2. **Tabel data** menampilkan thumbnail (untuk gambar) + link download
3. Upload tetap lewat endpoint publik yang sama — dashboard hanyalah client

## 📐 Perubahan

```
lib/api.ts:
  createRecordWithFiles / updateRecordWithFiles → FormData multipart
  fileUrl(projectId, collection, recordId, filename) → URL serving
  FieldDef.options: + maxSize, mime (accept attribute)

app/.../[collection]/page.tsx:
  RecordModal: + fileValues state, FieldInput case 'file'
    (input[type=file], multiple utk maxSelect>1, preview existing)
  Tabel: file field render thumbnail 32px + 📎 link
  FIELD_TYPES (database page): + 'file'
```

## 💡 Detail Desain

- **FormData tanpa Content-Type manual** — browser yang set boundary;
  kalau kita set sendiri, boundary hilang dan server gagal parse.
- **File baru vs existing**: modal memisahkan `values` (teks) dan
  `fileValues` (File baru). Field file TANPA file baru dikirim sebagai
  string nama lama — tidak tertimpa null saat edit record lain.
- **Thumbnail hanya untuk ekstensi gambar** (png/jpg/gif/webp/avif);
  file lain hanya 📎 link — konsisten dengan whitelist server.

## 📝 Aha! Moments

### Aha! #1 — viewRule otomatis melindungi FILE juga
Verifikasi browser: file di disk bisa di-serve 200 dengan admin token,
tapi 404 untuk anonymous — karena viewRule collection = null (admin-only).
File mengikuti izin record pemiliknya TANPA kode tambahan: storageRoutes
memanggil getRecord dulu (yang mengecek viewRule). Satu mekanisme,
dua aset terlindungi. Set viewRule publik → file langsung bisa diakses
publik. Keamanan komposisional!

### Aha! #2 — DataTransfer untuk simulasi upload di test browser
<input type=file> tidak bisa diisi via JS biasa (security). Tapi
DataTransfer + dt.items.add(file) lalu input.files = dt.files bekerja —
inilah cara test otomatis meng-upload file tanpa interaksi manusia.

### Aha! #3 — Form state form builder itu tricky
Pertama kali buat collection via UI: field kedua gagal ikut (state
ter-skip). Pelajaran React: controlled input butuh setter prototype +
dispatchEvent('input') untuk programmatic change yang terdeteksi React.
Selalu verifikasi state form SEBELUM submit saat testing UI otomatis.

## ✅ Status: SELESAI — verifikasi browser nyata end-to-end — 2026-09-12
