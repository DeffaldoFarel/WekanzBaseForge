# M44 — Function Limits: Configurable + Measured

## Masalah

Plafon function BaseForge terlalu ketat untuk beban nyata, dan sebagian tidak
bisa diubah sama sekali:

| Plafon | Sekarang | Supabase Edge | Appwrite |
|---|---|---|---|
| Timeout | **maks 30.000 ms** (`functionsStore.ts:217`) | 150s free / 400s paid | ~15 menit |
| Memori | 32 MB, **hardcoded di runner** (`functionRunner.ts:224`) | 256 MB | container |

Kasus pemicunya konkret: function agregasi WekanzDashboard
(`investments-aggregates`, 139 baris, membaca 105 investasi + 414 aktivitas).
Dengan `$db` (M41) ia menjadi query in-process, tapi batas 30 detik dan 32 MB
yang tidak bisa diubah membuat function berat tidak punya ruang — dan pemilik
tidak bisa menaikkannya untuk function tertentu tanpa mengubah kode server.

## Keputusan berbasis spike (bukan tebakan)

Sebelum menetapkan angka, M44 mengukur biaya siklus isolate di mesin dev
(N=300, `new Isolate + createContext + eval prelude + dispose`):

```
Isolate BARU tiap run (kondisi sekarang): mean 1.693 ms, p95 2.121 ms
Isolate DI-REUSE (context baru per run): mean 0.400 ms, p95 0.498 ms
Hemat: ~1.29 ms/run (76%)
```

Kesimpulan dari angka, bukan asumsi:
- Penghematan ~1.3 ms/run **berarti untuk trigger** (satu write memicu beberapa
  function), tetapi **tidak berarti** untuk function yang jalan 2 detik —
  overhead <0.1%.
- Reuse isolate menyeret risiko kebocoran state antar-eksekusi function yang
  berbeda. Nilai yang ditawarkan tidak sebanding dengan risiko itu untuk
  kasus umum.

Maka M44 **tidak membangun pool isolate**. Sebagai gantinya: **reuse context
untuk trigger** (function yang sama, dipanggil berulang dalam satu siklus
trigger) dan **naikkan + buat plafon configurable** — dua hal yang nilainya
terbukti, tanpa risiko pool.

## Desain

### 1. Timeout: naikkan plafon ke 120 detik

`timeoutMs` maks 30.000 → **120.000 ms** (2 menit). Default tetap 2000 ms —
function biasa tidak berubah; function berat bisa dinaikkan eksplisit.
120s dipilih mendekati Supabase free tier (150s) tetapi lebih konservatif:
BaseForge berbagi satu event loop, jadi plafon lebih ketat dari Appwrite
(container) memang disengaja.

### 2. Memori: kolom `memory_mb`, configurable per function

`memoryLimitMb` yang kini hardcoded 32 MB di runner menjadi kolom
`memory_mb` di `_functions` (DEFAULT 32), bisa diset 16–256 MB per function.
256 MB = plafon Supabase; di atas itu function harus dipecah, bukan diberi
heap lebih besar.

### 3. Context reuse untuk trigger (bukan pool)

`fireTriggers` mengeksekusi function yang sama berulang. M44 mempertahankan
**satu isolate per siklus trigger** dan membuat **context baru per eksekusi**
(context = scope global fresh → tidak ada kebocoran `$lib`/`$env` state).
Prelude + `$env` + `$lib` dieval ulang per eksekusi karena keduanya
per-function — yang dihemat hanyalah pembuatan isolate (~1.3 ms × N function
dalam satu trigger). Ini reuse yang aman: scope fresh tiap run, tidak ada
state yang menyeberang.

### 4. Observability limit

`FunctionRunResult` sudah punya `durationMs`/`timedOut`/`oom`. M44 menambah
`memoryMb` yang dipakai ke response execute admin, agar pemilik bisa melihat
kebutuhan nyata sebelum menaikkan plafon — angka dulu, bukan perasaan.

## Berkas yang berubah

- `server/src/core/functionsStore.ts` — kolom `memory_mb`, plafon timeout
  120s, validasi memory 16–256.
- `server/src/core/functionRunner.ts` — pakai `opts.memoryLimitMb` dari
  function; kembalikan `memoryMb` di result; opsi reuse context.
- `server/src/core/triggerExecutor.ts` — reuse isolate per siklus trigger.
- `server/src/api/functionRoutes.ts` — terima `memoryMb`, teruskan.
- `docs/functions.md` — tabel limit + panduan menaikkan.
- `server/tests/m44-function-limits.test.ts` — **baru**.

## Checklist

- [x] Spike benchmark (1.29 ms/run dihemat → keputusan no-pool)
- [x] Plafon timeout 120s
- [x] Kolom `memory_mb` configurable (16–256)
- [x] Context reuse untuk trigger
- [x] `memoryMb` di result execute
- [x] Test suite M44
- [x] Full suite hijau
- [x] Jurnal + README

## Aha Moments

### 1. Angka yang diukur bisa mengubah keputusan arsitektur

Niat awal M44 adalah "pool isolate" karena Supabase me-reuse worker. Spike
1.29 ms/run membatalkannya: untuk function 2 detik, penghematan itu <0.1% dan
tidak sebanding dengan risiko kebocoran state antar-function. Mengukur dulu
mengubah "kita harus punya pool" menjadi "kita tidak butuh pool" — dan mengarahkan
usaha ke tempat yang benar-benar berharga (plafon yang bisa diubah).

### 2. Reuse yang aman adalah reuse yang scope-nya fresh

Masalah pool isolate bukan penghematannya, melainkan state yang menyeberang
antar-eksekusi. Context-baru-per-run mempertahankan isolasi (scope global
baru) sambil menghemat pembuatan isolate. Prinsipnya: boleh berbagi resource
yang mahal (isolate), jangan pernah berbagi scope (context).

### 3. Plafon yang bisa diubah ≠ plafon yang longgar

Menjadikan `memory_mb` dan `timeoutMs` configurable tidak berarti menaikkan
semuanya — default tetap 2000 ms / 32 MB dan function biasa tidak berubah.
Yang berubah adalah *siapa yang memutuskan*: dari hardcoded di kode server,
menjadi pemilik function yang sadar biaya, berbekal angka `memoryMb`/`durationMs`
yang dikembalikan API.

### 4. Plafon yang lebih ketat dari kompetitor bisa jadi disengaja

Supabase 400s / Appwrite 15 menit masuk akal karena mereka multi-tenant
terdistribusi. BaseForge berbagi SATU event loop: satu function 2 menit yang
macet menahan semua request. Plafon 120s yang lebih ketat dari kompetitor
bukan kekurangan — ia mencerminkan arsitektur single-process yang berbeda,
dan justru melindungi tenant lain di server yang sama.

### 5. String raksasa tidak menguji plafon memori

Test pertama memakai string 12×8 MB untuk memicu OOM — dan gagal di KEDUA
plafon (32 dan 256 MB) dengan `Invalid string length`. Itu batas panjang
string V8 (konstan, bukan heap isolate), jadi tidak mendiskriminasi plafon.
Alokasi array-of-chunks besar adalah yang kena plafon HEAP. Untuk menguji
sebuah plafon, beban harus benar-benar mengenai plafon itu — bukan plafon
lain yang kebetulan lebih dulu tercapai.

### 6. OOM sungguhan dulu MENGHANCURKAN server

Probe memori mengekspos bug kritis: isolate yang OOM dibunuh V8, lalu `finally`
memanggil `dispose()` lagi → `Isolate is already disposed` → **proses crash**.
Satu function kehabisan memori mengubah dirinya menjadi outage server.
Perbaikannya dua lapis: cek `isolate.isDisposed` + try/catch pada `dispose()`.
Setelah perbaikan, OOM di 32 MB menghasilkan `{ oom: true, memoryMb: 32 }`
yang bersih dan server tetap hidup. Path cleanup harus selalu menganggap
resource-nya mungkin sudah mati karena sebab yang sedang ditangani.

Status: SELESAI — 8 test M44, full suite 552/552.
