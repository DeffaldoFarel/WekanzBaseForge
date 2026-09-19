# Ops-13 — Bersihkan SDK dari auth surface B

**Tanggal:** 2026-09-19
**Commit:** (diisi saat commit)
**Konteks:** Tindak lanjut Tahap 4 konsolidasi auth (Ops-12, `d1f5709`).

## Masalah

Ops-12 menghapus tiga route auth-collection dari server:

```
POST /api/p/:pid/collections/:name/auth-with-password   → 404
POST /api/p/:pid/collections/:name/auth-refresh         → 404
POST /api/p/:pid/collections/:name/auth-logout          → 404
```

Tapi pembersihan itu berhenti di `server/`. SDK resmi `@wekanz/baseforge`
(`packages/client/`) masih mengekspor dua method yang memanggil route tersebut:

| Method | Baris | Target |
|---|---|---|
| `collection(n).authWithPassword(identity, password)` | `recordService.ts:144` | `.../auth-with-password` |
| `collection(n).authRefresh()` | `recordService.ts:162` | `.../auth-refresh` |

Keduanya kini **dijamin 404**. Sebuah SDK yang mengekspor method mati lebih buruk
daripada tidak punya method sama sekali: pemanggil mendapat `NOT_FOUND` yang
terlihat seperti salah konfigurasi project, bukan seperti API yang dipensiunkan.

## Inventaris pemakaian (grep sebelum hapus)

| Konsumen | Pemakaian | Dampak |
|---|---|---|
| `dashboard/` (SDK vendored) | **nol** | tidak ada |
| ExploreMaps (Kotlin/OkHttp) | tidak pakai SDK JS | tidak ada |
| Bookmark Manager | pakai `client.auth.*` (surface A) | tidak ada |
| `packages/client/tests/client.test.ts:222` | 1 test | **harus diganti** |

Tidak ada konsumen nyata. Tidak ada rilis npm publik untuk 0.2.1 yang perlu
dijaga kompatibilitasnya.

## Keputusan: hapus tuntas, bukan stub yang melempar error

Alternatif yang dipertimbangkan: biarkan method-nya ada tapi `throw new Error(...)`
dengan pesan penunjuk pengganti. Ditolak karena:

- Nol konsumen eksternal — tidak ada yang perlu diberi pesan transisi.
- SDK masih `0.x`; menghapus method adalah perubahan yang wajar di rentang versi ini.
- Stub yang melempar error tetap muncul di autocomplete dan `.d.ts`, jadi tetap
  mengiklankan kapabilitas yang tidak ada.

Pengganti untuk pemanggil: `client.auth.login()` / `client.auth.refresh()`
(`authService.ts`), yang menembak surface A dan sudah hidup.

## Perubahan

- [x] Hapus `authWithPassword()` + `authRefresh()` dari `recordService.ts` (173 → 141 baris; potong deterministik dari baris 141 sampai penutup class)
- [x] Import yatim: **tidak ada** — kedua method hanya memakai `this.request` + `authStore` yang tetap dipakai method lain
- [x] Test `client.test.ts:222` diganti **dua** test: (a) `bf.auth.refresh()` end-to-end, (b) gerbang regresi `typeof col.authWithPassword === 'undefined'`
- [x] Bump `0.2.1` → `0.3.0`
- [x] `README.md` SDK: tidak pernah menyebut kedua method — nihil perubahan
- [x] `npx tsc --noEmit -p .` → 0 error
- [x] `npm run test:client` → **14/14 pass** (server test lokal 5100, `DATA_DIR` sementara, dibersihkan setelahnya)
- [x] Re-vendor ke **WekanzDashboard** `lib/baseforge-sdk/` (bukan `dashboard/` di repo ini — lihat Aha #3); `tsc` dashboard 0 error; **TIDAK di-commit** (aturan user)
- [x] Suite server: **635/635 pass, 33 suites** — identik dengan Ops-12 (server tidak berubah sebaris pun)
- [ ] Deploy VPS: **SENGAJA TIDAK** (keputusan user) — server tidak berubah, VPS tetap `0605398`

## Status

**SELESAI.** SDK `@wekanz/baseforge` 0.3.0 — tsc 0, client 14/14, server 635/635,
vendored di WekanzDashboard diperbarui (lokal, tsc 0, belum di-commit di repo itu).
Tidak di-deploy (server tidak berubah).

## Aha Moments

1. **Menghapus route server tidak otomatis membersihkan SDK-nya — dan `tsc` tidak akan memberi tahu.**
   Ops-12 lolos `tsc` + 635 test hijau padahal SDK masih mengekspor dua method
   yang menembak URL 404. Tipe SDK tidak tahu route mana yang ada di server;
   satu-satunya yang menangkapnya adalah test *integrasi* client terhadap server
   nyata — dan test itu tidak ikut `npm test` (hanya `npm run test:client`).
   Pelajaran: setiap penghapusan endpoint wajib di-grep di **tiga lapis**
   (`server/src/api`, `server/src/core`, `packages/client`) — prinsip yang sudah
   tercatat di skill untuk *audit kesiapan*, ternyata berlaku sama untuk *penghapusan*.

2. **Test pengganti harus mempertahankan NIAT, bukan bentuk — dan boleh menutup celah yang lebih besar.**
   Niat test lama: "login lalu perbarui sesi". Saat memetakan ke surface A,
   ketahuan `bf.auth.refresh()` **tidak pernah** ditutup test client mana pun
   (register/login/me/logout ada, refresh tidak). Penggantian ini menambah
   cakupan, bukan sekadar mengganti URL. Test baru juga mengunci kontrak Ops-10
   (`refresh` mengembalikan `user` dari DB) dari sisi konsumen SDK.

3. **"Vendored ke dashboard" ambigu di repo yang punya folder `dashboard/`.**
   Instruksi lama "re-vendor ke `dashboard/lib/baseforge-sdk/`" salah alamat:
   folder itu tidak ada di repo BaseForge. Yang dimaksud adalah
   **WekanzDashboard** (`E:\MyApps\WekanzDashboard\wekanz-dashboard\lib\baseforge-sdk\`,
   repo terpisah dengan aturan komit sendiri). Dashboard admin BaseForge tidak
   memakai SDK (memanggil admin API langsung via `lib/api.ts`). Nama repo harus
   disebut lengkap di catatan operasional.

4. **`rm -rf` di resep VENDORED.md adalah bom waktu yang mendokumentasikan dirinya sendiri.**
   Resep resmi di file itu menyuruh `rm -rf .../baseforge-sdk/*` — yang menghapus
   VENDORED.md itu sendiri (pitfall Ops-7 terulang karena resepnya tidak ikut
   dikoreksi). Diganti: `cp -r` overwrite + bandingkan daftar file `dist/` vs
   folder tujuan untuk menemukan sisa yatim (kali ini: nol).

5. **Misteri "`test:client` exit 1 sejak Ops-8" ternyata BUKAN bug — melainkan prasyarat lingkungan.**
   Test client memakai kredensial admin hardcode (`admin@baseforge.local` /
   `admin123`) dan server nyata di `:5100`. Dijalankan tanpa server dengan env
   itu → gagal di `before()` → exit 1. Dengan server yang benar: 14/14 hijau
   **sebelum dan sesudah** perubahan Ops-13. Catatan lama di skill "belum
   diinvestigasi" bisa ditutup.

## Pertanyaan tersisa

- `npm run test:client` butuh server manual di `:5100` dengan env spesifik —
  layak dibungkus script yang menyalakan server sementara sendiri (seperti
  test server yang memakai port 0)? Belum dikerjakan; di luar scope Ops-13.
- Collection `type=auth` masih bisa dibuat dari dashboard admin BaseForge
  (`CreateCollectionModal`). Setelah Ops-12 tidak ada endpoint login untuknya,
  jadi tipe itu hanya bermakna sebagai "tabel dengan `password_hash` yang
  disaring". Perlu keputusan produk: sembunyikan opsi, atau biarkan untuk data
  yang memang butuh kolom hash. **Belum diputuskan.**
