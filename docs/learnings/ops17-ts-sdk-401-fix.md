# Ops-17 — SDK TypeScript: 401 pada endpoint anonim disamarkan jadi `SESSION_EXPIRED`

**Tanggal:** 2026-09-20
**Status:** SELESAI (lokal, belum commit) — 20/20 test client hijau, dashboard tsc bersih

## Bug

`packages/client/src/services/baseService.ts` (~baris 127) mengubah **semua** respons 401
(kecuali endpoint refresh) menjadi `ClientResponseError(401, code='SESSION_EXPIRED')`,
apa pun kode error asli dari server. Ditemukan saat menulis test untuk SDK Kotlin (M69);
di sana sudah diperbaiki.

## Dampak pada aplikasi yang sudah jalan

| Skenario | Seharusnya | Yang dilihat aplikasi (bug) |
|---|---|---|
| Login salah password | `INVALID_CREDENTIALS` | `SESSION_EXPIRED` — layar login bilang "sesi berakhir" |
| Login gagal saat ada sesi lama di store | error kredensial, sesi lama tak disentuh | SDK diam-diam menembak `/auth/refresh` milik sesi LAMA; bila refresh gagal → store di-clear |
| `mfaChallenge` salah kode TOTP | `INVALID_MFA_TOKEN`/sejenisnya | `SESSION_EXPIRED` |
| `confirmPasswordReset` token kedaluwarsa | `INVALID_TOKEN` | `SESSION_EXPIRED` |

## Perbaikan (selaras dengan SDK Kotlin M69)

1. `RequestOptions.allowAutoRefresh?: boolean` (default `true`) — penanda eksplisit.
2. `baseService.requestWithRetry`: 401 → auto-refresh **hanya** bila opsi itu tidak `false`.
3. `authService`: tandai endpoint anonim — `login`, `register`, `requestVerification`,
   `verifyEmail`, `requestPasswordReset`, `confirmPasswordReset`, `mfaChallenge`
   (+ `refresh` sebagai pertahanan berlapis di samping path-check yang sudah ada).
4. Endpoint terautentikasi (`me`, `updateProfile`, `mfaEnroll/Verify/Disable`, records,
   files, dst.) TIDAK berubah — 401 di sana tetap auto-refresh + retry (M37).

## Keputusan desain: TANPA sabuk `token.isNotEmpty()`

SDK Kotlin memakai sabuk tambahan "request tanpa token tidak pernah auto-refresh".
Di TS sabuk itu **tidak** dipasang, karena akan membunuh skenario pemulihan yang legit:
sesi yang tersimpan sebagian (refreshToken ada, accessToken kosong — mis. app crash saat
refresh, atau tab lain membersihkan access token) masih bisa pulih lewat auto-refresh.
Sabuk eksplisit per-endpoint sudah cukup. Perbedaan ini dicatat; penyelarasan Kotlin
menyusul bila disetujui user.

## Batas perubahan perilaku (harus dilaporkan ke user)

- Login gagal kini melempar `INVALID_CREDENTIALS`, bukan `SESSION_EXPIRED`. Aplikasi yang
  punya handler khusus `SESSION_EXPIRED` (mis. redirect ke login) tidak akan lagi terpicu
  pada login gagal — yang memang benar.
- **SDK vendored di 3 aplikasi (`lib/baseforge-sdk/`) TIDAK ikut berubah** — re-vendor
  hanya atas permintaan user.

## Bukti (sudah dijalankan)

1. `tsc --noEmit` → 0 error di `packages/client` **dan** `dashboard`.
2. `tests/ops17-401-login.test.ts` → **6/6 hijau** melawan server `:5100` nyata:
   - **Uji jebakan**: login salah password dengan `refreshToken` jebakan di store →
     `INVALID_CREDENTIALS`, dan jebakan tetap utuh — bukti tidak ada tembakan
     `/auth/refresh`. (Sebelum fix: jebakan akan ditembak, di-401, dan store di-clear.)
   - `mfaChallenge` / `confirmPasswordReset` token ngawur → error asli (400/401),
     bukan `SESSION_EXPIRED`.
   - Non-regresi M37 (2 test): access token dirusak → `me()` auto-refresh + retry 200;
     refreshToken ngawur → `SESSION_EXPIRED` + store cleared.
3. `npm test` client → **20/20 pass, 0 fail** (14 lama + 6 baru).
4. Dashboard tidak mengimpor paket SDK (memakai `fetch` sendiri) → tidak terdampak.

## Pelajaran

- **Bug ini ditemukan oleh test SDK lain (Kotlin M69), bukan oleh test SDK TS sendiri.**
  Suite TS sebelumnya tidak pernah mengetes 401 pada endpoint anonim — semua test login
  memakai kredensial benar. Celah yang sama ada di dua SDK = celah desain, bukan typo.
- Konstruktor `BaseForge` TS menerima **options object** (`{baseUrl, projectId, authStore}`),
  BUKAN argumen posisi seperti SDK Kotlin. Pemanggilan positional menghasilkan
  `projectId=''` dan URL `/api/p//...` — gagal total dalam ~3 ms, bukti test memang berjalan.
- Perubahan error-code adalah perubahan kontrak perilaku: aplikasi yang sudah jalan harus
  diinfokan sebelum SDK mereka di-re-vendor.
