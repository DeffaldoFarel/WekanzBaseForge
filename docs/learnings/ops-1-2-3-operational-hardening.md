# Ops-1/2/3 — Ketahanan Operasional: busy_timeout, Batch Write, Restore

Tiga gap non-function dari audit kesiapan WekanzDashboard (2026-09-18). Berbeda
dari milestone function, ketiganya menyentuh database, API, dan operasional —
tapi satu tema: **backend yang tahan dipakai sungguhan**, bukan hanya lulus
test suite single-user.

---

## Ops-1 — `busy_timeout`: jangan gagal seketika saat ada writer lain

### Masalah

WAL mode aktif di ketiga titik pembukaan DB (`platformDb.ts:66,170`,
`projectDbManager.ts:43`), tetapi `busy_timeout` **tidak pernah diset**.
Tanpa itu, SQLite melempar `SQLITE_BUSY` **seketika** saat sebuah statement
menemukan lock — bukan menunggu.

`node:sqlite` `DatabaseSync` itu sinkron dan server satu proses. Ini aman untuk
ExploreMaps (1 record, 1 user, sync manual). Tapi WekanzDashboard punya 8
function cron yang menulis via `$db` (M41) **bersamaan** dengan user yang aktif
di UI — pola beban writer-vs-writer yang belum pernah ada. Gejalanya nanti:
write acak gagal 500 saat cron jalan berbarengan dengan pemakaian.

### Perbaikan

`PRAGMA busy_timeout = 5000` di ketiga titik pembukaan DB, tepat setelah
`journal_mode = WAL`. SQLite kini **menunggu hingga 5 detik** untuk lock
sebelum menyerah — mengubah "gagal seketika" menjadi "tunggu sebentar".
5 detik mengikuti konvensi umum (PocketBase/LiteFS): cukup untuk writer biasa,
cukup pendek untuk tidak menggantung request bila benar-benar ada deadlock.

### Bukti

Test concurrency: dua koneksi ke DB yang sama, satu menahan write transaction,
yang lain menulis. Tanpa `busy_timeout` → `SQLITE_BUSY` seketika; dengan →
menunggu dan sukses setelah lock dilepas.

---

## Ops-2 — Batch write transaksional untuk client

### Masalah

Client hanya bisa menulis 1 record per request. Batch ada
(`POST /api/admin/projects/:pid/collections/:name/records/batch`,
`databaseRoutes.ts:378`) tetapi **`requireAdmin`** — tidak bisa dipakai end
user / function. Dashboard punya operasi yang secara logika atomik: tambah
`investment_activities` + update `investments.totalUnits`; tandai
`billings.paidHistory` + catat `timeline`. Tanpa batch client, dua request
berurutan menyisakan jendela di mana agregat tidak sinkron bila request kedua
gagal.

### Perbaikan

Batch untuk end user: `POST /api/p/:pid/collections/:name/records/batch`,
menerima `{ records: [...] }`, dieksekusi dalam **SATU transaksi** (semua
sukses atau semua rollback — itulah gunanya batch, bukan sekadar menghemat
round-trip). Rules dievaluasi per record terhadap `reqCtx` pemanggil — batch
tidak melewati keamanan. Maks 100 record per batch.

Beda dari Appwrite: Appwrite tidak menawarkan atomicity multi-document sama
sekali, jadi ini **perbaikan**, bukan sekadar paritas.

### Bukti

Batch campuran valid+invalid → semua rollback (tidak ada yang tertulis); batch
valid → semua tertulis dalam satu transaksi; batch oleh user → rules
diberlakukan per record.

---

## Ops-3 — Restore: pemulihan yang terdokumentasi & teruji

### Masalah

Backup ada (config/run/list/download di `backupRoutes.ts`), tetapi **restore
tidak ada endpoint-nya** — komentar `backupScheduler.ts:6` hanya bilang
*"restore = buka file"*. Artinya pemulihan adalah operasi manual yang tidak
pernah diuji: stop service, copy `data.db`, start — dan berdoa. Untuk data
keuangan pribadi (105 investasi, 414 aktivitas, riwayat tagihan), restore yang
belum pernah diuji sama dengan tidak ada backup.

### Perbaikan

BUKAN endpoint restore (berbahaya & kompleks untuk production), melainkan
**prosedur restore yang terdokumentasi dan teruji**: dokumen langkah-demi-
langkah + satu test yang membuktikan sebuah backup benar-benar bisa dibuka
dan datanya utuh setelah "dipulihkan" ke lokasi baru. Prinsipnya: backup yang
tidak pernah dibuktikan bisa dibuka adalah harapan, bukan backup.

### Bukti

Test: buat project + data → backup → "pulihkan" file backup ke DB baru →
buka → verifikasi record utuh (jumlah + isi). Prosedur tertulis di
`docs/deployment.md` / `docs/backup-restore.md`.

---

## Checklist

- [x] Ops-1: `busy_timeout` di 3 titik + test concurrency 2-writer
- [x] Ops-2: batch end user transaksional + test (rollback, sukses, rules)
- [x] Ops-3: prosedur restore terdokumentasi + test backup-bisa-dibuka
- [x] Full suite hijau
- [x] Jurnal + README

## Aha Moments

### 1. WAL tanpa busy_timeout hanyalah setengah dari cerita konkurensi

WAL mengizinkan pembaca bersamaan dengan satu penulis — tetapi tidak mengubah
fakta bahwa dua PENULIS tetap berebut lock. Tanpa `busy_timeout`, penulis
kedua gagal seketika. Mengaktifkan WAL dan berhenti di situ memberi rasa aman
palsu: konkurensi baca-tulis sudah diurus, konkurensi tulis-tulis belum.

### 2. busy_timeout menyelamatkan lock dari proses LAIN, bukan dari `await` sendiri

Temuan terukur dari probe: `node:sqlite` `DatabaseSync` itu **sinkron dan
memblokir event loop**. Di satu proses Node, `busy_timeout` **tidak bisa**
menyelamatkan lock yang dipegang lintas `await` — karena statement yang
menunggu lock **memblokir loop**, sehingga pemegang lock tidak pernah
berkesempatan COMMIT (waiter tetap timeout penuh). Yang benar-benar
diselamatkan `busy_timeout` adalah lock dari **proses/thread lain** (dibuktikan
dengan `worker_threads`: tanpa → `SQLITE_BUSY` seketika <500ms; dengan →
menunggu ~800ms lalu sukses). Implikasinya untuk dashboard: jangan pegang write
transaction melewati `await`; itulah yang membuat `busy_timeout` berguna
melawan writer dari cron/function yang berjalan di proses yang sama tetapi
dalam transaksi pendek.

### 3. Batch yang tidak atomik hanyalah loop yang disamarkan

Nilai batch bukan menghemat HTTP round-trip — itu bonus. Nilainya adalah
**atomicity**: semua tertulis atau tidak sama sekali. Batch admin yang sudah
ada (`createRecordsBatch`) dibungkus `BEGIN/COMMIT` (`records.ts:510`), jadi
membukanya untuk end user berarti mewarisi jaminan itu — asalkan rules tetap
dievaluasi per record dan tidak dilewati demi kecepatan. Satu perangkap yang
tertangkap: batch admin memanggil `createRecord` **tanpa `reqCtx`** — artinya
melewati rules. Membuka batch untuk end user WAJIB meneruskan `reqCtx`, atau
batch menjadi pintu belakang yang melewati keamanan.

### 4. Backup yang belum pernah dibuka adalah harapan, bukan backup

Menulis file backup itu mudah; yang sulit adalah membuktikan file itu bisa
dibuka dan datanya utuh saat dibutuhkan. Satu test yang memulihkan backup ke
DB baru dan membaca isinya mengubah "kami punya backup" dari klaim menjadi
fakta — dan jauh lebih murah daripada endpoint restore production. Endpoint
restore yang setengah matang justru berbahaya: ia memberi rasa aman palsu di
atas operasi yang mengganti seluruh database.

Status: SELESAI — busy_timeout (3 titik), batch client transaksional, restore
terdokumentasi + teruji. Full suite hijau.
