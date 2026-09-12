# M10u — Dashboard: User Management + Rules Editor

> **Konsep:** UI admin untuk mengelola end users (auth users) dan mengatur API rules per collection — fase Auth jadi "kelihatan".

## 🎯 Tujuan

Setelah M08-M11, mesin auth lengkap tapi hanya bisa dipakai via API.
Dashboard perlu:
1. **Halaman Auth** — daftar end users, tambah, reset password, hapus
2. **Rules Editor** — atur 5 rules per collection langsung dari UI

## 📐 Perubahan

```
server/src/api/userAdminRoutes.ts → baru
  GET/POST /api/admin/projects/:pid/auth-users
  GET/PATCH/DELETE /api/admin/projects/:pid/auth-users/:uid
  GET/PATCH /api/admin/projects/:pid/collections/:name/rules

dashboard/lib/api.ts            → client untuk kedua endpoint
dashboard/app/projects/[id]/auth/page.tsx → halaman Auth (user mgmt)
dashboard/app/.../[collection]/page.tsx   → + Rules Editor card
```

## 🔑 Desain UI

- User management: tabel + inline reset password + delete dengan confirm
- Rules editor: 5 input (List/View/Create/Update/Delete) dengan badge
  status (🔒 Admin / 🌐 Publik / 🧮 Rule); ketik `null` untuk admin-only
- Password tidak pernah ditampilkan — server tidak mengirim hash

## 📝 Aha! Moments

### Aha! #1 — Integration test HTTP menangkap bug yang lolos unit test
Test M11 semua lulus dengan ctx manual `{ auth: { id: 'usr_aaa' } }`.
Saat diverifikasi via HTTP nyata: `createRule` menolak create yang valid!
Akar masalah: id user asli dari JWT (`sub`) ≠ id fiktif di test. Unit test
memakai asumsi yang tidak diuji — end-to-end dengan server sungguhan
menangkapnya dalam 2 menit. Pelajaran: unit test bukti logika, integration
test bukti dunia nyata. Keduanya wajib.

### Aha! #2 — "null" sebagai konvensi UI
Rule di server bertipe `string | null`. Di input teks, kita konvensikan:
ketik `null` (persis) → admin-only; kosong → publik; lainnya → rule string.
Konvensi sederhana ini menghindari toggle/dropdown tambahan.

### Aha! #3 — Hash tidak pernah keluar: terbukti via JSON
Verifikasi: `JSON.stringify(listResponse)` tidak mengandung `password_hash`.
Dengan `listAuthUsers` yang memetakan row → AuthUser (tanpa hash), hash
TIDAK PERNAH bisa bocor — keamanan by construction, bukan by discipline.

## ✅ Status: SELESAI — verifikasi end-to-end via HTTP nyata (register → login → create → list) — 2026-09-12
