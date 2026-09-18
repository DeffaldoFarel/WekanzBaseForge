# M42 — Secrets Store: `$env` untuk Functions

## Masalah

M41 memberi function akses database in-process, tapi function yang perlu bicara
ke layanan luar (Stripe, Twilio, FCM, webhook pihak ketiga, bahkan API BaseForge
sendiri lewat `$http`) harus menaruh API key-nya **di dalam badan kode function**
— disimpan plaintext di `_functions.code`, terekspos lewat Admin API, tercetak ke
log kalau `console.log(code)`, dan tidak bisa di-rotate tanpa mengubah kode.

Supabase punya *project secrets* (env var), Appwrite punya *environment variables*
per function — keduanya memisahkan rahasia dari kode. BaseForge belum punya
padanannya; ini satu-satunya gap sebelum function bisa dipakai produksi serius.

## Desain

Secrets disimpan **per function** (bukan per project, bukan platform) di tabel
baru `_function_secrets` di project DB:

```
id, function_name, key, value_enc, created, updated
UNIQUE(function_name, key)
```

- **Enkripsi at-rest** AES-256-GCM, persis pola `encryptSecret`/`decryptSecret`
  yang sudah dipakai `mfa.ts` dan `mailer.ts`: key derivasi scrypt dari
  `OAUTH_SECRET ?? JWT_SECRET ?? ADMIN_PASSWORD` (lazily cached), payload
  `v1:iv:authTag:data` base64. Rahasia di DB project tidak dapat dibaca tanpa
  secret server — cadangan `data/` yang bocor tidak membocorkan rahasia.
- **Exposure ke sandbox**: secrets di-dekripsi di HOST, lalu diinjeksi sebagai
  objek **read-only** `$env` (frozen `Object.freeze`) via `ExternalCopy` — pola
  yang sama dengan `req`. Tidak ada write-back: function tidak bisa mengubah
  rahasianya sendiri (kalau bisa, satu function terkompromi bisa mengubah
  rahasia function lain). Rotasi hanya lewat Admin API.
- **Tidak pernah tercetak**: nilai secret TIDAK masuk `logs` (console bridge
  tetap menangkap apa yang function log — tanggung jawab pemilik tidak
  me-log rahasianya, didokumentasikan), dan TIDAK masuk response Admin API
  (list/get mengembalikan `key` + flag `hasValue`, bukan nilai).

### Permukaan API guest

```js
const key = $env.STRIPE_KEY;           // string | undefined
if (!$env.STRIPE_KEY) throw new Error('secret not set');
```

### Admin API

```
PUT    /api/admin/projects/:pid/functions/:name/secrets          { key, value }
GET    /api/admin/projects/:pid/functions/:name/secrets          → [{ key, hasValue: true, updated }]
DELETE /api/admin/projects/:pid/functions/:name/secrets/:key
```

### Keputusan: frozen object, bukan lazy fetch per-key

Alternatif: `$env.get('STRIPE_KEY')` yang memanggil host per akses (pola `$db`).
Ditolak karena (a) secrets jumlahnya kecil (puluhan), satu `ExternalCopy` lebih
murah daripada N bridge call; (b) frozen object menghapus seluruh kelas bug
"function mengubah secret function lain"; (c) async tidak diperlukan — secrets
sudah didekripsi sebelum isolate dibuat.

### Batas

- Maks 50 secrets per function, key `[A-Z][A-Z0-9_]{0,63}` (konvensi env var),
  nilai maks 8 KB. Cukup untuk API key/token; bukan untuk blob besar.
- `Object.freeze` dangkal — secrets adalah string, jadi cukup.

## Berkas yang berubah

- `server/src/core/secretsStore.ts` — **baru**: tabel + encrypt/decrypt + CRUD.
- `server/src/core/functionRunner.ts` — injeksi `$env` frozen via ExternalCopy,
  opsi `secrets`.
- `server/src/api/functionRoutes.ts` — 3 rute secrets + teruskan secrets saat
  invoke (admin & publik).
- `server/src/core/triggerExecutor.ts` / `scheduler.ts` — teruskan secrets.
- `docs/functions.md` — section `$env`.
- `server/tests/m42-secrets-store.test.ts` — **baru**.

## Checklist

- [x] `secretsStore.ts` (tabel, AES-256-GCM, CRUD)
- [x] `$env` frozen di functionRunner
- [x] 3 rute admin + wire invoke/trigger/scheduler
- [x] Validasi batas (50/key-format/8KB)
- [x] Test suite M42
- [x] Full suite hijau
- [x] Jurnal + README

## Aha Moments

### 1. Rahasia dan kode harus punya siklus hidup berbeda

`_functions.code` berubah saat pemilik mengedit logika; secret berubah saat
credential di-rotate. Menyimpan keduanya di satu kolom berarti setiap edit kode
juga menulis ulang rahasia (memperluas jejaknya) dan setiap rotasi memaksa
deploy kode. Memisahkannya ke `_function_secrets` membuat rotasi murni operasi
data — tanpa menyentuh kode yang sedang berjalan.

### 2. Enkripsi at-rest bukan tentang serangan runtime, melainkan tentang cadangan

Serangan ke server yang sedang berjalan tetap bisa membaca secret (ia memegang
key derivasi). Yang dilindungi AES-GCM adalah artefak yang KELUAR dari server:
file `data/` yang dicadangkan, dump SQLite yang dikirim, backup yang tersimpan
di tempat lain. Menamai ancaman yang tepat menentukan di mana enkripsi harus
diletakkan — di penyimpanan, bukan di jalur runtime.

### 3. Read-only adalah keputusan keamanan, bukan keterbatasan

Godaaan terbesar menambah secrets adalah membiarkan function menulisnya balik
("biar bisa refresh token sendiri"). Menolak itu dan membekukan `$env` menutup
satu vektor lateral-movement: satu function terkompromi tidak dapat mengubah
rahasia function lain atau dirinya sendiri. Primitif yang lebih sederhana
(frozen object) secara disiplin dipilih di atas API yang lebih pintar
(lazy per-key getter) justru karena ia menutup kelas bug, bukan karena
lebih mudah ditulis.

### 4. Pola enkripsi yang terbukti di repo lebih berharga daripada yang ideal

M42 tidak merancang skema kripto baru — menyalin persis `v1:iv:authTag:data`
milik mfa/mailer (scrypt-derivasi, AES-256-GCM, lazy-cached key). Satu skema
berarti satu tempat untuk di-audit dan di-rotate; dua skema berarti dua
kemungkinan salah. Di keamanan, konsistensi mengalahkan kebaruan.

### 5. Object.freeze tidak menyeberangi boundary isolate

Rancangan awal membekukan `$env` dengan `Object.freeze` — di host, lalu di
prelude. Keduanya gagal: `ExternalCopy.copyInto()` mengembalikan objek BARU
yang tidak membawa status frozen, dan `Object.freeze($env)` di prelude terbukti
tidak menempel (probe: `isFrozen=false`, write berhasil mengubah nilai).
Solusinya Proxy dengan trap `set`/`deleteProperty`/`defineProperty` yang melempar
— bekerja pada objek copy, deterministik. Dan satu pelajaran urutan: prelude
yang membungkus `__envSource` harus dieval SETELAH `jail.setSync('__envSource')`,
bukan sebelumnya, atau guest melempar `__envSource is not defined`.

Status: SELESAI — 9 test M42, full suite 534/534.
