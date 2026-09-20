# M69 — SDK Kotlin (`@wekanz/baseforge-kotlin`) v0.1.0: Auth

**Tanggal:** 2026-09-20
**Commit:** (lokal)
**Status:** SELESAI (lokal, belum commit) — 27 test hijau, terbukti terhadap server nyata

## Mengapa ini, mengapa sekarang

Dari 15 gap di `COMPARISON.md`, ini satu-satunya yang **setiap hari** menggigit aplikasi Wekanz
sendiri: ExploreMaps menulis 573 baris REST manual (`AuthRepository` 248 + `SyncRepository` 325)
plus pemanggilan OkHttp yang tersebar di `LocationTrackingService` dan `MapViewModel`. Setiap
perubahan kontrak server (Ops-10 `refresh` mengembalikan `user`, Ops-15 kode `USER_DISABLED`,
Ops-16 `profile`) harus ditemukan dan disalin tangan ke Kotlin — persis drift yang SDK TS
sudah tutup untuk web.

## Keputusan (dari user, 2026-09-20)

| Keputusan | Pilihan | Konsekuensi |
|---|---|---|
| Lokasi | `packages/kotlin-client/` di repo BaseForge | Satu sumber kontrak dengan SDK TS; **tanpa `package.json`** agar npm workspaces `packages/*` tidak menyentuhnya |
| Stack | OkHttp 4.12 + kotlinx.serialization 1.7 | Tipe aman; ExploreMaps tetap Gson di sisi app — SDK mengembalikan data class, bukan JSON |
| Cakupan v0.1.0 | **Auth saja** | login/register/refresh/me/updateProfile/logout, auto-refresh 401, `AuthStore` pluggable |
| Migrasi ExploreMaps | Pass terpisah | SDK diuji unit + integrasi ke server lokal dulu; app dimigrasikan setelah review |
| Distribusi | JitPack (tag git) | Nol infrastruktur; `com.github.DeffaldoFarel.WekanzBaseForge:kotlin-client:<tag>` |

## Kontrak yang WAJIB paritas dengan SDK TS (`packages/client`)

Ini bukan port bebas — setiap perilaku di bawah sudah dibayar mahal lewat bug nyata:

| Perilaku | Asal | Aturan |
|---|---|---|
| Auto-refresh 401 lalu retry **sekali** | M37 | Skip bila path = `/auth/refresh`; refresh gagal → `clear()` + `SESSION_EXPIRED` |
| **Refresh singleton** — banyak 401 serentak = SATU POST refresh | M37 | `Mutex` + cek ulang token setelah lock (double-checked) |
| `refresh()` menyimpan `user` dari respons | Ops-10 | Jangan buang; itu alasan endpoint-nya diubah |
| Login `403 USER_DISABLED` bukan `SESSION_EXPIRED` | Ops-15 | 403 ≠ 401; jangan auto-refresh, jangan clear store |
| `profile` opsional di `AuthUser`, absen = `null` | Ops-16 | `ignoreUnknownKeys = true` WAJIB — field baru dari server tidak boleh crash klien lama |
| `updateProfile` partial: field tak disertakan tidak disentuh | Ops-9/16 | `encodeDefaults = false`; `null` eksplisit = kosongkan |
| Register auto-login (201 + token) | M09u | Tidak ada login kedua setelah register |
| Error shape `{error:{code,message}}` | router | `ClientResponseException(status, code, message)` |
| `AuthStore.onChange` listener | authStore.ts | Untuk Compose `StateFlow` di app |

## Yang SENGAJA tidak dibangun di v0.1.0

- Records/Files/Realtime — v0.2.0 setelah Auth terbukti di ExploreMaps.
- Persistence `AuthStore` — SDK hanya `MemoryAuthStore` + interface; DataStore adalah
  urusan app (SDK tidak boleh bergantung pada AndroidX).
- OAuth/MFA — ExploreMaps tidak memakainya; menambah surface tanpa konsumen = drift.

## Struktur

```
packages/kotlin-client/
  build.gradle.kts            ← Kotlin/JVM library (bukan Android library — JVM murni)
  settings.gradle.kts
  gradle/wrapper/             ← wrapper 8.13, sama dengan ExploreMaps
  src/main/kotlin/id/wekanz/baseforge/
    BaseForge.kt              ← entry: BaseForge(baseUrl, projectId, authStore, httpClient)
    AuthStore.kt              ← interface + MemoryAuthStore
    ClientResponseException.kt
    internal/HttpCore.kt      ← request + auto-refresh (padanan baseService.ts)
    auth/AuthService.kt
    auth/Models.kt            ← @Serializable data classes
  src/test/kotlin/.../
    HttpCoreTest.kt           ← MockWebServer: 401→refresh→retry, singleton, 403 tidak refresh
    AuthServiceTest.kt        ← MockWebServer: bentuk request/response per endpoint
    integration/LiveAuthTest.kt ← ke localhost:5100 nyata (skip bila server mati)
```

**JVM murni, bukan Android library** — alasan: bisa diuji dengan `./gradlew test` tanpa
emulator/SDK Android, bisa dipakai dari Compose Desktop/KMP kelak, dan OkHttp + kotlinx
memang JVM-agnostic. Batas: `minSdk 26` ExploreMaps (Java 8 API) → target `jvmTarget = 17`
aman karena AGP 8 desugar.

## Bukti (semua sudah dijalankan)

1. `./gradlew test` → **22 unit test hijau** (MockWebServer, server HTTP nyata di loopback).
2. `LiveAuthTest` ke server `:5100` → **5/5 hijau**: siklus register → me → updateProfile →
   refresh (token berubah) → logout → me 401; login salah password; email ganda ditolak;
   `profile` null di project polos; custom field `bio` terbaca di project ber-field.
3. Proyek Gradle konsumen **di luar repo** (`%LOCALAPPDATA%/Temp/kt-consumer`) memakai
   artefak mavenLocal → `REGISTER ok / ME ok / UPDATE ok / LOGOUT ok isValid=false /
   LOGIN-SALAH code=INVALID_CREDENTIALS sessionExpired=false`.
4. 1.126 baris Kotlin (kode + test).

## Dua bug yang ditemukan test, bukan ditemukan setelah rilis

### 1. 401 anonim disalahartikan sebagai sesi kedaluwarsa — **ada juga di SDK TypeScript**

`baseService.ts:127` mengecek `res.status === 401 && !isRetry` lalu melempar
`SESSION_EXPIRED` untuk **semua** 401 kecuali endpoint refresh. Akibatnya
`auth.login()` dengan password salah mengembalikan `SESSION_EXPIRED`, bukan
`INVALID_CREDENTIALS` — layar login menampilkan "sesi berakhir" padahal user hanya
salah ketik. Lebih buruk: bila masih ada sesi lama di store, login yang gagal
diam-diam menembak `/auth/refresh` milik user LAIN.

Perbaikan di Kotlin: parameter eksplisit `allowAutoRefresh = false` pada
login/register/refresh, **plus** syarat `token.isNotEmpty()` sebagai sabuk kedua.
Ditandai dua test (`HttpCoreTest` + `AuthServiceTest` regresi) dan satu live test.

> **SDK TypeScript masih membawa bug ini.** Belum diperbaiki — di luar cakupan M69,
> dan mengubahnya mengubah kode error yang dilihat aplikasi web yang sudah jalan.
> Perlu keputusan user (kandidat Ops-17).

### 2. `implementation` vs `api` pada coroutines — cacat packaging

SDK mengekspos fungsi `suspend` di API publiknya, tapi
`kotlinx-coroutines-core` dideklarasikan `implementation`, sehingga tidak ikut ke POM
sebagai `compile`. Konsumen gagal dengan `Unresolved reference 'coroutines'`.

**Ini tidak akan pernah ketahuan dari `./gradlew test` di dalam repo SDK** — test
berada di modul yang sama dan melihat semua dependensi. Hanya proyek konsumen
terpisah yang menangkapnya. Karena itu langkah "uji konsumen nyata" wajib ada setiap
kali menambah tipe baru ke API publik.

## Catatan jujur

- `LiveAuthTest` **lulus secara diam-diam** saat env tidak diset (ia `return` lebih awal
  dan tetap dihitung PASSED). Jadi "27 passed" pada mesin tanpa server sebenarnya
  22 test nyata + 5 no-op. Angka sebenarnya hanya valid bila env diset.
- Belum diuji di **perangkat/emulator Android** — baru JVM. Risiko yang tersisa: aturan
  R8/ProGuard untuk kotlinx.serialization pada build rilis (perlu `-keep` rules;
  akan terbukti saat migrasi ExploreMaps).
- `publishToMavenLocal` terbukti; **JitPack belum** — perlu tag git dulu.
