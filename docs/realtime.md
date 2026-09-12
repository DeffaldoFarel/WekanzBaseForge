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
* **URL:** `/api/p/:pid/realtime`
* **Headers:** `Authorization: Bearer <accessToken>` (Opsional, sertakan token jika ingin menerima event data privat).

### 2. Berlangganan Topik (Subscribe)
* **Method:** `POST`
* **URL:** `/api/p/:pid/realtime`
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

Format topik langganan:
* `<koleksi>/*` : Memantau semua perubahan (create, update, delete) pada satu koleksi.
* `<koleksi>/<id>` : Memantau hanya record spesifik tertentu.

---

## 📨 Jenis-Jenis Event

| Tipe Event | Deskripsi | Payload Data |
|---|---|---|
| **`PB_CONNECT`** | Dikirim saat koneksi pertama kali tersambung. | `{ "clientId": "cl_..." }` |
| **`PB_CREATE`** | Terjadi saat ada record baru dibuat. | Objek record lengkap yang baru dibuat. |
| **`PB_UPDATE`** | Terjadi saat ada record yang diubah. | Objek record terbaru. |
| **`PB_DELETE`** | Terjadi saat ada record yang dihapus. | `{ "id": "rec_id_yang_dihapus" }` |

---

## 💻 Contoh Implementasi Frontend (JavaScript)

Berikut contoh lengkap cara mengonsumsi realtime di aplikasi Web klien:

```javascript
const PID = 'q9tylwaruigffwr';
const BASE_URL = 'http://localhost:5100';

// 1. Buat koneksi EventSource
const sse = new EventSource(`${BASE_URL}/api/p/${PID}/realtime`);

let clientId = null;

// Tangkap event saat pertama kali terhubung
sse.addEventListener('PB_CONNECT', async (e) => {
  const data = JSON.parse(e.data);
  clientId = data.clientId;
  console.log('Terhubung ke Realtime! Client ID:', clientId);

  // 2. Daftarkan koleksi yang ingin dipantau
  await fetch(`${BASE_URL}/api/p/${PID}/realtime`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
