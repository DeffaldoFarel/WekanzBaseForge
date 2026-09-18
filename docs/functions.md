# ⚡ Serverless Functions & Triggers

BaseForge memiliki mesin komputasi fungsi serverless yang berjalan di atas sandbox **V8 Isolate nyata (`isolated-vm`)**. 

Berbeda dengan sandbox `node:vm` biasa yang masih berbagi heap memory dengan host, `isolated-vm` mengisolasi memori sepenuhnya: kode pengguna tidak memiliki akses ke sistem operasi, filesystem (`fs`), `process`, atau `require`, serta dibatasi oleh kuota memori (32MB) dan batas waktu eksekusi (*timeout*).

---

## 🎯 3 Mode Eksekusi Fungsi

Sebuah fungsi dapat dipicu (*triggered*) melalui 3 cara:

### 1. Callable Functions (Dipanggil via HTTP API)
Fungsi dapat dieksekusi langsung oleh aplikasi frontend atau backend luar melalui request HTTP POST.

* **Endpoint:** `POST /api/p/:pid/functions/:name/execute`
* **Body:**
  ```json
  {
    "body": {
      "nilaiA": 10,
      "nilaiB": 25
    }
  }
  ```
* **Response (200 OK):**
  ```json
  {
    "result": {
      "total": 35
    },
    "logs": [
      "[log] [\"menghitung:\", 10, 25]"
    ]
  }
  ```

---

### 2. Database Triggers (Otomatis Setelah CRUD)
Fungsi dapat dipicu secara otomatis setiap kali terjadi perubahan data pada koleksi tertentu:
* Aksi yang didukung: `create`, `update`, `delete`.
* **Konteks yang diterima di dalam fungsi:**
  * `req.action` : Aksi yang terjadi ("create", "update", atau "delete").
  * `req.collection` : Nama koleksi yang terpengaruh.
  * `req.record` : Data record yang baru dibuat atau diubah.
  * `req.previous` : Data record lama sebelum di-update (khusus aksi `update`).

> 🛡️ **Fail-Open & Anti-Loop:** Eksekusi trigger bersifat *fire-and-forget* dan aman. Jika trigger mengalami error atau timeout (misal *infinite loop*), transaksi utama database **tetap sukses disimpan** dan server host tidak akan pernah crash.

---

### 3. Scheduled Functions (Cron Jobs)
Fungsi dapat dijalankan secara berkala pada jadwal tertentu menggunakan sintaks cron standar 5-field:

```text
┌───────────── menit (0 - 59)
│ ┌───────────── jam (0 - 23)
│ │ ┌───────────── hari dalam bulan (1 - 31)
│ │ │ ┌───────────── bulan (1 - 12)
│ │ │ │ ┌───────────── hari dalam minggu (0 - 6, 0 = Minggu)
│ │ │ │ │
* * * * *
```

*Contoh Jadwal:*
* `*/15 * * * *` : Setiap 15 menit.
* `0 0 * * *` : Setiap tengah malam (pukul 00:00).
* `0 9 * * 1-5` : Pukul 09:00 pagi setiap hari kerja (Senin–Jumat).

*Anti Double-Fire:* Mesin scheduler BaseForge mencatat *execution history* di menit yang sama untuk memastikan fungsi tidak akan tereksekusi ganda jika tick scheduler berjalan berulang.

---

## 📝 Menulis Kode Fungsi

Kode fungsi ditulis dalam sintaks JavaScript murni. Fungsi memiliki akses ke variabel global `req` dan dapat mengembalikan nilai apapun yang dapat di-serialize ke JSON:

### Contoh 1: Fungsi Validasi Diskon (Callable)
```javascript
const kode = req.body.kode;
const totalBelanja = req.body.total;

if (kode === "PROMOHEMAT" && totalBelanja >= 100000) {
  const diskon = totalBelanja * 0.1;
  console.log("Diskon diterapkan:", diskon);
  return {
    sukses: true,
    potongan: diskon,
    totalAkhir: totalBelanja - diskon
  };
}

return {
  sukses: false,
  potongan: 0,
  totalAkhir: totalBelanja
};
```

### Contoh 2: Notifikasi Pesanan Baru (Database Trigger)
Fungsi dipasang sebagai trigger pada koleksi `orders` untuk aksi `create`:

```javascript
console.log("Pesanan baru masuk dengan ID:", req.record.id);
console.log("Pembeli:", req.record.customer_name);
console.log("Total:", req.record.grand_total);

// Lakukan kalkulasi atau formatting data
return {
  status: "notified",
  orderId: req.record.id
};
```

---

## 🌐 HTTP Keluar: `$http.send` (M25)

Function dapat memanggil API eksternal (Stripe, WhatsApp API, dll.) lewat
`$http.send` — **async, kembalian Promise, dan hanya aktif jika admin
mengisi Allowed HTTP Hosts pada function tersebut** (fail-safe: kosong =
tanpa jaringan).

```javascript
// Async/await didukung penuh (M25)
const res = await $http.send({
  url: "https://api.stripe.com/v1/charges",
  method: "POST",
  headers: { "Authorization": "Bearer sk_live_..." },
  body: JSON.stringify({ amount: 1000, currency: "idr" }),
  timeout: 5000,            // opsional, default 10s (max 30s)
});

// res = { status, headers, body, truncated }
return {
  httpStatus: res.status,
  charge: res.json(),       // helper: parse body sebagai JSON
};
```

### Aturan Keamanan (4 lapis)

| Lapis | Perilaku |
|---|---|
| **Allowlist** | Host harus terdaftar di *Allowed HTTP Hosts* function. `api.stripe.com` = host itu saja; `*.github.com` = wildcard subdomain; `*` = semua host **publik**. |
| **SSRF guard** | Loopback/private/link-local IP (termasuk `169.254.169.254` metadata cloud) selalu diblok kecuali host tsb terdaftar **literal** di allowlist (opt-in eksplisit untuk host internal). DNS di-resolve dan semua IP dicek. |
| **Redirect** | Diikuti maksimal 3 hop, **setiap hop divalidasi ulang** (allowed-host → evil-host = blocked). |
| **Budget** | Timeout per-request (AbortController), response body dibatasi **1 MB** (flag `truncated`), request body 256 KB, metode terbatas GET/POST/PUT/PATCH/DELETE/HEAD. |

Total anggaran waktu function (timeoutMs) **termasuk** waktu menunggu `$http`
(wall-clock), jadi request lambat tidak bisa memperpanjang umur function.

---

## 🗄️ Akses Database: `$db` (M41)

`$db` memberi function akses **langsung ke database project — dalam proses yang
sama**, tanpa lewat jaringan. Server, SQLite, dan runtime function hidup di satu
proses, jadi tidak ada HTTP, tidak ada kredensial, dan tidak ada latensi jaringan.

> Ini keunggulan struktural BaseForge: Supabase Edge Function harus memperlakukan
> Postgres sebagai layanan remote ter-pool, dan Appwrite Function harus memanggil
> REST API-nya sendiri. Di BaseForge, panggilannya langsung.

`$db` **mati secara default**. Nyalakan dengan `dbAccess: true` pada function
(kolom `db_access`) — function lama tidak berubah perilaku.

```js
// Semua method mengembalikan Promise → pakai await
const res = await $db.collection('investments').list({
  filter: 'userId = "u1"',   // sintaks filter M04, sama dengan REST API
  sort: '-created',
  page: 1,
  perPage: 500,               // maksimum 500 per panggilan
});
// → { page, perPage, totalItems, totalPages, items: [...] }

const rec  = await $db.collection('investments').get(id);        // record | null
const made = await $db.collection('investments').create({ instrument: 'BTC' });
const upd  = await $db.collection('investments').update(id, { totalUnits: 42 });
const gone = await $db.collection('investments').delete(id);     // boolean
```

### ⚠️ `$db` berjalan sebagai admin — API rules TIDAK berlaku

Ini **disengaja**: tugas function justru menulis field yang rules larang ditulis
client (agregat yang dikelola backend). Konsekuensinya, kode di dalam function
adalah kode tepercaya — `$db` bisa membaca dan menulis collection yang ditolak
untuk end user. Karena itu aksesnya opt-in per function.

### Aturan Keamanan (4 gerbang)

| Gerbang | Perilaku |
|---|---|
| **Opt-in** | `$db` hanya hidup kalau `dbAccess: true`. Memanggilnya saat mati → error `$db is not enabled for this function`. |
| **Anti-rekursi** | Tulisan `$db` dari function yang **dipicu trigger** (depth ≥ 1) tidak memicu trigger lagi. Tanpa ini: trigger → function → tulis → trigger → tak hingga. Dipanggil dari HTTP/cron (depth 0), tulisan `$db` **tetap** memicu trigger. |
| **Budget** | Maksimum **200** panggilan `$db` per eksekusi (`maxDbCalls`). Proses tunggal: satu function tidak boleh memonopoli event loop. |
| **Collection sistem** | Nama berawalan `_` (`_auth_users`, `_functions`, `_collections`, …) selalu ditolak — mencegah eskalasi privilese dari sandbox. |

Anggaran `timeoutMs` function tetap berlaku penuh, jadi loop `$db` yang panjang
tetap dihentikan wall-clock.

---

## 🔑 Secrets: `$env` (M42)

Function yang memanggil layanan luar (Stripe, Twilio, webhook pihak ketiga)
butuh credential. Menaruhnya **di dalam kode function** berarti credential
tersimpan plaintext di `_functions.code`, terekspos via Admin API, dan tidak
bisa di-rotate tanpa mengubah kode. `$env` memisahkan rahasia dari kode —
persis *project secrets* Supabase dan *environment variables* Appwrite.

```js
const key = $env.STRIPE_KEY;          // string, atau undefined jika belum diset
if (!$env.STRIPE_KEY) throw new Error('STRIPE_KEY belum diset');

const res = await $http.send({
  url: 'https://api.stripe.com/v1/charges',
  method: 'POST',
  headers: { authorization: 'Bearer ' + $env.STRIPE_KEY },
  body: payload,
});
```

Rahasia disimpan **per function**, **terenkripsi at-rest** (AES-256-GCM, skema
yang sama dengan mailer/MFA), dan didekripsi di host lalu disuntikkan sebagai
objek `$env`. Key yang tidak diset bernilai `undefined` — konvensi `process.env`.

### Mengelola secrets (Admin API)

```
PUT    /api/admin/projects/:pid/functions/:name/secrets          { key, value }
GET    /api/admin/projects/:pid/functions/:name/secrets          → [{ key, hasValue: true, updated }]
DELETE /api/admin/projects/:pid/functions/:name/secrets/:key
```

### Aturan

| Aturan | Perilaku |
|---|---|
| **Read-only** | Function **tidak bisa** menulis `$env` balik (write → error `$env is read-only`). Rotasi hanya lewat Admin API — satu function terkompromi tidak bisa mengubah rahasia function lain. |
| **Tidak pernah terekspos** | Admin API hanya mengembalikan **metadata** (`key`, `hasValue`, `updated`) — nilai tidak pernah keluar lewat response. |
| **Isolasi per function** | Secret milik function A tidak terlihat di `$env` function B. |
| **Batas** | Maks **50** secrets per function, key `[A-Z][A-Z0-9_]` (maks 64), nilai maks **8 KB**. |
| **Tanggung jawab pemilik** | Jangan `console.log($env.KEY)` — console bridge menangkap log function, jadi rahasia yang di-log akan masuk ke log. |

Rotasi = `PUT` ulang key yang sama dengan nilai baru; function yang sedang
berjalan langsung memakai nilai baru pada eksekusi berikutnya **tanpa mengubah
kode**.

---

## 📦 Module Registry: `$lib` (M43)

Function adalah satu string kode tanpa `import`/`require`. Logika domain yang
dipakai banyak function (mis. `shared/domain.ts` — di-import oleh beberapa
function) akan terpaksa disalin ke setiap function: satu perbaikan bug harus
disalin berkali-kali. `$lib` memisahkan kode bersama ke registry per project
dan menyuntikkannya ke sandbox.

```js
// Modul 'domain' di registry (boleh JS atau TypeScript — tipe di-strip):
//   export function calculateStreak(habit, logs) { ... }

// Di function, tautkan modulnya (modules: ['domain']) lalu pakai:
const streak = $lib.domain.calculateStreak(habit, logs);
const summary = $lib.billing.computeMonthlyBillSummary(bills);
```

Satu modul bisa dipakai **banyak function** — perbaikan bug di domain cukup
di satu tempat. Modul ditulis JS biasa (`exports.x = ...` atau
`module.exports = ...`) atau TypeScript (`export function` + `interface`);
kompiler TypeScript bawaan server men-strip tipe saat modul disimpan.

### Mengelola modul (Admin API)

```
PUT    /api/admin/projects/:pid/modules/:name     { code }
GET    /api/admin/projects/:pid/modules           → [{ name, sizeBytes, updated }]
GET    /api/admin/projects/:pid/modules/:name     → { name, code, updated }
DELETE /api/admin/projects/:pid/modules/:name
```

Function menautkan modul lewat `modules: string[]` saat POST/PATCH function.

### Aturan

| Aturan | Perilaku |
|---|---|
| **Urutan eval** | Modul dieval sesuai urutan array `modules`. Modul yang lebih dulu bisa dipakai modul berikutnya lewat `$lib` yang sudah terisi. |
| **Batas** | Maks **10** modul per function, maks **256 KB** per modul, nama `[a-z][a-z0-9_]`. |
| **Satu isolate** | Modul berjalan di sandbox yang sama dengan function — mewarisi batas memori/timeout-nya dan tanpa akses host. Modul bisa memakai `$db`/`$env`/`$http` milik function pemanggil. |
| **Validasi saat simpan** | Error sintaks modul ditolak saat `PUT`, bukan saat function dijalankan. |

---

## 🖥️ Mengelola Fungsi lewat Dashboard

Anda dapat membuat, mengedit, dan menguji fungsi secara visual melalui Admin Dashboard di `http://localhost:7701`:
1. Masuk ke project Anda, pilih menu **Functions**.
2. Klik tombol **New Function**.
3. Atur nama, kode JavaScript, timeout (default: 2000 ms), dan apakah fungsi diaktifkan (*enabled*).
4. Tambahkan **Trigger** (pilih koleksi dan aksi) atau masukkan ekspresi **Schedule** cron.
5. Gunakan panel **Run & Test** di sebelah kanan editor untuk mencoba eksekusi langsung dengan payload JSON tiruan dan melihat log `console.log` secara *real-time*!
