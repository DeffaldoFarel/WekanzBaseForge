# M47 — Halaman Auth Users di Dashboard BaseForge

**Status:** SEDANG BERJALAN
**Asal:** kebutuhan nyata dari WekanzDashboard (2026-09-19) — auth users internal
(`_auth_users`) tidak bisa dicek di dashboard BaseForge; hanya ada Auth Settings
(OAuth). Verifikasi migrasi/user harus lewat API/script manual.

## Analisis masalah

BaseForge punya dua sistem auth:
1. **`_auth_users` internal** — dipakai SDK client (login/register/refresh).
   Tidak ada UI untuk melihat/mengelola user ini.
2. **`type: 'auth'` collection** — bisa dilihat di Collections, tapi tidak
   dipakai SDK kita.

Dashboard BaseForge menampilkan pesan *"User management follows the unified
Auth Collections pattern"* — mengasumsikan user memakai collection auth,
padahal SDK kita memakai internal `_auth_users`.

## Kebutuhan

Halaman **Auth Users** di dashboard BaseForge yang menampilkan:
- Daftar user dari `_auth_users` (email, verified, created, last login).
- Aksi dasar: verifikasi manual, reset password, disable user.
- Hanya admin platform yang bisa mengakses (sama seperti endpoint admin lain).

## Desain

### Backend (server)

Endpoint admin baru di `adminRoutes.ts`:

| Method | Path | Fungsi |
|---|---|---|
| `GET` | `/api/admin/projects/:pid/auth-users` | List users (paginasi, search) |
| `GET` | `/api/admin/projects/:pid/auth-users/:uid` | Detail user |
| `PATCH` | `/api/admin/projects/:pid/auth-users/:uid` | Update (verify, disable) |
| `POST` | `/api/admin/projects/:pid/auth-users/:uid/reset-password` | Reset password |

**Bukan** mengubah `_auth_users` jadi collection — tetap internal, hanya
ditambah endpoint admin untuk membacanya.

### Frontend (dashboard)

Halaman baru di `dashboard/src/pages/AuthUsers.tsx`:
- Tabel user: email, verified (badge), created, last login, status (active/disabled).
- Search by email.
- Aksi per baris: Verify/Unverify, Reset Password, Disable/Enable.
- Hanya tampil untuk admin yang sudah login.

## Test plan (`tests/m47-auth-users-ui.test.ts`)

1. `GET /api/admin/projects/:pid/auth-users` → 200, bentuk `{ items, totalItems }`.
2. `GET` dengan `?search=` → filter bekerja.
3. `GET /:uid` → detail user.
4. `PATCH /:uid` dengan `{ verified: true }` → user terverifikasi.
5. `PATCH /:uid` dengan `{ disabled: true }` → user disabled (login ditolak).
6. `POST /:uid/reset-password` → password berubah, login lama gagal.
7. Non-admin → 401/403.

## Risiko & mitigasi

- **Menambah permukaan serangan** → mitigasi: endpoint hanya untuk admin
  platform (token admin), sama seperti endpoint project/collection lain.
- **Password hash bocor** → mitigasi: response TIDAK menyertakan
  `password_hash` (hanya email, verified, created, lastLogin, disabled).
- **User bisa disable diri sendiri** → mitigasi: disable hanya berlaku untuk
  auth users (bukan admin platform).

## Keputusan desain

- **Tidak mengubah `_auth_users` jadi collection** — internal tetap internal,
  hanya ditambah endpoint admin untuk membacanya.
- **Reset password via admin** — tidak butuh email flow (admin sudah
  terautentikasi).
- **Disable ≠ delete** — user bisa di-enable kembali.
