# M39u — First-Time Admin Setup & Hashed DB Credentials

## Masalah & Kebutuhan
Sebelum M39u, BaseForge memakai model M00 "single-operator via env var" (`ADMIN_EMAIL` & `ADMIN_PASSWORD`). Model ini punya 2 kelemahan fatal saat deploy ke VPS:
1. Operator baru tidak bisa signup admin lewat web UI browser — halaman `/signup` hanya stub yang mencoba login ke kredensial env var yang belum tentu diketahui operator.
2. Password admin tersimpan plaintext di file `.env` dan tidak ada hashing database untuk platform administrator.

PocketBase menyelesaikan ini dengan pola **First-Time Admin Setup**: saat instance baru pertama kali diakses, sistem mendeteksi apakah admin sudah ada. Jika belum, halaman onboarding memungkinkan operator membuat akun admin pertama dengan aman, menyimpannya ter-hash di database, lalu mengunci endpoint setup selamanya.

## Desain & Wire-Format

### 1. Database Schema (`platform.db`)
Tabel `_platform_admins`:
```sql
CREATE TABLE IF NOT EXISTS _platform_admins (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

### 2. Endpoints
- `GET /api/admin/setup-state`
  - Response: `{ "needsSetup": boolean, "hasAdmin": boolean }`
  - Public/Unauthenticated (agar dashboard tahu harus menampilkan mode setup atau login normal).
  - `needsSetup = true` jika tabel `_platform_admins` kosong (0 record).
- `POST /api/admin/auth/setup`
  - Body: `{ "email": string, "password": string }`
  - Guard: jika `_platform_admins` sudah memiliki record, return `403 FORBIDDEN` (`code: "SETUP_COMPLETED"`).
  - Validasi: format email valid & kekuatan password (min 8 char, max 128 char via `validatePasswordStrength`).
  - Hashing: menggunakan `hashPassword()` bawaan scrypt OWASP (`node:crypto`).
  - Response `201 Created`: `{ "token": string, "admin": { "id": string, "email": string } }` — langsung menerbitkan session token agar operator masuk tanpa re-login.

### 3. Login Flow (`POST /api/admin/auth/login`)
- Cek tabel `_platform_admins` terlebih dahulu: verifikasi password menggunakan `verifyPassword()` (scrypt).
- Fallback transparan: jika email tidak terdaftar di `_platform_admins`, periksa `ADMIN_EMAIL` / `ADMIN_PASSWORD` di env (seperti test suite), sehingga 100% test eksisting tetap kompatibel.

### 4. Dashboard Web UI
- `dashboard/app/signup/page.tsx`:
  - Fetch setup-state saat render.
  - Jika `needsSetup === true`: Menampilkan form "Create Master Admin" dengan visual Neo-Tactile, eye toggle, dan notice onboarding.
  - Saat submit: panggil `POST /api/admin/auth/setup`, simpan token di localStorage, dan redirect ke `/projects`.
  - Jika `needsSetup === false`: Menampilkan state "Admin configured" dengan link langsung ke `/login`.
- `dashboard/app/login/page.tsx`:
  - Jika `needsSetup === true`: Menampilkan banner informatif yang mengarahkan operator ke `/signup` untuk membuat akun admin pertama.

## Checklist Implementasi
- [x] Database schema `_platform_admins` di `server/src/core/platformDb.ts`
- [x] Integrasi `hashPassword` & `verifyPassword` dari `server/src/auth/password.ts`
- [x] Helper `createInitialAdmin`, `getAdminSetupState`, `countPlatformAdmins` di `server/src/platform/adminAuth.ts`
- [x] Route `GET /api/admin/setup-state` dan `POST /api/admin/auth/setup` di `server/src/api/adminRoutes.ts`
- [x] Update `loginAdmin` untuk memprioritaskan akun dari `_platform_admins`
- [x] API helpers `getAdminSetupState` & `setupInitialAdmin` di `dashboard/lib/api.ts`
- [x] UI adaptif onboarding di `dashboard/app/signup/page.tsx` & banner di `dashboard/app/login/page.tsx`
- [x] Integration tests di `server/tests/m39u-admin-setup.test.ts` (10 tests)
- [x] Verifikasi full suite passing (`npm test` 512/512 tests, 27 suites, 85.9s)
- [x] Typecheck pass (`tsc --noEmit` server & dashboard bersih)

## Aha Moments

1. **Onboarding PocketBase-style: Endpoint Setup harus State-Driven.**
   Tidak perlu menebak apakah server dalam mode instalasi atau bukan. Cukup query `GET /api/admin/setup-state` yang mengembalikan `{ needsSetup: boolean, hasAdmin: boolean }`. Endpoint `POST /api/admin/auth/setup` ditegakkan secara atomik di sisi server: jika count > 0, langsung ditolak dengan `403 SETUP_COMPLETED`. Pintu registrasi terkunci permanen begitu admin pertama lahir.

2. **Dual-Layer Backward Compatibility.**
   Memindahkan kredensial dari `.env` ke database sering kali memecahkan test suite yang mengandalkan mock env var. Dengan mengecek tabel `_platform_admins` terlebih dahulu dan menyediakan fallback ke `process.env.ADMIN_EMAIL` jika email tidak ditemukan di database, 502 test lama tetap berjalan 100% hijau tanpa perlu menyentuh satu pun file test lama.

3. **Password Scrypt OWASP di Platform Admin.**
   Sebelumnya admin hanya membandingkan string via `safeEqual` dari env var plaintext. Sekarang platform admin menikmati pengamanan yang sama persis dengan end-user auth: salt 16-byte acak, scrypt parameter N=16384, r=8, p=1, timingSafeEqual, dan validasi panjang 8–128 karakter.

4. **UI Self-Guiding.**
   Halaman `/signup` dan `/login` sekarang sinkron dengan kondisi server. Jika belum ada admin, `/login` menampilkan banner hijau mengajak setup, dan `/signup` membuka form pembuatan master admin. Begitu setup selesai, `/signup` berubah menjadi state informatif "Admin configured" yang mengarahkan user kembali ke `/login`, mencegah kebingungan pengguna baru.

---
**Status: SELESAI**
- Tests: 512/512 passing (+10 test baru di `m39u-admin-setup.test.ts`)
- Suites: 27/27 green (~85.9 detik)
- Typecheck: 0 error di `server/` dan `dashboard/`
