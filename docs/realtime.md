# 📡 Realtime Subscriptions (SSE)

BaseForge menyediakan fitur langganan data langsung (*live subscriptions*) menggunakan standar protokol **Server-Sent Events (SSE)**. 

Berbeda dengan WebSocket yang membutuhkan dependensi protokol tambahan, SSE berjalan di atas koneksi HTTP biasa, bekerja secara native di semua browser via `EventSource`, ramah proxy/firewall, dan otomatis reconnect saat koneksi terputus.

---

## ⚡ Cara Kerja

1. Klien membuka koneksi stream HTTP ke `/api/p/:pid/realtime`.
2. Server merespons dengan event awal `PB_CONNECT` yang berisi `clientId` unik.
3. Klien mengirim request `POST` untuk mendaftarkan topik koleksi yang ingin dipantau.
4. Setiap kali terjadi penambahan, pengubahan, atau penghapusan record di server, event akan langsung terdorong ke klien yang berlangganan.

> 🔒 **Keamanan Otomatis:** Server mengevaluasi `listRule` **saat mempublikasikan event**. Jika sebuah record dibuat di koleksi privat milik pengguna A, pengguna B tidak akan pernah menerima event tersebut!

---

## 🌐 Endpoint Realtime

### 1. Buka Koneksi Stream
* **Method:** `GET`
* **URL:** `/api/p/:pid/realtime?token=<jwt>` *(opsional)*
* **Headers:** `Authorization: Bearer <jwt> (opsional — token juga bisa dikirim via query param `?token=`, karena API `EventSource` browser tidak bisa mengirim header kustom).
* Token **tidak valid** → respons `401` (bukan diam-diam jatuh ke anonymous). Tanpa token, koneksi bersifat anonymous — event hanya sampai untuk koleksi dengan rule publik.
* Auth bisa juga **di-upgrade belakangan** lewat `Authorization` di request POST subscribe (lihat di bawah) — pola standar SDK.

### 2. Berlangganan Topik (Bulk Sync)
* **Method:** `POST`
* **URL:** `/api/p/:pid/realtime`
* **Headers:** `Authorization: Bearer <jwt> — jika disertakan dan valid, **auth koneksi SSE di-upgrade** ke user/token tersebut; token invalid → `401`.
* **Body:**
  ```json
  {
    "clientId": "cl_xyz123...",
    "subscriptions": [
      "posts/*",
      "chats/rec_456"
    ]
  }
  ```
* **Semantik REPLACE:** seluruh set langganan klien diganti dengan set yang dikirim — idempotent, aman dipanggil ulang setelah reconnect. Array kosong = berhenti berlangganan semua.
* Batas: maks 100 topik per request; `clientId` harus sudah connect (`404` jika belum).

Format topik langganan:
* `<koleksi>` atau `<koleksi>/*` : Memantau semua perubahan (create, update, delete) pada satu koleksi.
* `<koleksi>/<id>` : Memantau hanya record spesifik tertentu (difilter di server).

---

## 📨 Jenis-Jenis Event

| Tipe Event | Deskripsi | Payload Data |
|---|---|---|
| **`PB_CONNECT`** | Dikirim saat koneksi pertama kali tersambung. | `{ "clientId": "cl_..." }` |
| **`PB_CREATE`** | Terjadi saat ada record baru dibuat. | Objek record lengkap yang baru dibuat. |
| **`PB_UPDATE`** | Terjadi saat ada record yang diubah. | Objek record terbaru. |
| **`PB_DELETE`** | Terjadi saat ada record dihapus. | Objek record lengkap (snapshot sebelum hapus) — subscriber tetap bisa memfilter berdasarkan `userId` dsb. |

---

## 💻 Contoh Implementasi Frontend (JavaScript)

Berikut contoh lengkap cara mengonsumsi realtime di aplikasi Web klien:

```javascript
const PID = 'q9tylwaruigffwr';
const BASE_URL = 'http://localhost:5100';

// 1. Buat koneksi EventSource (token via query param — EventSource
//    tidak bisa mengirim header Authorization)
const sse = new EventSource(`${BASE_URL}/api/p/${PID}/realtime?token=${accessToken}`);

let clientId = null;

// Tangkap event saat pertama kali terhubung
sse.addEventListener('PB_CONNECT', async (e) => {
  const data = JSON.parse(e.data);
  clientId = data.clientId;
  console.log('Terhubung ke Realtime! Client ID:', clientId);

  // 2. Daftarkan koleksi yang ingin dipantau — semantik REPLACE.
  //    Sertakan Authorization di POST ini untuk meng-upgrade auth koneksi
  //    (pola SDK: token user dikirim lewat POST, bukan lewat EventSource).
  await fetch(`${BASE_URL}/api/p/${PID}/realtime`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + accessToken
    },
    body: JSON.stringify({
      clientId: clientId,
      subscriptions: ['messages/*'] // Pantau semua pesan masuk
    })
  });
});

// 3. Tangkap event pembuatan record baru
sse.addEventListener('PB_CREATE', (e) => {
  const record = JSON.parse(e.data);
  console.log('Pesan baru diterima:', record);
  // Perbarui UI Anda secara live!
});

// 4. Tangkap event update record
sse.addEventListener('PB_UPDATE', (e) => {
  const record = JSON.parse(e.data);
  console.log('Record di-update:', record);
});

// 5. Tangkap event delete record
sse.addEventListener('PB_DELETE', (e) => {
  const payload = JSON.parse(e.data);
  console.log('Record dihapus:', payload.id);
});

// Error handling
sse.onerror = (err) => {
  console.error('Koneksi realtime terputus, mencoba menyambung kembali...', err);
};
```
