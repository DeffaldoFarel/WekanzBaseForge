# M15a — Functions: VM Isolation + Callable Functions

> **Konsep:** menjalankan kode JavaScript milik user di sandbox `node:vm` — tanpa `require`, tanpa `process`, dengan timeout — lalu menyimpannya sebagai data (schema-as-data lagi!) dan mengekspos endpoint callable.

## 🎯 Masalah yang Dipecahkan

Database + Auth + Storage + Realtime semua REAKTIF — mereka menjawab
request. **Functions = logika custom** yang berjalan di server:
validasi kompleks, integrasi API pihak ketiga, kalkulasi khusus.
Firebase menyebutnya Cloud Functions; kita membuat versi mini sendiri
dari `node:vm` (zero dependency — konsisten dengan filosofi BaseForge).

## 🧠 Bagaimana VM Isolation Bekerja

`node:vm` membuat V8 context BARU — dunia paralel dengan globals sendiri:

```
Host (server)                    Sandbox (function)
─────────────────                ─────────────────────
process          ✗ TIDAK lolos   process      → undefined
require          ✗ TIDAK lolos   require      → undefined
fs, os           ✗ TIDAK lolos   (tidak ada)
JSON, Math, Date ✓ bawaan JS     JSON, Math ✓ (fresh copies)
yang KITA kirim  →               req, console ✓ (satu-satunya jendela!)
```

Kode user dibungkus IIFE: `(function(){ ...kode... })()` — supaya
`return` di top-level berfungsi, dan hasilnya adalah nilai response.

**Timeout sinkron**: `vm.runInNewContext(code, ctx, { timeout })` —
`while(true){}` dihentikan paksa. (Catatan jujur: async loop tidak
terhentikan oleh timeout sinkron — limitation yang diakui.)

**Kejujuran keamanan**: `node:vm` BUKAN boundary keamanan sempurna
(terdokumentasi di Node docs). Untuk kode HOSTILE butuh isolated-vm /
subprocess. Untuk BaseForge (kode dari admin/DIY developer), vm +
timeout + tanpa host access = isolasi yang tepat sasaran.

## 📡 Kontrak Function

```js
// kode function (disimpan di tabel _functions):
// req  = { body, query, auth }   — auth = { id, email } | null
// return apapun → JSON response
const total = (req.body.harga || 0) * (req.body.qty || 0);
console.log('dipanggil dengan', req.body);
return { total, pakaiPPN: total > 100000 };
```

## 📁 Perubahan

```
core/functionsStore.ts  → tabel _functions (schema-as-data!) + CRUD
core/functionRunner.ts  → vm sandbox: runFunctionCode(code, opts)
api/functionRoutes.ts   → admin CRUD + execute (admin & public)
public/index.ts         → register router
```

Endpoints:
```
POST   /api/admin/projects/:pid/functions            → buat
GET    /api/admin/projects/:pid/functions            → list
GET    /api/admin/projects/:pid/functions/:name      → detail
PATCH  /api/admin/projects/:pid/functions/:name      → ubah code/enabled
DELETE /api/admin/projects/:pid/functions/:name      → hapus
POST   /api/admin/projects/:pid/functions/:name/execute → jalankan (admin)
POST   /api/p/:pid/functions/:name/execute              → jalankan (public, hanya jika enabled)
```

## ✅ Definisi Selesai

- [ ] Sandbox: process/require undefined; timeout menghentikan infinite loop
- [ ] Console log tertangkap & dibatasi (max 100 baris)
- [ ] req.body/query/auth masuk; return value keluar sebagai JSON
- [ ] CRUD function (unique name, validasi nama)
- [ ] Execute via admin API + public endpoint (hanya enabled)
- [ ] Integration test HTTP nyata
- [ ] Jurnal + commit

## 📝 Aha! Moments

### Aha! #1 — Sandbox = dunia yang KITA isi
`vm.createContext({ console, req, JSON, Math })` — kode user HANYA
melihat apa yang ditaruh di sini. `process`? undefined. `require`?
undefined. Test membuktikannya: `typeof process` = 'undefined' dari
dalam sandbox, dan getOwnPropertyNames(globalThis) tidak mengandung
fs/os/child_process. Isolasi by construction, bukan by filtering.

### Aha! #2 — timeout menangani while(true) tanpa crash server
`vm.runInNewContext(code, ctx, { timeout: 300 })` melempar error saat
script melebihi batas — server LANJUT hidup. Dibuktikan via HTTP:
request infinite loop selesai dalam ~320ms dengan FUNCTION_ERROR,
bukan hang. (Kejujuran: timeout hanya menangkap loop sinkron — async
loop adalah limitation yang diakui di jurnal.)

### Aha! #3 — Console jadi jendela debug, bukan lubang bocor
console.log user ditangkap ke array (max 100) dan DIKEMBALIKAN dalam
response execute. Server log tetap bersih; user mendapat visibilitas
seperti Cloud Functions viewer. Log ke-101+ dipotong dengan tanda
jelas — tidak ada yang bisa membludakkan memori via console.

### Aha! #4 — Function sebagai DATA mewarisi semua fitur database gratis
Functions disimpan di tabel _functions per project — BUKAN file di
disk. Hasilnya otomatis: ikut backup VACUUM INTO (B2), unik di-level
DB (D1), terhapus saat project dihapus, bisa di-query. "Sekali lagi,
schema-as-data terbukti unggul."

### Aha! #5 — enabled flag = kontrol publish paling sederhana
Function disabled: admin masih bisa execute (debug), public 403.
Ini menggantikan "deploy/un-deploy" Firebase dengan SATU kolom boolean
— dan karena function tidak pernah benar-benar "dideploy" (hidup di
DB yang sama), tidak ada masalah version drift.

## ✅ Status: SELESAI — 13/13 test M15a (sandbox+HTTP), 220/220 total — 2026-09-12
