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

## 🖥️ Mengelola Fungsi lewat Dashboard

Anda dapat membuat, mengedit, dan menguji fungsi secara visual melalui Admin Dashboard di `http://localhost:7701`:
1. Masuk ke project Anda, pilih menu **Functions**.
2. Klik tombol **New Function**.
3. Atur nama, kode JavaScript, timeout (default: 2000 ms), dan apakah fungsi diaktifkan (*enabled*).
4. Tambahkan **Trigger** (pilih koleksi dan aksi) atau masukkan ekspresi **Schedule** cron.
5. Gunakan panel **Run & Test** di sebelah kanan editor untuk mencoba eksekusi langsung dengan payload JSON tiruan dan melihat log `console.log` secara *real-time*!
