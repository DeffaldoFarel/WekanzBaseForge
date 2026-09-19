# Ops-9 — `PATCH /auth/me`: menutup gap paritas sebelum konsolidasi auth

**Tanggal**: 2026-09-19
**Status**: SELESAI (Tahap 1 dari konsolidasi 2 auth surface → 1)
**Commit**: (diisi saat commit)

---

## Konteks

BaseForge punya DUA surface auth yang sama-sama hidup:

| | A — platform auth | B — auth collection |
|---|---|---|
| Endpoint | `/api/p/:pid/auth/{register,login,refresh,logout,me}` | `/api/p/:pid/collections/:name/{auth-with-password,auth-refresh,auth-logout}` |
| Storage | tabel internal `_auth_users` | collection `type='auth'` |

User meminta dikerucutkan jadi SATU agar tidak membingungkan. Keputusan: **menangkan
surface A**, karena empat subsistem (MFA, OAuth, email verify/reset, admin user
management) terikat ke `_auth_users`; memilih B berarti mem-port ulang ~1.300 baris.

Ops-9 adalah **Tahap 1**: tutup dulu gap kapabilitas di surface A, sebelum satu-satunya
konsumen surface B (ExploreMaps) dipindahkan.

---

## Ekspektasi

Mengira konsolidasi bisa langsung dimulai dari sisi klien (tukar URL saja), karena
kedua surface sudah berbagi `issueTokens()` dan `verifyToken()`.

## Temuan

Surface B menyimpan user sebagai **record collection biasa**, jadi profil user bisa
di-update lewat `PATCH /collections/:name/records/:id` yang sudah ada. Surface A
**tidak punya padanannya sama sekali** — `_auth_users` hanya bisa diubah lewat route
ADMIN (`/api/admin/projects/:pid/auth-users/...`). Artinya memindahkan konsumen ke
surface A tanpa menambah apa pun = user kehilangan kemampuan mengubah profilnya sendiri.

---

## Aha Moments

### 1. Konsolidasi dua surface adalah pekerjaan BACKEND, bukan pekerjaan klien
Godaannya adalah menukar URL di klien lalu menyebut migrasi selesai. Tapi surface yang
"kalah" hampir selalu memiliki kapabilitas yang tidak dimiliki pemenang — di sini:
update profil mandiri. Urutan yang benar adalah **paritas dulu, baru migrasi**, karena
setelah klien dipindah, kehilangan kemampuannya akan tampak sebagai "regresi aplikasi"
padahal akarnya keputusan arsitektur. Bukti terukur: surface B punya jalur update
profil lewat record API sejak awal; surface A nol jalur non-admin sampai Ops-9.

### 2. Endpoint "update diri sendiri" wajib punya DAFTAR-TOLAK eksplisit, bukan sekadar daftar-terima
Implementasi naif hanya membaca `name` dan `avatarUrl` lalu mengabaikan sisanya diam-diam.
Itu berbahaya: klien yang mengirim `{verified: true}` mendapat **200 OK** dan menyimpulkan
dirinya sudah terverifikasi. Perilaku yang benar adalah menolak keras field sensitif
(`email`, `password`, `verified`, `disabled`, `id`) dengan `400` — masing-masing punya
jalur terverifikasi sendiri. Diam bukan penolakan; diam adalah kebohongan yang sukses.

### 3. Uji privilege escalation dengan membuktikan STATE, bukan status code
Assertion `assert.equal(res.status, 400)` saja tidak membuktikan apa pun tentang keamanan —
400 bisa datang dari parser, dari validasi tipe, atau dari mana saja. Setiap test penolakan
di Ops-9 dilanjutkan dengan pembuktian state: setelah `{email: ...}` ditolak, `GET /auth/me`
harus masih menunjukkan email lama; setelah `{password: ...}` ditolak, login dengan password
LAMA harus tetap 200. Ini varian langsung dari pitfall repo "status hijau di atas data kosong
tidak membuktikan apa-apa".

### 4. Partial update butuh pembedaan `absen` vs `null`, dan keduanya harus diuji
`'name' in body` (bukan `body.name !== undefined`) adalah yang membuat `null` bermakna
"kosongkan" sementara field yang tidak dikirim bermakna "jangan sentuh". Dua semantik ini
mudah tertukar dan tidak akan ketahuan oleh `tsc`. Test membuktikan keduanya terpisah:
kirim `{name}` saja → `avatarUrl` bertahan; kirim `{avatarUrl: null}` → benar-benar kosong.
Body `{}` sengaja dibuat no-op 200 (idempotent), bukan 400, agar klien yang mengirim diff
kosong tidak perlu penanganan khusus.

---

## Keputusan

- `updateAuthUserProfile()` di `auth/users.ts` sebagai gerbang tunggal — route tidak
  menyusun SQL sendiri (pola yang sama dengan `setAuthUserVerified`/`setAuthUserDisabled`).
- Hanya `name` + `avatarUrl` yang bisa diubah. Email/password tetap lewat jalur terverifikasi.
- Batas panjang ditegakkan di route (255 untuk `name`, 2048 untuk `avatarUrl`) agar pesan
  error spesifik dan tidak bergantung pada batas kolom SQLite.
- Body kosong = 200 no-op, bukan error.

## Pertanyaan tersisa

- Apakah surface A perlu endpoint ganti email dengan verifikasi (saat ini hanya ada
  di jalur admin)? Belum dibutuhkan konsumen mana pun — ditunda sampai ada permintaan nyata.
- Custom field profil (kelebihan surface B) sengaja TIDAK diporting; user memutuskan
  collection `profiles` dibuat nanti saat benar-benar dibutuhkan.

---

**Test**: `tests/ops9-auth-me-patch.test.ts` — 16/16 pass.
