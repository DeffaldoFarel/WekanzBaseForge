# Ops-15 — Tegakkan `disabled` di seluruh jalur auth

**Tanggal:** 2026-09-20
**Commit:** (lokal — belum di-commit atas permintaan user)
**Hasil:** `tsc` 0 error · **645/645 test hijau** · 10 test Ops-15 baru · diverifikasi di server lokal
**Konteks:** Temuan saat membandingkan auth BaseForge vs Supabase/Appwrite/PocketBase.
Sudah tercatat sejak M47 sebagai "belum ditegakkan", belum pernah diperbaiki.

## Masalah — dibuktikan di server lokal sebelum kode disentuh

```
admin POST /auth-users/:uid/disable → 200, GET user → disabled: true
user   POST /auth/login             → 200 + accessToken   ← seharusnya ditolak
       GET  /auth/me (token itu)    → 200                 ← seharusnya ditolak
```

Tombol **Disable** di dashboard admin menyimpan kolom, tapi **tidak satu pun jalur
auth membacanya**. Fitur ini mengiklankan perlindungan yang tidak ada.

## Empat celah (semua harus ditutup di pass yang sama)

| # | Jalur | File | Kondisi sekarang |
|---|---|---|---|
| 1 | Login password | `auth/users.ts` `verifyAuthCredentials` | tidak cek `disabled` |
| 2 | Refresh | `auth/tokens.ts` `refreshAccessToken` | JOIN `_auth_users` tapi **hardcode `disabled: false`** (baris 123) — user disabled bisa memperpanjang sesi selamanya |
| 3 | Login OAuth + MFA challenge | `api/oauthRoutes.ts:205`, `api/mfaRoutes.ts:202` | memanggil `issueTokens()` langsung — jalur sampingan yang melewati #1 |
| 4 | Access token yang sudah terbit | `auth/jwt.ts` `verifyToken` | **stateless** (tanpa DB) — token 15 menit tetap sakti setelah disable |

## Desain

**Prinsip: satu gerbang, bukan tambalan di sembilan tempat.**

- **#1 + #3 → gerbang di `issueTokens()`** (`auth/tokens.ts`). Semua 4 pemanggil
  (login, register, oauth, mfa) lewat sini. `issueTokens` membaca `disabled`
  dari DB dan melempar `AuthUserDisabledError` bila 1. Login/OAuth/MFA otomatis
  tertutup tanpa menyentuh route-nya. `verifyAuthCredentials` juga ikut cek
  (defense in depth + pesan error yang tepat).
- **#2 → `refreshAccessToken`** baca `u.disabled` dari JOIN yang sudah ada, return
  `null` bila 1. Hapus hardcode `disabled: false`.
- **#4 → revoke saat disable, bukan cek DB per request.** `verifyToken` dibiarkan
  stateless (itu keputusan arsitektur yang benar — 9 pemanggil, hot path).
  Sebagai gantinya `setAuthUserDisabled(…, true)` memanggil `revokeAllUserTokens`
  yang **sudah ada** (`tokens.ts:141`) tapi belum pernah dipakai di jalur ini.
  Konsekuensi jujur: access token yang sudah terbit tetap valid **maksimal 15 menit**
  (TTL). Ini trade-off yang sama dengan Supabase (JWT stateless, ban efektif saat
  refresh berikutnya). Dicatat di docs, bukan disembunyikan.

Kode HTTP: **403 `USER_DISABLED`** untuk login/refresh user disabled — bukan 401,
karena kredensialnya *benar*; yang ditolak adalah akunnya. Klien bisa membedakan
"password salah" dari "akun dinonaktifkan" dan menampilkan pesan yang jujur.
Enable ulang (`disabled=false`) **tidak** perlu revoke apa pun.

## Perubahan

- [x] `auth/tokens.ts`: `AuthUserDisabledError` + gerbang di `issueTokens`; `refreshAccessToken` baca `u.disabled` (hardcode `disabled: false` dihapus)
- [x] `auth/users.ts`: `verifyAuthCredentials` mengembalikan user apa adanya (route yang memutuskan); `setAuthUserDisabled` kembali murni flag
- [x] `api/userAdminRoutes.ts`: `/disable` → `initAuthTokensTable` + `revokeAllUserTokens`, balas `revokedSessions`
- [x] `api/authRoutes.ts`: helper `respondUserDisabled` + guard login (sebelum MFA) + tangkap error di refresh
- [x] `api/oauthRoutes.ts` + `api/mfaRoutes.ts`: tangkap `AuthUserDisabledError` → 403
- [x] `tests/ops15-disabled-enforcement.test.ts`: **10 test**, 4 celah + oracle + enable ulang + non-regresi
- [x] `docs/api-reference.md` + `docs/admin-api.md`: 403 `USER_DISABLED`, jendela 15 menit, tabel endpoint admin dilengkapi
- [x] `tsc` 0 → **645/645** → jurnal
- [ ] commit → push → deploy → verifikasi produksi (menunggu perintah user)

## Verifikasi di server lokal (setelah perbaikan)

```
admin disable        : HTTP 200 {"success":true,"disabled":true,"revokedSessions":1}
login                : HTTP 403 USER_DISABLED   token=tidak ada     (sebelumnya 200 + token)
refresh              : HTTP 401 INVALID_REFRESH (token sudah di-revoke)
password salah       : HTTP 401 INVALID_CREDENTIALS  ← tidak bocorkan status akun
access token lama    : HTTP 200                 ← batas yang diakui (TTL ≤15 mnt)
login setelah enable : HTTP 200 + token         ← pulih penuh
```

## Aha Moments

1. **`verifyAuthCredentials` bukan tempat yang tepat untuk gerbangnya.** Tiga dari
   empat celah (register, OAuth, MFA) tidak pernah memanggilnya. Gerbang yang
   benar adalah `issueTokens()` — satu-satunya pintu yang dilewati **semua**
   penerbitan sesi. Menambal di `verifyAuthCredentials` saja akan terlihat
   "selesai" padahal OAuth dan MFA masih bocor.

2. **Urutan cek `disabled` vs MFA menentukan.** Kalau dicek setelah cabang MFA,
   user disabled tetap menerima `mfaToken` — setengah sesi yang seharusnya tidak
   pernah ada. Guard dipasang tepat setelah verifikasi password.

3. **403 vs 401 bukan kosmetik.** Tapi password *salah* pada akun disabled harus
   tetap 401 generik; kalau tidak, endpoint login jadi oracle untuk memetakan
   akun mana yang ada dan dinonaktifkan tanpa perlu tahu password. Ada test
   khusus untuk ini.

4. **Import siklik memaksa keputusan desain yang lebih baik.** `tokens.ts` sudah
   mengimpor `users.ts`, jadi `setAuthUserDisabled` tidak bisa memanggil
   `revokeAllUserTokens`. Percobaan pertama: menyalin SQL + DDL `_auth_tokens` ke
   `users.ts` — salah, skema langsung melenceng (index `idx_auth_tokens_user`
   hilang). Solusi benar: revoke di **lapisan route**, yang memang boleh
   mengimpor keduanya. Satu definisi skema tetap di satu tempat.

5. **`_auth_tokens` dibuat lazily → `/disable` bisa 400 "no such table".**
   Ketahuan dari test M47 yang membuat user lewat admin tanpa pernah login.
   Selalu `initAuthTokensTable(db)` sebelum menyentuh tabel itu dari jalur admin.

6. **Test M47 bernama "login ditolak" padahal tidak menguji login sama sekali** —
   isinya komentar "cukup buktikan kolom bisa di-set". Nama test yang berbohong
   menyembunyikan lubang ini berbulan-bulan. Kalau perilaku belum ada,
   test-nya harus gagal (RED), bukan diganti nama jadi seolah lulus.
