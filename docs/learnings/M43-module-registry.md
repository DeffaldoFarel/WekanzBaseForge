# M43 — Module Registry: `$lib` untuk Functions

## Masalah

Function BaseForge adalah satu string kode — tidak bisa `import`/`require`
(sandbox memang sengaja tanpa akses module). Konsekuensinya, logika domain yang
dipakai banyak function harus **disalin ke setiap function**.

Ini bukan masalah teoretis: WekanzDashboard punya `shared/domain.ts` (386 baris,
19 ekspor: `calculateStreak`, `computeMonthlyBillSummary`, `deriveCreditCardStats`,
dst) yang di-`import` oleh 7 dari 8 function-nya. Di BaseForge hari ini, satu
perbaikan bug di `calculateStreak` harus disalin ke 7 function — persis masalah
drift yang ingin dihindari (logika domain dashboard di-mirror byte-for-byte ke
web + backend agar jawabannya identik).

## Desain

Registry modul **per project** di tabel `_function_modules`:

```
id, name (UNIQUE), code, created, updated
```

Function menyebut dependensinya lewat kolom baru `modules` (JSON array nama);
saat eksekusi, modul-modul itu **dieval di dalam isolate lebih dulu** dan
ekspornya disuntikkan sebagai `$lib.<name>`.

### Permukaan guest

```js
const streak = $lib.domain.calculateStreak(habit, logs);
const summary = $lib.billing.computeMonthlyBillSummary(bills);
```

### Mekanisme: IIFE → `module.exports` gaya CJS

Setiap modul dibungkus factory function yang menyediakan `module` + `exports`,
lalu hasilnya disimpan di registry `$lib`:

```js
var $lib = {};
$lib['domain'] = (function(module, exports) {
  // ... kode modul, boleh `exports.foo = ...` atau `module.exports = ...`
})({ exports: {} }, {}).exports;
```

Kenapa bentuk ini: (a) tidak perlu `eval`/`new Function` global — tiap modul
tertutup dalam scope-nya; (b) mendukung dua gaya CJS yang paling umum; (c)
urutan eval = urutan array `modules`, sehingga dependensi antar-modul
deterministik (modul yang di-load lebih dulu bisa dipakai yang berikutnya
lewat `$lib` yang sudah terisi).

### TypeScript: strip tipe, bukan full build

`domain.ts` memakai `export interface` + type annotation. Alih-alih bundler,
pakai `typescript` yang **sudah menjadi dependensi server**: satu opsi
`ts.transpileModule` dengan `Module: CommonJS` + target ES2020 menghapus tipe
dan mengubah `export` menjadi `exports.*` — persis bentuk yang factory butuhkan.
Tanpa dependensi baru, tanpa build step, dan outputnya CJS-ready.

Modul boleh ditulis JS langsung (tanpa `export`) atau TS — keduanya lolos jalur
yang sama (`transpileModule` pada JS murni = pass-through + normalisasi export).

### Batas & guard

- **Maks 10 modul per function**, maks 10 modul per project dibatasi total kode
  **256 KB per modul**. Cukup untuk registry domain; mencegah penyalahgunaan
  sebagai file storage.
- **Nama** `^[a-z][a-z0-9_]{0,63}$` (seperti collection/function).
- Modul berjalan di **sandbox yang sama** dengan function — ia mewarisi batas
  memori/timeout function, dan (seperti function) tidak punya akses host.
- Modul dipanggil function dengan `dbAccess: true` **bisa** memakai `$db`/`$env`
  milik function pemanggil (mereka satu isolate) — didokumentasikan.

### Keputusan: prepend ke prelude, bukan eval terpisah

Alternatif: eval tiap modul lewat `context.eval` terpisah. Ditolak karena (a)
prepended ke prelude berarti modul dan `$db`/`$env`/`$http` hidup di scope yang
sama tanpa mekanisme tambahan; (b) satu titik eval = satu tempat timeout
diberlakukan; (c) registry `$lib` sederhana — objek biasa, bukan Proxy khusus.

### Admin API

```
PUT    /api/admin/projects/:pid/modules/:name            { code }
GET    /api/admin/projects/:pid/modules                  → [{ name, sizeBytes, updated }]
GET    /api/admin/projects/:pid/modules/:name            → { name, code, updated }
DELETE /api/admin/projects/:pid/modules/:name
```

Function menautkan modul lewat `modules: string[]` pada POST/PATCH function.

## Berkas yang berubah

- `server/src/core/moduleRegistry.ts` — **baru**: tabel + validasi + CRUD +
  kompilasi TS→CJS + penyusunan prelude modul.
- `server/src/core/functionsStore.ts` — kolom `modules` (JSON), validasi.
- `server/src/core/functionRunner.ts` — sisipkan prelude modul, opsi `modules`.
- `server/src/api/functionRoutes.ts` — 4 rute modul + teruskan `modules`.
- `server/src/core/triggerExecutor.ts` / `scheduler.ts` — teruskan `modules`.
- `docs/functions.md` — section `$lib`.
- `server/tests/m43-module-registry.test.ts` — **baru**.

## Checklist

- [x] `moduleRegistry.ts` (tabel, validasi, CRUD, TS→CJS)
- [x] Kolom `modules` + prelude di runner
- [x] 4 rute + wire invoke/trigger/scheduler
- [x] Batas (10/function, 256KB/modul, format nama)
- [x] Test suite M43
- [x] Full suite hijau
- [x] Jurnal + README

## Aha Moments

### 1. Import yang hilang adalah bug arsitektur, bukan keterbatasan sandbox

Mudah menganggap "sandbox tidak bisa import" sebagai fakta alam. Padahal yang
hilang hanyalah *registry*: satu tempat untuk menaruh kode bersama dan satu
konvensi untuk memuatnya. Begitu keduanya ada, keterbatasan itu lenyap tanpa
membuka akses module/host yang memang sengaja ditutup. Membedakan "tidak boleh"
(keamanan) dari "belum disediakan" (fitur) menentukan apakah sebuah batas
perlu ditembus atau cukup dilengkapi.

### 2. Factory CJS mengalahkan module loader pintar untuk kasus ini

Godaannya meniru `import` ES atau `require` Node. Keduanya menyeret resolver,
cache, dan path. Factory IIFE dengan `module.exports` menyelesaikan kasus
nyata (logika domain bersama) dalam belasan baris tanpa satu pun dari itu.
Memilih bentuk yang paling kecil yang menyelesaikan kasus konkret — bukan yang
paling mirip platform besar — menjaga sandbox tetap bisa diaudit.

### 3. Dependensi yang sudah ada mengalahkan dependensi yang tepat

TypeScript compiler sudah ada di server untuk `tsc --noEmit`. Memakainya untuk
strip tipe (`transpileModule`) berarti fitur TS di modul hadir **tanpa satu
baris dependensi baru** — tidak ada esbuild/swc untuk dipasang, diverifikasi,
dan dijaga versinya. Menambah dependensi adalah keputusan jangka panjang;
memakai yang sudah ada sering kali cukup.

### 4. Urutan eval adalah kontrak, bukan detail implementasi

Begitu modul bisa bergantung pada modul lain, urutan eval berhenti menjadi
detail dan menjadi kontrak: array `modules` dieval berurutan, dan `$lib` terisi
bertahap. Mendokumentasikan ini (bukan membiarkannya kebetulan) mencegah bug
halus di mana modul B diam-diam bergantung pada A tetapi dinyatakan sebelumnya.

### 5. `module.exports` dan `exports` harus menunjuk objek yang sama

Rancangan pertama factory CJS salah: `(function(m, e){...})({ exports: {} }, {})`
memberi `exports` objek BARU yang terpisah dari `module.exports`, sehingga
`exports.x = ...` menempel di objek yang dibuang dan `.exports` selalu kosong —
semua 6 test pemakaian gagal dengan `Cannot read properties of undefined`.
Perbaikannya pola CJS yang benar: satu objek `module.exports`, alias `exports`
menunjuknya, kembalikan `module.exports`. Alias CJS bukan dua objek; ia dua
nama untuk SATU objek.

### 6. Memperbaiki bug lama yang disembunyikan kebetulan

Dua test M43 (yang menangkap error dari eval-promise) memicu path throw di
`runFunctionCode` yang tidak di-race — dan mengekspos bug lama: timer
wall-clock tidak pernah di-`clearTimeout`, jadi setiap eksekusi menyisakan
timer yang meledak SETELAH function selesai sebagai unhandled rejection
("asynchronous activity after the test ended"). Bug ini ada sejak M25/M18a
tetapi tak terlihat karena jarang ada yang memicu path throw tanpa race.
M43 memperbaikinya dengan benar: simpan handle timer, `clearTimeout` di
`finally`, dan `wallClock.catch(() => {})` untuk mencegah unhandledRejection
bila wallClock tidak memenangkan race. M15a (test timeout `while(true)`)
tetap hijau — perilaku timeout yang sah tidak berubah.

Status: SELESAI — 10 test M43, full suite 544/544 (nol async-activity).
