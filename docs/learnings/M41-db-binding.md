# M41 — `$db` Binding: Akses Database In-Process untuk Functions

## Masalah

Sandbox function (M18a isolated-vm) sengaja tidak punya akses jaringan maupun host.
M25 membuka satu pintu saja: `$http.send`. Konsekuensinya, sebuah function yang ingin
membaca/menulis datanya sendiri harus melakukan HTTP ke server**nya sendiri** —
padahal `DatabaseSync` project ada di proses yang sama, di memori yang sama.

Tiga akibat nyata:

1. **SSRF guard memblokir loopback** (`httpSandbox.ts:106`) — `localhost` harus
   didaftarkan literal di `httpAllow`, yaitu melemahkan guard yang sengaja dibuat.
2. **Kredensial plaintext** — function butuh API key/JWT di badan kodenya untuk
   memanggil API sendiri; tidak ada secret store (M42 nanti).
3. **Latensi berlipat** — agregasi atas ratusan record jadi ratusan round-trip HTTP,
   masing-masing melewati parse URL → DNS → fetch → JSON, lalu dibatasi anggaran
   wall-clock function (default 2000 ms).

Kompetitor tidak bisa menghindari ini: Supabase Edge Function harus menganggap
Postgres sebagai layanan remote ter-pool, Appwrite Function harus HTTP ke API.
BaseForge satu proses dengan SQLite-nya — keunggulan struktural yang belum dipakai.

## Desain

Binding `$db` di dalam isolate, memakai pola bridge yang sama persis dengan `$http`
(M25): `ivm.Reference` di host + shim Promise di guest, argumen `{ copy: true }`,
callback `{ reference: true }`, `async: true`.

### Permukaan API (guest)

```js
const res = await $db.collection('investments').list({
  filter: 'userId = "u1"', sort: '-created', page: 1, perPage: 100,
});
// → { page, perPage, totalItems, totalPages, items: [...] }

const rec  = await $db.collection('investments').get(id);        // → record | null
const made = await $db.collection('investments').create({ ... }); // → record
const upd  = await $db.collection('investments').update(id, { ... });
const del  = await $db.collection('investments').delete(id);      // → boolean
```

Satu gerbang host: `sandboxedDbCall(db, opts, guard)` di `dbSandbox.ts` — sejajar
dengan `sandboxedHttpSend` di `httpSandbox.ts`. Semua guard di sana, bukan di
`functionRunner`, dan bukan di kode user.

### Identitas: admin, eksplisit

`$db` memanggil `records.ts` **tanpa `reqCtx`** — konvensi repo: `undefined` = admin
(bypass rules). Alasannya: function adalah kode tepercaya milik pemilik project,
dan justru tugasnya menulis field yang rules larang ditulis client
(mis. agregat backend-managed). Ini WAJIB didokumentasikan keras: kode di dalam
function tidak dibatasi API rules.

### Empat guard

1. **Opt-in per function** — kolom `db_access` (default `0`/off). Function lama
   tidak berubah perilaku; `$db` yang dipanggil saat off melempar error jelas.
2. **Anti-rekursi** — `$db` menulis → memicu trigger → function menulis lagi →
   tak hingga. Dijaga `depth` yang diturunkan lewat `FunctionRunOptions`; pada
   `depth >= 1` operasi tulis dari `$db` TIDAK memicu trigger (`suppressTriggers`).
3. **Budget operasi** — maksimum N panggilan `$db` per eksekusi (default 200),
   mencegah satu function menghabiskan event loop proses tunggal.
4. **Collection sistem terlindung** — nama berawalan `_` (mis. `_auth_users`,
   `_functions`) ditolak; `$db` hanya untuk collection data.

### Kenapa bukan sinkron

`records.ts` sinkron (`DatabaseSync`), jadi secara teknis binding bisa `applySync`.
Tetap dibuat **async** (Promise) karena: (a) seragam dengan `$http`, (b) tidak
memblokir isolate saat host bekerja, (c) memungkinkan antrean/kuota kelak tanpa
mengubah permukaan API.

## Berkas yang berubah

- `server/src/core/dbSandbox.ts` — **baru**: gerbang tunggal + guard.
- `server/src/core/functionRunner.ts` — shim `$db` di prelude, bridge Reference,
  opsi `dbAccess`/`projectDb`/`depth`/`maxDbCalls`.
- `server/src/core/functionsStore.ts` — kolom `db_access`, validasi, CRUD.
- `server/src/core/triggerExecutor.ts` — turunkan `depth + 1` + `db`.
- `server/src/core/scheduler.ts` — teruskan `db` + `dbAccess`.
- `server/src/api/functionRoutes.ts` — terima `dbAccess` di POST/PATCH, teruskan
  `db` saat invoke.
- `server/tests/m41-db-binding.test.ts` — **baru**.

## Checklist

- [x] `dbSandbox.ts` dengan 4 guard
- [x] Shim `$db` + bridge di `functionRunner.ts`
- [x] Kolom `db_access` + migrasi additive
- [x] Anti-rekursi via `depth`
- [x] Rute menerima/meneruskan `dbAccess`
- [x] Test suite M41
- [x] Full suite hijau
- [x] Jurnal + README

## Aha Moments

### 1. Keunggulan struktural yang tidak dipakai sama saja dengan tidak punya

BaseForge satu proses dengan SQLite-nya — Supabase dan Appwrite tidak bisa meniru itu.
Tapi sebelum M41, function tetap harus HTTP ke dirinya sendiri, jadi keunggulan itu
nol nilainya, malah berbiaya: SSRF guard harus dilemahkan untuk loopback dan kredensial
harus ditaruh plaintext di kode. Pelajaran umum: keunggulan arsitektur hanya nyata kalau
ada binding yang mengekspos­nya; kalau tidak, ia cuma catatan desain.

### 2. Membuka akses tulis ke sandbox = membuka pintu rekursi, bukan cuma pintu data

`$http` aman dari rekursi karena tidak menyentuh siklus trigger. `$db` menulis, dan
tulisan memicu trigger, dan trigger menjalankan function — yang bisa menulis lagi.
Satu binding data diam-diam menambah satu masalah kontrol alur. Guard-nya bukan
"jangan menulis", tapi `depth` yang diturunkan lewat pemanggilan: pada kedalaman ≥ 1,
tulisan tidak lagi memicu trigger. Setiap binding baru ke sandbox harus ditanya:
efek samping apa yang bisa memanggil balik dirinya sendiri?

### 3. Bypass rules harus keputusan yang ditulis, bukan efek samping parameter opsional

`records.ts` memakai konvensi `reqCtx?: RequestContext` di mana `undefined` = admin.
Artinya lupa meneruskan parameter menghasilkan bypass rules TANPA error — gagal
diam-diam ke arah paling permisif. Untuk `$db` bypass memang yang diinginkan, tapi
harus jadi keputusan tertulis dengan alasannya, bukan konsekuensi tak sengaja dari
argumen yang tidak diisi. Default yang aman untuk fitur baru adalah off
(`db_access = 0`), sehingga permukaan serangan hanya tumbuh saat pemilik memintanya.

### 4. Pola bridge yang terbukti lebih murah daripada pola baru yang "lebih rapi"

Godaan saat menambah `$db` adalah merancang mekanisme transfer yang lebih baik dari
`$http`. Menyalin pola M25 apa adanya (Reference + callback + copy, gerbang tunggal di
modul terpisah) membuat M41 tidak menemukan satu pun bug transfer baru — seluruh kelas
masalah serialisasi sudah diselesaikan M25. Konsistensi bridge juga berarti satu tempat
untuk diperbaiki kalau isolated-vm berubah.

Status: SELESAI — 8 test M41, full suite 525/525.
