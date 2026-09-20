# M69 v0.2.0 — SDK Kotlin Records

**Tanggal:** 2026-09-20
**Status:** SELESAI (lokal) — 37/37 test hijau, terbukti terhadap server nyata + di emulator Android

## Cakupan

Menambah operasi **Records** ke SDK Kotlin (`id.wekanz.baseforge:kotlin-client:0.2.0`),
melengkapi Auth v0.1.0. Paritas dengan `recordService.ts` di SDK TypeScript.

| Operasi | Method | Catatan |
|---|---|---|
| `getList(page, perPage, options)` | GET | sort/filter/search/expand |
| `getFirstListItem(filter)` | GET | 404 `NOT_FOUND` bila kosong — dipakai SyncRepository |
| `getOne(id)` | GET | envelope `{record}` |
| `create(data)` | POST | bawa `id` untuk custom document ID (M34) |
| `createWithId(id, data)` | POST | sisipkan `id` |
| `update(id, data)` | PATCH | |
| `delete(id)` | DELETE | |

## Keputusan desain

- **`RecordModel` membungkus `JsonObject`**, bukan data class per-koleksi. Skema koleksi
  bebas dan bisa berubah dari dashboard kapan saja; accessor `getString/getLong/getBoolean/has`
  disediakan agar klien tidak bergulat dengan `JsonElement`. Kolom tak dikenal tidak crash
  (`ignoreUnknownKeys`).
- **`BaseForge.collection(name)`** mengembalikan `RecordService` ringan stateless — aman
  dibuat berulang; token tetap dibaca dari `authStore` yang sama, jadi auto-refresh M37
  berlaku juga untuk records.
- **Records = endpoint terautentikasi** → 401 memicu auto-refresh + retry (M37), BUKAN
  `SESSION_EXPIRED` langsung. Ditandai test.

## Bukti

1. `./gradlew test` → **37/37 hijau** (9 unit RecordServiceTest baru + 28 lama).
2. `LiveRecordsTest` ke server `:5100` → siklus meniru SyncRepository: 404 (belum ada
   record) → create → read kembali → update → getOne → delete. **PASSED.**
3. Publish `0.2.0` ke mavenLocal, dikonsumsi ExploreMaps.
4. **Di emulator Android** (ExploreMaps `3576d35`): `assembleRelease` R8 sukses;
   instrumented test `SyncRepositorySdkInstrumentedTest` 2/2 PASSED melawan produksi.

## Pelajaran keras yang ditemukan test

### Rules koleksi punya ENDPOINT TERPISAH — `PATCH .../collections/:name/rules`

`LiveRecordsTest` gagal 403 selama 4 iterasi karena Christy mengirim rules di body
`PATCH /collections/:name` — yang **diam-diam mengabaikannya** (mengembalikan 200 tapi
tidak menyimpan). Rules hanya tersimpan lewat `PATCH .../collections/:name/rules` dengan
field `listRule/viewRule/createRule/updateRule/deleteRule`.

Ini jebakan API yang nyata: respons 200 yang tidak menyimpan apa-apa. **Tanpa integration
test yang benar-benar memukul rules, bug ini tidak akan pernah ketahuan.**

### Assert "token berubah setelah refresh" itu FLAKE

Instrumented test auth gagal 2x pada `assertNotEquals(tokenLama, tokenBaru)` karena JWT
`iat`/`exp` beresolusi detik — register + refresh dalam detik yang sama menghasilkan token
identik. Server terbukti benar merotasi (dicek manual: iat beda → token beda). Solusi:
assert kontrak Ops-10 yang stabil (refresh mengembalikan user + token valid), bukan rotasi.
Rotasi tetap dibuktikan di `LiveAuthTest` dengan `delay(1100)`.

## Catatan jujur

- `ensureCollection` di `LiveRecordsTest` masih memakai `java.net.http` langsung (bukan SDK)
  karena itu operasi **admin**, di luar cakupan SDK klien.
- `getList` belum punya `getFullList` auto-paging (ada di SDK TS) — belum dibutuhkan
  SyncRepository; tambah bila ada konsumen.
