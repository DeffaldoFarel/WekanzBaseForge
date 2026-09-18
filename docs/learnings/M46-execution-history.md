# M46 — Execution History: Riwayat Eksekusi Function + Log Persisten

## Masalah

Hasil eksekusi function hari ini hanya dicetak ke **stdout server**
(`triggerExecutor.ts:89`, `scheduler.ts:132`): hilang saat restart/log rotate,
dan tidak bisa dibaca lewat API. Konsekuensinya function tidak bisa di-debug —
pemilik tidak bisa menjawab "function mana yang gagal, kapan, dan kenapa".
`triggerExecutor.ts:20` sendiri mencatat rencananya (*"M15u nanti bisa simpan
ke tabel `_function_logs`"*) dan roadmap M46 menamainya: *riwayat eksekusi
function + log persisten*, dengan pendekatan **Gate `runFunctionCode`** —
yang M46 ikuti persis.

Supabase dan Appwrite sama-sama punya invocation history; ini gap ke-15 dari
peta 60 yang ditutup (42→43/60).

## Desain

### Tabel `_function_logs` (per project DB)

```
id, function_name, source, ok, error, logs, duration_ms, memory_mb, created
INDEX(function_name, created DESC, id DESC)
```

- `source`: `'callable'` (execute admin) | `'public'` (execute publik) |
  `'trigger'` (db trigger) | `'schedule'` (cron).
- `logs`: JSON array string yang sudah dibatasi runner (maxLogs 100 baris).
- `error`: pesan error atau NULL bila ok.

### Gate di `runFunctionCode` (bukan di call site)

Keempat call site (invoke admin, invoke publik, trigger, cron) sama-sama
mengalir lewat `runFunctionCode`. Mencatat di **satu gerbang** — bukan 4 titik
terpisah — berarti pemanggil mana pun di masa depan (webhook, audit, dst)
otomatis ikut tercatat. Runner menerima:

```ts
opts.executionLog?: { functionName: string; source: ExecutionSource }
```

Pencatatan terjadi SEKALI per eksekusi, sebelum result dikembalikan, di ketiga
return path (ok, __bfError, catch). Dibutuhkan `opts.projectDb`; runner tanpa
`projectDb` (unit test murni) tidak mencatat — tidak dipaksa.

### Prinsip: pencatatan TIDAK BOLEH menggagalkan eksekusi

`recordExecution` membungkus seluruh pekerjaannya dalam try/catch — tabel
hilang, DB locked, disk penuh: function tetap mengembalikan hasilnya. Log yang
hilang lebih baik daripada function yang gagal karena logging-nya sendiri.

### Retensi: 200 eksekusi terakhir per function

Setiap insert memangkas: `DELETE ... WHERE function_name = ? AND id NOT IN
(SELECT id ... ORDER BY created DESC, id DESC LIMIT 200)`. Riwayat tetap
berguna untuk debug tanpa mengubah `_function_logs` menjadi beban storage
(function cron 2×/hari × 200 = hampir 3 bulan riwayat).

### Admin API

```
GET    /api/admin/projects/:pid/functions/:name/logs?page&perPage
       → { page, perPage, totalItems, items }  (terbaru dulu)
GET    /api/admin/projects/:pid/logs?page&perPage
       → riwayat SEMUA function (untuk halaman Executions masa depan)
DELETE /api/admin/projects/:pid/functions/:name/logs
       → bersihkan riwayat function itu
```

## Berkas yang berubah

- `server/src/core/executionLog.ts` — **baru**: tabel + record + list + clear +
  retensi.
- `server/src/core/functionRunner.ts` — opsi `executionLog`, catat di 3 return
  path.
- `server/src/api/functionRoutes.ts` — teruskan `executionLog` (callable/public)
  + 3 rute logs.
- `server/src/core/triggerExecutor.ts` — `source: 'trigger'`.
- `server/src/core/scheduler.ts` — `source: 'schedule'`.
- `docs/functions.md` — section Riwayat Eksekusi.
- `server/tests/m46-execution-history.test.ts` — **baru**.

## Checklist

- [x] `executionLog.ts` (tabel, record, list, clear, retensi 200)
- [x] Gate di `runFunctionCode` (3 return path)
- [x] 3 rute + wire 4 call site
- [x] Pencatatan tahan-gagal (tidak pernah menggagalkan eksekusi)
- [x] Test suite M46
- [x] Full suite hijau
- [x] Jurnal + README + strike baris M46 di COMPARISON.md

## Aha Moments

### 1. Gate di runner, bukan disiplin di call site

Mencatat di 4 call site berarti setiap call site BARU di masa depan harus ingat
mencatat — dan yang lupa diam-diam tidak tercatat. Meletakkannya di
`runFunctionCode` menjadikan pencatatan konsekuensi struktur, bukan disiplin:
pemanggil baru otomatis ikut. Roadmap menamai ini dari awal ("Gate
runFunctionCode") — dan ternyata itu benar bukan hanya untuk swap engine,
melainkan juga untuk cross-cutting concern seperti logging.

### 2. Logging yang bisa menggagalkan function adalah bug yang menunggu terjadi

Satu `INSERT` yang melempar (DB locked, tabel hilang) di jalur pencatatan akan
mengubah function yang SUKSES menjadi error di mata pemanggil — pelapor
berita yang membunuh kurirnya. `recordExecution` menelan semua kegagalannya
sendiri: observability tidak pernah boleh lebih penting daripada hasil.

### 3. Retensi ditentukan oleh pertanyaan yang dijawab, bukan oleh kapasitas

Berapa lama riwayat disimpan? Bukan "selama disk kuat" — melainkan cukup untuk
menjawab "kenapa cron tadi pagi gagal". 200 eksekusi/function (≈3 bulan untuk
cron harian) menjawab itu dengan murah; sisanya adalah beban backup tanpa
nilai debug tambahan.

### 4. Sumber eksekusi (`source`) adalah konteks debug paling murah

Pesan error yang sama berarti sangat berbeda tergantung ia datang dari cron
tengah malam, trigger saat user menulis, atau admin yang sedang mengetes.
Satu kolom `source` mengubah tumpukan log menjadi cerita per pemicu — harganya
hampir nol, nilainya selalu terasa tepat saat dibutuhkan.

### 5. Refactor return-path harus diverifikasi dengan menjalankan path-nya

Saat menambah `logExecution` ke tiga return path, Christy menemukan bahwa
`errResult` di path `catch` dibuat tetapi **tidak pernah di-return** — fungsi
jatuh ke `finally` dan mengembalikan `undefined`. Bug ini Christy ciptakan saat
refactor M44 (menambah `memoryMb`), lolos karena path `catch` (OOM/timeout)
jarang dijalankan. Yang menangkapnya bukan pembacaan kode, melainkan menjalankan
test M44 yang memang menguji path OOM. Pelajarannya: setiap refactor yang
mengubah bentuk return harus diverifikasi dengan mengeksekusi SETIAP path-nya,
bukan hanya path sukses — `tsc` hijau tidak menangkap `undefined` yang lolos
dari cabang yang tak pernah diuji.

Status: SELESAI — 10 test M46, full suite 562/562.
