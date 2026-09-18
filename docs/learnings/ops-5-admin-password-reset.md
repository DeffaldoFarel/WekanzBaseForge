# Ops-5 — Reset password admin platform (recovery saat terkunci)

**Status:** SEDANG BERJALAN
**Asal:** real-test WekanzDashboard (2026-09-18) — `server/.env` di VPS masih
berisi `admin@baseforge.wekanz.id` dari bootstrap, padahal admin aktif
adalah akun Google user. Login balas 401, dan `/api/admin/auth/setup`
juga 401 ("already set up"). Tanpa jalur recovery, satu-satunya jalan
adalah menyunting `_platform_admins` langsung di SQLite — berbahaya dan
tidak terdokumentasi.

## Analisis masalah

Reset password **auth user project** sudah ada (M23, `emailRoutes.ts`).
Yang hilang adalah **platform admin** — akun yang bisa membuat/menghapus
project seluruh server.

Syarat keras:
- **Harus bekerja saat server mati** (skenario utama: lupa password,
  tidak bisa login, tidak bisa minta endpoint).
- **Tidak boleh bergantung pada `.env`** — justru `.env` yang basi
  adalah penyebab terkunci.
- **Tidak boleh mengekspos endpoint publik** — recovery adalah operasi
  offline yang memerlukan akses filesystem ke `platform.db`.

## Desain: sub-perintah CLI server

Tambahkan sub-perintah `reset-admin-password` ke **`server/src/cli/index.ts`**
(CLI yang sudah ada, tinggal tambah case di `switch (command)`).

Kenapa CLI dan bukan endpoint:
- Skenario terkunci berarti server tidak bisa diakses lewat HTTP.
- CLI berjalan di host yang sama dengan `platform.db`, jadi bisa membuka
  DB langsung tanpa token.
- Sudah ada infrastruktur: `cli/index.ts` punya arg parser, `homedir`,
  `mkdirSync`, dsb. Tinggal tambah satu case.

### Bentuk

```
npx tsx src/cli/index.ts reset-admin-password --email <email> --password <baru>
```

- `--email`: admin yang akan diubah. Harus ada di `_platform_admins`
  (diverifikasi dengan `SELECT` dulu, bukan `INSERT` baru).
- `--password`: password baru. Minimal 8 karakter (pakai
  `validatePasswordStrength` yang sudah ada di `auth/password.js`).
- **Tanpa `--password`** → CLI meminta interaktif via `readline`
  (tidak echo ke terminal, tidak masuk history shell).

### Alur

1. Parse `--email` dan `--password`.
2. Buka `platform.db` lewat `initPlatformDb()` (yang sudah ada —
   idempotent, membuat tabel bila belum ada).
3. `SELECT id, email FROM _platform_admins WHERE lower(email) = ?`.
   - Tidak ketemu → `console.error` + `process.exit(1)`.
4. `hashPassword(password)` (fungsi yang sama dengan `createInitialAdmin`
   — konsistensi algoritma terjaga).
5. `UPDATE _platform_admins SET password_hash = ?, updated = ... WHERE id = ?`.
6. `console.log('Password reset untuk <email>')` + `process.exit(0)`.

### Kenapa bukan endpoint `POST /api/admin/auth/reset-password`

- Butuh server jalan → melingkar (server mati = tidak bisa reset).
- Butuh token admin → melingkar (lupa password = tidak ada token).
- Recovery harus offline, seperti `sqlite3` CLI atau `passwd` di Unix.

## Test plan (`tests/ops-5-admin-password-reset.test.ts`)

1. Buat admin awal lewat `createInitialAdmin` (fungsi yang sudah ada).
2. Verifikasi login dengan password lama berhasil.
3. Jalankan CLI `reset-admin-password --email ... --password ...`.
4. Verifikasi login dengan password lama **gagal** (401).
5. Verifikasi login dengan password baru **berhasil**.
6. Verifikasi `--email` yang tidak ada → exit code 1 + pesan jelas.
7. Verifikasi password lemah → exit code 1 + pesan jelas.

## Risiko & mitigasi

- **CLI bisa dijalankan siapa saja di host** → mitigasi: dokumentasikan
  bahwa CLI ini setara `passwd` — siapa pun yang punya akses filesystem
  ke `platform.db` sudah bisa mengubahnya. Tidak menambah permukaan serangan.
- **Password di command line masuk history shell** → mitigasi: tanpa
  `--password`, CLI meminta interaktif via `readline` (tidak echo).
- **Salah email** → mitigasi: verifikasi `SELECT` dulu, exit 1 bila tidak ada.

## Keputusan desain

- **Tidak ada endpoint publik** — recovery adalah operasi offline.
- **Tidak membuat admin baru** — hanya mengubah password yang sudah ada
  (membuat admin baru adalah tanggung jawab `createInitialAdmin` saat
  setup pertama).
- **Pakai fungsi yang sudah ada** (`hashPassword`, `validatePasswordStrength`)
  — tidak mengulang algoritma hash.
